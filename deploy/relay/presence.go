package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"fiatjaf.com/nostr"
)

const presenceKind = 20009
const presenceSnapshotKind = 20010

type presencePayload struct {
	Protocol string `json:"protocol"`
	Action   string `json:"action"`
	Name     string `json:"name"`
}
type presenceRecord struct {
	room    string
	name    string
	expires time.Time
}
type presenceHub struct {
	app    *relayApp
	mu     sync.Mutex
	people map[nostr.PubKey]presenceRecord
	secret nostr.SecretKey
}

func newPresenceHub(app *relayApp) *presenceHub {
	return &presenceHub{app: app, people: map[nostr.PubKey]presenceRecord{}, secret: nostr.Generate()}
}
func (h *presenceHub) observe(_ context.Context, event nostr.Event) {
	if event.Kind != presenceKind {
		return
	}
	room := eventRoom(event)
	if room == "" {
		return
	}
	var value presencePayload
	if json.Unmarshal([]byte(event.Content), &value) != nil || value.Protocol != "dsh-friends/presence/1" || value.Name == "" || len([]rune(value.Name)) > 20 {
		return
	}
	h.mu.Lock()
	if value.Action == "leave" {
		delete(h.people, event.PubKey)
	} else if value.Action == "join" || value.Action == "heartbeat" {
		h.people[event.PubKey] = presenceRecord{room: room, name: value.Name, expires: time.Now().Add(90 * time.Second)}
	} else {
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()
	h.broadcast()
}
func (h *presenceHub) counts() map[string]int {
	h.mu.Lock()
	defer h.mu.Unlock()
	result := map[string]int{"general": 0, "builders": 0, "random": 0}
	now := time.Now()
	for _, row := range h.people {
		if row.expires.After(now) {
			result[row.room]++
		}
	}
	return result
}
func (h *presenceHub) expire() {
	h.mu.Lock()
	changed := false
	now := time.Now()
	for key, row := range h.people {
		if !row.expires.After(now) {
			delete(h.people, key)
			changed = true
		}
	}
	h.mu.Unlock()
	if changed {
		h.broadcast()
	}
}
func (h *presenceHub) broadcast() {
	content, _ := json.Marshal(map[string]any{"protocol": "dsh-friends/presence-snapshot/1", "rooms": h.counts(), "generatedAt": time.Now().Unix()})
	event := nostr.Event{CreatedAt: nostr.Timestamp(time.Now().Unix()), Kind: presenceSnapshotKind, Tags: nostr.Tags{{"t", "dsh-friends-lobby-v1"}, {"t", "dsh-friends-builders-v1"}, {"t", "dsh-friends-random-v1"}}, Content: string(content)}
	if event.Sign(h.secret) == nil {
		h.app.relay.BroadcastEvent(event)
	}
}
