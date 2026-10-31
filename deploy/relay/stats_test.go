package main

import (
	"context"
	"encoding/hex"
	"fiatjaf.com/nostr"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStatsPersistWithoutChatOrRawIdentity(t *testing.T) {
	dir := t.TempDir()
	s, err := newStats(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := nostr.Event{Kind: 9, Content: "SYNTHETIC-CHAT-MUST-NEVER-BE-STORED", Tags: nostr.Tags{{"t", "dsh-friends-lobby-v1"}}}
	e.ID[0] = 33
	e.PubKey[0] = 99
	if err = s.record(e); err != nil {
		t.Fatal(err)
	}
	if err = s.record(e); err != nil {
		t.Fatal(err)
	}
	if s.summary().Messages != 1 || s.summary().Users != 1 {
		t.Fatal("deduplication failed")
	}
	data, _ := os.ReadFile(filepath.Join(dir, "stats.json"))
	for _, secret := range []string{e.Content, hex.EncodeToString(e.PubKey[:]), hex.EncodeToString(e.ID[:])} {
		if strings.Contains(string(data), secret) {
			t.Fatal("sensitive event field persisted")
		}
	}
	again, err := newStats(dir)
	if err != nil || again.summary().Messages != 1 || again.summary().Users != 1 {
		t.Fatal("counters did not survive restart")
	}
	if err = again.record(e); err != nil || again.summary().Messages != 1 {
		t.Fatal("retry counted again after restart")
	}
}
func TestMemoryPublicHistoryAndPrivateNonRetention(t *testing.T) {
	dir := t.TempDir()
	a, err := newApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	chat := nostr.Event{Kind: 9, CreatedAt: nostr.Timestamp(time.Now().Unix()), Content: "SYNTHETIC-CHAT-MEMORY-ONLY", Tags: nostr.Tags{{"t", "dsh-friends-lobby-v1"}}}
	chat.ID[0] = 1
	if err = a.relay.StoreEvent(ctx, chat); err != nil {
		t.Fatal(err)
	}
	found := 0
	for e := range a.relay.QueryStored(ctx, nostr.Filter{Kinds: []nostr.Kind{9}}) {
		found++
		if e.Content != chat.Content {
			t.Fatal("public history mismatch")
		}
	}
	if found != 1 {
		t.Fatal("new join cannot read recent chat")
	}
	envelope := nostr.Event{Kind: 1059, Content: "SYNTHETIC-PRIVATE-NO-CACHE"}
	if err = a.relay.StoreEvent(ctx, envelope); err != nil {
		t.Fatal(err)
	}
	for range a.relay.QueryStored(ctx, nostr.Filter{Kinds: []nostr.Kind{1059}}) {
		t.Fatal("private envelope cached")
	}
	route := nostr.Event{Kind: 10050, Tags: nostr.Tags{{"relay", "wss://relay.techflag.cn"}}}
	if err = a.relay.ReplaceEvent(ctx, route); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"stats.json", "stats.key"} {
		data, _ := os.ReadFile(filepath.Join(dir, name))
		if strings.Contains(string(data), chat.Content) || strings.Contains(string(data), envelope.Content) || strings.Contains(string(data), "wss://relay.techflag.cn") {
			t.Fatal("event body leaked to disk")
		}
	}
	again, err := newApp(dir)
	if err != nil {
		t.Fatal(err)
	}
	for range again.relay.QueryStored(ctx, nostr.Filter{Kinds: []nostr.Kind{9}}) {
		t.Fatal("chat survived restart")
	}
	if again.stats.summary().Messages != 1 {
		t.Fatal("statistics lost on restart")
	}
}
func TestMemoryCacheBoundAgeRoomIsolationAndFilterLimit(t *testing.T) {
	a, err := newApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Now().Unix()
	for i := 0; i < 123; i++ {
		e := nostr.Event{Kind: 9, CreatedAt: nostr.Timestamp(now - int64(i)), Tags: nostr.Tags{{"t", "dsh-friends-lobby-v1"}}}
		e.ID[0] = byte(i)
		if err = a.relay.StoreEvent(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	all := 0
	for range a.relay.QueryStored(ctx, nostr.Filter{Kinds: []nostr.Kind{9}}) {
		all++
	}
	if all != 100 {
		t.Fatalf("cache size = %d", all)
	}
	count := 0
	for range a.relay.QueryStored(ctx, nostr.Filter{Kinds: []nostr.Kind{9}, Limit: 50}) {
		count++
	}
	if count != 50 {
		t.Fatal("filter limit ignored")
	}
	old := nostr.Event{Kind: 9, CreatedAt: nostr.Timestamp(now - 86401), Tags: nostr.Tags{{"t", "dsh-friends-builders-v1"}}}
	old.ID[0] = 255
	if err = a.relay.StoreEvent(ctx, old); err != nil {
		t.Fatal(err)
	}
	for range a.relay.QueryStored(ctx, nostr.Filter{Kinds: []nostr.Kind{9}, Tags: nostr.TagMap{"t": []string{"dsh-friends-builders-v1"}}}) {
		t.Fatal("expired event replayed")
	}
	a.mu.Lock()
	for i := range a.recent["general"] {
		a.recent["general"][i].expires = time.Now().Add(-time.Second)
	}
	a.mu.Unlock()
	for range a.relay.QueryStored(ctx, nostr.Filter{Kinds: []nostr.Kind{9}}) {
		t.Fatal("expired cache retained")
	}
}
func TestDamagedStatsNeverSilentlyResetUsers(t *testing.T) {
	dir := t.TempDir()
	if _, err := newStats(dir); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "stats.json"), []byte("broken"), 0600)
	if _, err := newStats(dir); err == nil {
		t.Fatal("corruption reset counters")
	}
}
