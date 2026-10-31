package main

import (
	"context"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"iter"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"fiatjaf.com/nostr"
	"fiatjaf.com/nostr/khatru"
)

//go:embed dashboard/*
var dashboard embed.FS
var roomTags = map[string]string{"dsh-friends-lobby-v1": "general", "dsh-friends-builders-v1": "builders", "dsh-friends-random-v1": "random"}

func eventRoom(e nostr.Event) string {
	result := ""
	for _, tag := range e.Tags {
		if len(tag) > 1 && tag[0] == "t" {
			if room, ok := roomTags[tag[1]]; ok {
				if result != "" {
					return ""
				}
				result = room
			}
		}
	}
	return result
}

type routingRecord struct {
	event   nostr.Event
	expires time.Time
}
type relayApp struct {
	relay   *khatru.Relay
	stats   *stats
	mu      sync.Mutex
	routing map[string]routingRecord
	recent  map[string][]routingRecord
	rateAt  time.Time
	tokens  float64
	boot    time.Time
}

func (a *relayApp) rememberPublic(e nostr.Event) {
	room := eventRoom(e)
	if room == "" {
		return
	}
	now := time.Now()
	expires := time.Unix(int64(e.CreatedAt), 0).Add(24 * time.Hour)
	if expires.After(now.Add(24 * time.Hour)) {
		expires = now.Add(24 * time.Hour)
	}
	if !expires.After(now) {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	entries := a.recent[room]
	valid := make([]routingRecord, 0, len(entries)+1)
	for _, record := range entries {
		if record.expires.After(now) {
			if record.event.ID == e.ID {
				return
			}
			valid = append(valid, record)
		}
	}
	valid = append(valid, routingRecord{event: e, expires: expires})
	sort.Slice(valid, func(i, j int) bool {
		if valid[i].event.CreatedAt != valid[j].event.CreatedAt {
			return valid[i].event.CreatedAt > valid[j].event.CreatedAt
		}
		return hex.EncodeToString(valid[i].event.ID[:]) < hex.EncodeToString(valid[j].event.ID[:])
	})
	if len(valid) > 100 {
		clear(valid[100:])
		valid = valid[:100:100]
	}
	a.recent[room] = valid
}
func newApp(directory string) (*relayApp, error) {
	st, err := newStats(directory)
	if err != nil {
		return nil, err
	}
	a := &relayApp{stats: st, routing: map[string]routingRecord{}, recent: map[string][]routingRecord{}, tokens: 40, rateAt: time.Now(), boot: time.Now()}
	rl := khatru.NewRelay()
	a.relay = rl
	rl.Info.Name = "DSH 搭子中继"
	rl.Info.Description = "Public rooms cache only the most recent 100 events per room for up to 24 hours in memory, cleared on restart. Chat is never persisted to disk. Private envelopes are forwarded only. Aggregate operational statistics persist."
	rl.Log = log.New(io.Discard, "", 0)
	rl.MaxMessageSize = 65536
	rl.OnEvent = func(ctx context.Context, e nostr.Event) (bool, string) {
		switch e.Kind {
		case 9, 1059, 10050, 30388:
		default:
			return true, "blocked: only DSH Friends events are accepted"
		}
		if len(e.Content) > 16000 {
			return true, "blocked: content too large"
		}
		if int64(e.CreatedAt) > time.Now().Unix()+1800 {
			return true, "invalid: future timestamp"
		}
		if e.Kind == 9 && eventRoom(e) == "" {
			return true, "blocked: unknown room"
		}
		if e.Kind == 30388 {
			found := false
			for _, tag := range e.Tags {
				if len(tag) > 1 && tag[0] == "d" && tag[1] == "dsh-friends/profile/v1" {
					found = true
				}
			}
			if !found {
				return true, "blocked: unknown profile"
			}
		}
		a.mu.Lock()
		now := time.Now()
		a.tokens += now.Sub(a.rateAt).Seconds() * 20
		if a.tokens > 40 {
			a.tokens = 40
		}
		a.rateAt = now
		if a.tokens < 1 {
			a.mu.Unlock()
			return true, "rate-limited: retry later"
		}
		a.tokens--
		a.mu.Unlock()
		return false, ""
	}
	accept := func(ctx context.Context, e nostr.Event) error {
		if err := st.record(e); err != nil {
			return io.ErrShortWrite
		}
		// Public room history is bounded and memory-only; private envelopes are never cached.
		if e.Kind == 9 {
			a.rememberPublic(e)
			return nil
		}
		if e.Kind == 10050 || e.Kind == 30388 {
			a.mu.Lock()
			defer a.mu.Unlock()
			now := time.Now()
			for key, record := range a.routing {
				if record.expires.Before(now) {
					delete(a.routing, key)
				}
			}
			key := hex.EncodeToString(e.PubKey[:]) + ":"
			if e.Kind == 10050 {
				key += "inbox"
			} else {
				key += "profile"
			}
			if old, ok := a.routing[key]; ok && old.event.CreatedAt >= e.CreatedAt {
				return nil
			}
			if len(a.routing) >= 3000 {
				for k := range a.routing {
					delete(a.routing, k)
					break
				}
			}
			a.routing[key] = routingRecord{event: e, expires: now.Add(15 * time.Minute)}
		}
		return nil
	}
	rl.StoreEvent = accept
	rl.ReplaceEvent = accept
	rl.QueryStored = func(ctx context.Context, filter nostr.Filter) iter.Seq[nostr.Event] {
		return func(yield func(nostr.Event) bool) {
			records := []nostr.Event{}
			a.mu.Lock()
			now := time.Now()
			for key, record := range a.routing {
				if record.expires.Before(now) {
					delete(a.routing, key)
					continue
				}
				if filter.Matches(record.event) {
					records = append(records, record.event)
				}
			}
			for room, entries := range a.recent {
				valid := entries[:0]
				for _, record := range entries {
					if record.expires.After(now) {
						valid = append(valid, record)
						if filter.Matches(record.event) {
							records = append(records, record.event)
						}
					}
				}
				clear(entries[len(valid):])
				a.recent[room] = valid
			}
			a.mu.Unlock()
			sort.Slice(records, func(i, j int) bool {
				if records[i].CreatedAt != records[j].CreatedAt {
					return records[i].CreatedAt > records[j].CreatedAt
				}
				return hex.EncodeToString(records[i].ID[:]) < hex.EncodeToString(records[j].ID[:])
			})
			if filter.LimitZero {
				return
			}
			if filter.Limit > 0 && len(records) > filter.Limit {
				records = records[:filter.Limit]
			}
			for _, e := range records {
				if !yield(e) {
					return
				}
			}
		}
	}
	rl.Count = func(ctx context.Context, filter nostr.Filter) (uint32, error) {
		filter.Limit = 0
		filter.LimitZero = false
		var count uint32
		for range rl.QueryStored(ctx, filter) {
			count++
		}
		return count, nil
	}
	rl.OnRequest = func(ctx context.Context, filter nostr.Filter) (bool, string) {
		if len(filter.Kinds) == 0 || len(filter.IDs) > 100 || len(filter.Authors) > 100 || len(filter.Kinds) > 10 || filter.Limit > 1000 {
			return true, "restricted: filter too broad"
		}
		for _, kind := range filter.Kinds {
			if kind == 1059 {
				key, ok := khatru.GetAuthed(ctx)
				if !ok {
					return true, "auth-required: authenticate to receive private envelopes"
				}
				recipients := filter.Tags["p"]
				if len(recipients) != 1 || recipients[0] != hex.EncodeToString(key[:]) {
					return true, "restricted: own inbox only"
				}
			}
		}
		return false, ""
	}
	rl.OnAuth = func(ctx context.Context, key nostr.PubKey) { _ = st.recordUser(key) }
	return a, nil
}
func (a *relayApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.Method != "GET" && r.Method != "HEAD" {
		http.Error(w, "read-only endpoint", http.StatusMethodNotAllowed)
		return
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || strings.Contains(r.Header.Get("Accept"), "application/nostr+json") {
		a.relay.WithServiceURL("wss://relay.techflag.cn").ServeHTTP(w, r)
		return
	}
	switch r.URL.Path {
	case "/api/stats":
		clients, _ := a.relay.Stats()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(struct {
			publicSummary
			Status               string `json:"status"`
			OnlineConnections    int    `json:"onlineConnections"`
			UptimeSeconds        int64  `json:"uptimeSeconds"`
			ChatHistoryPersisted bool   `json:"chatHistoryPersisted"`
			PublicHistoryCache   any    `json:"publicHistoryCache"`
		}{a.stats.summary(), "operational", clients, int64(time.Since(a.boot).Seconds()), false, map[string]any{"storage": "memory", "maxPerRoom": 100, "maxAgeSeconds": 86400, "clearedOnRestart": true}})
	case "/healthz":
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok\n")
	default:
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		if r.URL.Path != "/" && r.URL.Path != "/dashboard.css" && r.URL.Path != "/dashboard.js" {
			http.NotFound(w, r)
			return
		}
		files, _ := fs.Sub(dashboard, "dashboard")
		http.FileServer(http.FS(files)).ServeHTTP(w, r)
	}
}
func main() {
	directory := os.Getenv("DSH_RELAY_STATE")
	if directory == "" {
		directory = "/opt/dsh-friends-relay/state"
	}
	a, err := newApp(directory)
	if err != nil {
		log.Fatal("Cannot initialize operational statistics; existing data was not replaced.")
	}
	address := os.Getenv("DSH_RELAY_LISTEN")
	if address == "" {
		address = "127.0.0.1:17777"
	}
	server := &http.Server{Addr: address, Handler: a, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 70 * time.Second, MaxHeaderBytes: 16384, ErrorLog: log.New(io.Discard, "", 0)}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		a.relay.DisconnectAll()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			a.mu.Lock()
			now := time.Now()
			for key, record := range a.routing {
				if record.expires.Before(now) {
					delete(a.routing, key)
				}
			}
			for room, entries := range a.recent {
				valid := make([]routingRecord, 0, len(entries))
				for _, record := range entries {
					if record.expires.After(now) {
						valid = append(valid, record)
					}
				}
				a.recent[room] = valid
			}
			a.mu.Unlock()
		}
	}()
	log.Print("DSH Friends real-time relay started; operational statistics only, public history in bounded memory only; no chat disk storage.")
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("Relay listener stopped unexpectedly.")
	}
}
