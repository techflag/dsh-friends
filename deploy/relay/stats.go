package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	_ "time/tzdata"

	"fiatjaf.com/nostr"
)

type day struct {
	Messages uint64            `json:"messages"`
	Users    map[string]bool   `json:"users"`
	Rooms    map[string]uint64 `json:"rooms"`
}
type storedStats struct {
	Version   int               `json:"version"`
	StartedAt int64             `json:"startedAt"`
	Users     map[string]int64  `json:"users"`
	Messages  uint64            `json:"messages"`
	Rooms     map[string]uint64 `json:"rooms"`
	Days      map[string]*day   `json:"days"`
	Seen      map[string]int64  `json:"seen"`
}
type stats struct {
	mu        sync.Mutex
	data      storedStats
	key       []byte
	directory string
	zone      *time.Location
}
type dailySummary struct {
	Date     string `json:"date"`
	Messages uint64 `json:"messages"`
	Users    int    `json:"users"`
}
type publicSummary struct {
	UpdatedAt     int64             `json:"updatedAt"`
	Since         int64             `json:"since"`
	Users         int               `json:"users"`
	ActiveToday   int               `json:"activeToday"`
	Messages      uint64            `json:"messages"`
	MessagesToday uint64            `json:"messagesToday"`
	Rooms         map[string]uint64 `json:"rooms"`
	Daily         []dailySummary    `json:"daily"`
}

func newStats(directory string) (*stats, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	zone, _ := time.LoadLocation("Asia/Shanghai")
	if zone == nil {
		zone = time.FixedZone("CST", 8*3600)
	}
	s := &stats{directory: directory, zone: zone}
	state, err := os.ReadFile(filepath.Join(directory, "stats.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	exists := err == nil
	s.key, err = os.ReadFile(filepath.Join(directory, "stats.key"))
	if errors.Is(err, os.ErrNotExist) && !exists {
		s.key = make([]byte, 32)
		if _, err = rand.Read(s.key); err != nil {
			return nil, err
		}
		if err = os.WriteFile(filepath.Join(directory, "stats.key"), s.key, 0600); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if len(s.key) != 32 {
		return nil, errors.New("invalid statistics key")
	}
	if exists {
		if err = json.Unmarshal(state, &s.data); err != nil || s.data.Version != 1 || s.data.Users == nil || s.data.Days == nil || s.data.Seen == nil || s.data.Rooms == nil {
			return nil, errors.New("invalid statistics state")
		}
	} else {
		s.data = storedStats{Version: 1, StartedAt: time.Now().Unix(), Users: map[string]int64{}, Days: map[string]*day{}, Seen: map[string]int64{}, Rooms: map[string]uint64{}}
		if err = s.persist(); err != nil {
			return nil, err
		}
	}
	return s, nil
}
func (s *stats) digest(prefix string, data []byte) string {
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte(prefix))
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
func (s *stats) persist() error {
	encoded, err := json.Marshal(s.data)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.directory, "stats.new"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(encoded); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(filepath.Join(s.directory, "stats.new"), filepath.Join(s.directory, "stats.json"))
}
func (s *stats) touch(key nostr.PubKey, now time.Time) {
	id := s.digest("user:", key[:])
	s.data.Users[id] = now.Unix()
	date := now.In(s.zone).Format("2006-01-02")
	d := s.data.Days[date]
	if d == nil {
		d = &day{Users: map[string]bool{}, Rooms: map[string]uint64{}}
		s.data.Days[date] = d
	}
	d.Users[id] = true
}
func (s *stats) recordUser(key nostr.PubKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	before, _ := json.Marshal(s.data)
	s.touch(key, time.Now())
	if err := s.persist(); err != nil {
		json.Unmarshal(before, &s.data)
		return err
	}
	return nil
}
func (s *stats) record(e nostr.Event) error {
	if e.Kind != 9 && e.Kind != 10050 && e.Kind != 30388 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.digest("event:", e.ID[:])
	if _, seen := s.data.Seen[id]; seen {
		return nil
	}
	before, _ := json.Marshal(s.data)
	now := time.Now()
	s.touch(e.PubKey, now)
	s.data.Seen[id] = now.Unix()
	if e.Kind == 9 {
		room := eventRoom(e)
		s.data.Messages++
		s.data.Rooms[room]++
		d := s.data.Days[now.In(s.zone).Format("2006-01-02")]
		d.Messages++
		d.Rooms[room]++
	}
	if len(s.data.Seen) > 10000 {
		var oldest string
		var at int64 = 1<<63 - 1
		for key, t := range s.data.Seen {
			if t < at {
				oldest = key
				at = t
			}
		}
		delete(s.data.Seen, oldest)
	}
	cutoff := now.In(s.zone).AddDate(0, 0, -400).Format("2006-01-02")
	for date := range s.data.Days {
		if date < cutoff {
			delete(s.data.Days, date)
		}
	}
	if err := s.persist(); err != nil {
		json.Unmarshal(before, &s.data)
		return err
	}
	return nil
}
func (s *stats) summary() publicSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	today := s.data.Days[now.In(s.zone).Format("2006-01-02")]
	out := publicSummary{UpdatedAt: now.Unix(), Since: s.data.StartedAt, Users: len(s.data.Users), Messages: s.data.Messages, Rooms: map[string]uint64{}, Daily: []dailySummary{}}
	if today != nil {
		out.ActiveToday = len(today.Users)
		out.MessagesToday = today.Messages
	}
	for room, count := range s.data.Rooms {
		out.Rooms[room] = count
	}
	for i := 6; i >= 0; i-- {
		date := now.In(s.zone).AddDate(0, 0, -i).Format("2006-01-02")
		row := dailySummary{Date: date}
		if d := s.data.Days[date]; d != nil {
			row.Messages = d.Messages
			row.Users = len(d.Users)
		}
		out.Daily = append(out.Daily, row)
	}
	sort.Slice(out.Daily, func(i, j int) bool { return out.Daily[i].Date < out.Daily[j].Date })
	return out
}
