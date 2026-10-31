package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"fiatjaf.com/nostr"
)

func signedPublic(t *testing.T, key nostr.SecretKey, content string, tags nostr.Tags) nostr.Event {
	t.Helper()
	e := nostr.Event{CreatedAt: nostr.Timestamp(time.Now().Unix()), Kind: 9, Tags: append(nostr.Tags{{"t", "dsh-friends-lobby-v1"}, {"name", "测试搭子"}}, tags...), Content: content}
	if err := e.Sign(key); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestReceptionRepliesOnceWithoutExposingCredential(t *testing.T) {
	called := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-only" {
			t.Fatalf("authorization=%q", got)
		}
		called <- struct{}{}
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"content":"欢迎你！可以先说说正在做什么。"}}]}`))
	}))
	defer server.Close()
	t.Setenv("DSH_RECEPTION_API_KEY", "test-only")
	t.Setenv("DSH_RECEPTION_API_URL", server.URL)
	app, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app.reception.firstDelay = 5 * time.Millisecond
	source := signedPublic(t, nostr.Generate(), "大家好", nil)
	app.reception.observe(context.Background(), source)
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("assistant was not called")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		app.mu.Lock()
		rows := append([]routingRecord(nil), app.recent["general"]...)
		app.mu.Unlock()
		if len(rows) == 1 {
			if rows[0].event.Tags.FindWithValue("bot", "reception") == nil {
				t.Fatal("missing bot marker")
			}
			if rows[0].event.Tags.FindWithValue("q", source.ID.Hex()) == nil {
				t.Fatal("missing quote marker")
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("assistant reply was not broadcast into room history")
}

func TestHumanQuotedReplyCancelsReception(t *testing.T) {
	t.Setenv("DSH_RECEPTION_API_KEY", "test-only")
	app, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app.reception.firstDelay = 200 * time.Millisecond
	source := signedPublic(t, nostr.Generate(), "大家好", nil)
	app.reception.observe(context.Background(), source)
	human := signedPublic(t, nostr.Generate(), "欢迎", nostr.Tags{{"q", source.ID.Hex()}})
	app.reception.observe(context.Background(), human)
	time.Sleep(250 * time.Millisecond)
	stats := app.reception.summary()
	if stats.Cancelled != 1 || stats.Replied != 0 || stats.Pending != 0 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestPresenceCountsJoinAndLeave(t *testing.T) {
	app, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key := nostr.Generate()
	e := nostr.Event{CreatedAt: nostr.Timestamp(time.Now().Unix()), Kind: presenceKind, Tags: nostr.Tags{{"t", "dsh-friends-lobby-v1"}}, Content: `{"protocol":"dsh-friends/presence/1","action":"join","name":"新搭子"}`}
	if err = e.Sign(key); err != nil {
		t.Fatal(err)
	}
	app.presence.observe(context.Background(), e)
	if got := app.presence.counts()["general"]; got != 1 {
		t.Fatalf("count=%d", got)
	}
	leave := e
	leave.CreatedAt++
	leave.Content = `{"protocol":"dsh-friends/presence/1","action":"leave","name":"新搭子"}`
	if err = leave.Sign(key); err != nil {
		t.Fatal(err)
	}
	app.presence.observe(context.Background(), leave)
	if got := app.presence.counts()["general"]; got != 0 {
		t.Fatalf("count after leave=%d", got)
	}
}
