package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Ref is an element as the overlay saw it.
type Ref struct {
	Selector string `json:"selector"`
	Text     string `json:"text,omitempty"`
}

// Box is a rectangle in CSS pixels.
type Box struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type Viewport struct {
	W       int     `json:"w"`
	H       int     `json:"h"`
	ScrollX float64 `json:"scrollX"`
	ScrollY float64 `json:"scrollY"`
	DPR     float64 `json:"dpr"`
	Scheme  string  `json:"scheme"`
}

type Msg struct {
	By   string    `json:"by"` // "user" or "agent"
	Text string    `json:"text"`
	At   time.Time `json:"at"`
}

// Note is a review comment on an element or an area.
type Note struct {
	// ID addresses the note; Num is just its display label.
	ID    string `json:"id"`
	Num   int    `json:"num"`
	Kind  string `json:"kind"`
	Route string `json:"route"`
	Title string `json:"title,omitempty"`
	// The element clicked, or the smallest element containing the area.
	Anchor Ref    `json:"anchor"`
	HTML   string `json:"html,omitempty"`
	// Point: click offset in anchor; area: rectangle relative to anchor.
	Rel      Box      `json:"rel"`
	Doc      Box      `json:"doc"` // in document coordinates, for headless crops
	Overlaps []Ref    `json:"overlaps,omitempty"`
	Viewport Viewport `json:"viewport"`
	Thread   []Msg    `json:"thread"`
	Shot     string   `json:"shot,omitempty"`
	// Why the shot may be incomplete (cross-origin images, WebGL, …).
	ShotWarning string    `json:"shotWarning,omitempty"`
	Resolved    bool      `json:"resolved,omitempty"`
	Created     time.Time `json:"created"`
	// The note is unread while the agent's last change is newer than ReadAt.
	AgentAt *time.Time `json:"agentAt,omitempty"`
	ReadAt  *time.Time `json:"readAt,omitempty"`
}

type State struct {
	NextNum int    `json:"nextNum"`
	Notes   []Note `json:"notes"`
}

// Store is notes.json plus its screenshots, on the workspace PVC.
type Store struct {
	mu       sync.Mutex
	dir      string
	state    State
	onChange func(State)
	now      func() time.Time
}

// maxShotBytes caps the shots directory; snaps go first, then resolved notes'.
const maxShotBytes = 50 << 20

var errNoNote = errors.New("no such note")

func openStore(dir string) (*Store, error) {
	s := &Store{dir: dir, state: State{NextNum: 1}, now: time.Now}
	raw, err := os.ReadFile(s.path())
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(raw, &s.state); err != nil {
			return nil, err
		}
	}
	if s.state.NextNum < 1 {
		s.state.NextNum = 1
	}
	return s, nil
}

func (s *Store) path() string { return filepath.Join(s.dir, "notes.json") }

// Snapshot is a deep enough copy to hand to another goroutine.
func (s *Store) Snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.copyLocked()
}

func (s *Store) copyLocked() State {
	st := s.state
	st.Notes = make([]Note, len(s.state.Notes))
	for i, n := range s.state.Notes {
		n.Thread = append([]Msg(nil), n.Thread...)
		n.Overlaps = append([]Ref(nil), n.Overlaps...)
		st.Notes[i] = n
	}
	return st
}

// mutate applies f under the lock, saves and announces.
func (s *Store) mutate(f func(*State) error) error {
	s.mu.Lock()
	if err := f(&s.state); err != nil {
		s.mu.Unlock()
		return err
	}
	err := writeJSON(s.path(), s.state)
	st := s.copyLocked()
	s.mu.Unlock()
	if err == nil && s.onChange != nil {
		s.onChange(st)
	}
	return err
}

// Add stores a note.
func (s *Store) Add(n Note, comment string, shot []byte) (Note, error) {
	err := s.mutate(func(st *State) error {
		n.ID = newID()
		n.Num = st.NextNum
		st.NextNum++
		n.Created = s.now().UTC()
		n.Resolved = false
		n.Thread = []Msg{{By: "user", Text: comment, At: n.Created}}
		n.Shot = ""
		if len(shot) > 0 {
			name := n.ID + ".png"
			if err := s.writeShot(name, shot); err == nil {
				n.Shot = name
			}
		}
		st.Notes = append(st.Notes, n)
		return nil
	})
	return n, err
}

// newID is a random v4 UUID.
func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// find matches full IDs; a bare label is refused as ambiguous.
func find(st *State, id string) (*Note, error) {
	for i := range st.Notes {
		if st.Notes[i].ID == id {
			return &st.Notes[i], nil
		}
	}
	label := strings.TrimPrefix(id, "#")
	for _, n := range st.Notes {
		if strconv.Itoa(n.Num) == label {
			return nil, fmt.Errorf("%w: notes are addressed by id; #%d is %s", errNoNote, n.Num, n.ID)
		}
	}
	return nil, fmt.Errorf("%w %q", errNoNote, id)
}

func (s *Store) Get(id string) (Note, error) {
	st := s.Snapshot()
	n, err := find(&st, id)
	if err != nil {
		return Note{}, err
	}
	return *n, nil
}

func (s *Store) Reply(id string, by, text string) (Note, error) {
	var out Note
	err := s.mutate(func(st *State) error {
		n, err := find(st, id)
		if err != nil {
			return err
		}
		now := s.now().UTC()
		n.Thread = append(n.Thread, Msg{By: by, Text: text, At: now})
		if by == "agent" {
			n.AgentAt = &now
		}
		// A user's reply reopens the thread.
		if by == "user" {
			n.Resolved = false
		}
		out = *n
		return nil
	})
	return out, err
}

func (s *Store) Resolve(id string, by string, resolved bool) (Note, error) {
	var out Note
	err := s.mutate(func(st *State) error {
		n, err := find(st, id)
		if err != nil {
			return err
		}
		n.Resolved = resolved
		if by == "agent" {
			now := s.now().UTC()
			n.AgentAt = &now
		}
		out = *n
		return nil
	})
	return out, err
}

// MarkRead records that the user has seen the note's thread.
func (s *Store) MarkRead(id string) (Note, error) {
	var out Note
	err := s.mutate(func(st *State) error {
		n, err := find(st, id)
		if err != nil {
			return err
		}
		now := s.now().UTC()
		n.ReadAt = &now
		out = *n
		return nil
	})
	return out, err
}

func (s *Store) Delete(id string) error {
	return s.mutate(func(st *State) error {
		n, err := find(st, id)
		if err != nil {
			return err
		}
		if n.Shot != "" {
			_ = os.Remove(filepath.Join(s.dir, "shots", n.Shot))
		}
		i := slices.IndexFunc(st.Notes, func(x Note) bool { return x.ID == id })
		st.Notes = slices.Delete(st.Notes, i, i+1)
		return nil
	})
}

// SaveSnap stores a live-page capture and returns its path.
func (s *Store) SaveSnap(png []byte) (string, error) {
	name := "snap-" + s.now().UTC().Format("20060102T150405.000") + ".png"
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writeShot(name, png); err != nil {
		return "", err
	}
	return filepath.Join(s.dir, "shots", name), nil
}

// writeShot must run under s.mu.
func (s *Store) writeShot(name string, png []byte) error {
	dir := filepath.Join(s.dir, "shots")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, name), png, 0o644); err != nil {
		return err
	}
	s.pruneLocked(dir, name)
	return nil
}

func (s *Store) pruneLocked(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type f struct {
		name string
		size int64
		rank int // lower goes first
		mod  time.Time
	}
	resolved := map[string]bool{}
	for _, n := range s.state.Notes {
		if n.Resolved && n.Shot != "" {
			resolved[n.Shot] = true
		}
	}
	var files []f
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || info.IsDir() {
			continue
		}
		total += info.Size()
		if e.Name() == keep {
			continue
		}
		rank := 2
		if strings.HasPrefix(e.Name(), "snap-") {
			rank = 0
		} else if resolved[e.Name()] {
			rank = 1
		}
		files = append(files, f{e.Name(), info.Size(), rank, info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].rank != files[j].rank {
			return files[i].rank < files[j].rank
		}
		return files[i].mod.Before(files[j].mod)
	})
	for _, file := range files {
		if total <= maxShotBytes || file.rank == 2 {
			break
		}
		if os.Remove(filepath.Join(dir, file.name)) == nil {
			total -= file.size
		}
	}
}

// decodePNG accepts a data: URL or bare base64.
func decodePNG(s string) []byte {
	if s == "" {
		return nil
	}
	if i := strings.Index(s, ","); strings.HasPrefix(s, "data:") && i > 0 {
		s = s[i+1:]
	}
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) < 8 || string(raw[1:4]) != "PNG" {
		return nil
	}
	return raw
}
