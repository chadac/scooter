package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Hub fans events out to open review pages over SSE.
type Hub struct {
	mu   sync.Mutex
	subs map[chan event]string // channel -> role ("shell" or "overlay")
}

type event struct {
	name string
	data []byte
}

func newHub() *Hub { return &Hub{subs: map[chan event]string{}} }

func (h *Hub) Publish(name string, v any) {
	data, _ := json.Marshal(v)
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- event{name, data}:
		default: // a stalled page catches up from the next full state
		}
	}
}

// Count is the number of subscribers with this role.
func (h *Hub) Count(role string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, r := range h.subs {
		if r == role {
			n++
		}
	}
	return n
}

func (h *Hub) subscribe(role string) chan event {
	ch := make(chan event, 16)
	h.mu.Lock()
	h.subs[ch] = role
	h.mu.Unlock()
	return ch
}

func (h *Hub) unsubscribe(ch chan event) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

// Snaps pairs `review snap` requests with answering pages.
type Snaps struct {
	mu      sync.Mutex
	pending map[string]chan []byte
}

func newSnaps() *Snaps { return &Snaps{pending: map[string]chan []byte{}} }

func (s *Snaps) open() (string, chan []byte) {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	ch := make(chan []byte, 1)
	s.mu.Lock()
	s.pending[id] = ch
	s.mu.Unlock()
	return id, ch
}

func (s *Snaps) close(id string) {
	s.mu.Lock()
	delete(s.pending, id)
	s.mu.Unlock()
}

// fulfil hands over a capture; the first page wins.
func (s *Snaps) fulfil(id string, png []byte) bool {
	s.mu.Lock()
	ch, ok := s.pending[id]
	delete(s.pending, id)
	s.mu.Unlock()
	if ok {
		ch <- png
	}
	return ok
}

func writeJSONResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSONResponse(w, status, map[string]string{"error": msg})
}

func decode(r *http.Request, v any) error {
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 20<<20)).Decode(v)
}

// newNote is what the overlay posts when a note is saved.
type newNote struct {
	Note
	Comment string `json:"comment"`
	Shot    string `json:"shot"` // PNG data: URL
}

func (a *App) api(w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	route := r.Method + " " + parts[0]
	switch {
	case route == "GET overlay.js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(overlayJS)
	case route == "GET vendor" && len(parts) == 2 && a.site.VendorDir != "":
		w.Header().Set("Cache-Control", "max-age=86400")
		http.ServeFile(w, r, filepath.Join(a.site.VendorDir, filepath.Base(parts[1])))
	case route == "GET shots" && len(parts) == 2:
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(a.site.ShotsDir(), filepath.Base(parts[1])))
	case route == "GET notes":
		writeJSONResponse(w, http.StatusOK, a.store.Snapshot())
	case route == "GET status":
		writeJSONResponse(w, http.StatusOK, map[string]any{
			"target": a.current(), "appBase": a.site.AppBase(), "shellBase": a.site.ShellBase(),
			"pages": a.hub.Count("overlay"), "stateDir": a.site.StateDir,
		})
	case route == "GET events":
		a.events(w, r)
	case route == "POST notes" && len(parts) == 1:
		a.addNote(w, r)
	case route == "POST notes" && len(parts) == 3:
		a.noteAction(w, r, parts[1], parts[2])
	case route == "DELETE notes" && len(parts) == 2:
		id, _ := strconv.Atoi(parts[1])
		if err := a.store.Delete(id); err != nil {
			fail(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSONResponse(w, http.StatusOK, map[string]bool{"ok": true})
	case route == "POST hold":
		var body struct{ Hold bool }
		if err := decode(r, &body); err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		_ = a.store.SetHold(body.Hold)
		writeJSONResponse(w, http.StatusOK, map[string]bool{"hold": body.Hold})
	case route == "POST send":
		notes, err := a.store.Release()
		if err == nil && len(notes) > 0 {
			err = a.waker.Send(batchMessage(notes, a.site.ShotsDir(), a.current()))
		}
		if err != nil {
			fail(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSONResponse(w, http.StatusOK, map[string]int{"sent": len(notes)})
	case route == "POST snap":
		a.snap(w, r)
	case route == "POST snaps" && len(parts) == 2:
		var body struct{ Shot string }
		if err := decode(r, &body); err != nil {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		png := decodePNG(body.Shot)
		if png == nil || !a.snaps.fulfil(parts[1], png) {
			fail(w, http.StatusGone, "no such snap request")
			return
		}
		writeJSONResponse(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		fail(w, http.StatusNotFound, "no such review route")
	}
}

func (a *App) addNote(w http.ResponseWriter, r *http.Request) {
	var body newNote
	if err := decode(r, &body); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(body.Comment) == "" || (body.Kind != "point" && body.Kind != "area") {
		fail(w, http.StatusBadRequest, "a note needs a kind (point|area) and a comment")
		return
	}
	n, err := a.store.Add(body.Note, body.Comment, decodePNG(body.Shot))
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !n.Held {
		a.wake(noteMessage(n, a.site.ShotsDir(), a.current()))
	}
	writeJSONResponse(w, http.StatusCreated, n)
}

func (a *App) noteAction(w http.ResponseWriter, r *http.Request, rawID, action string) {
	id, _ := strconv.Atoi(rawID)
	var body struct {
		Text     string `json:"text"`
		By       string `json:"by"`
		Resolved bool   `json:"resolved"`
	}
	if err := decode(r, &body); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.By != "agent" {
		body.By = "user"
	}
	var n Note
	var err error
	switch action {
	case "reply":
		if strings.TrimSpace(body.Text) == "" {
			fail(w, http.StatusBadRequest, "empty reply")
			return
		}
		n, err = a.store.Reply(id, body.By, body.Text)
		if err == nil && body.By == "user" && !n.Held {
			a.wake(replyMessage(n, body.Text))
		}
	case "resolve":
		var before Note
		before, err = a.store.Get(id)
		if err == nil {
			n, err = a.store.Resolve(id, body.Resolved)
		}
		if err == nil && body.By == "user" && before.Resolved && !body.Resolved {
			a.wake(reopenMessage(n))
		}
	default:
		fail(w, http.StatusNotFound, "no such action")
		return
	}
	if errors.Is(err, errNoNote) {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSONResponse(w, http.StatusOK, n)
}

// wake is async so a slow conversation never stalls the page.
func (a *App) wake(text string) {
	go func() {
		if err := a.waker.Send(text); err != nil {
			log.Printf("wake: %v", err)
		}
	}()
}

func (a *App) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		fail(w, http.StatusInternalServerError, "no streaming")
		return
	}
	role := r.URL.Query().Get("role")
	if role != "overlay" {
		role = "shell"
	}
	ch := a.hub.subscribe(role)
	defer a.hub.unsubscribe(ch)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(name string, data []byte) bool {
		_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data)
		flusher.Flush()
		return err == nil
	}
	first, _ := json.Marshal(a.store.Snapshot())
	if !send("notes", first) {
		return
	}
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			if !send(ev.name, ev.data) {
				return
			}
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// snap asks open pages for a capture and waits for one.
func (a *App) snap(w http.ResponseWriter, r *http.Request) {
	if a.hub.Count("overlay") == 0 {
		fail(w, http.StatusConflict, "no review page is open")
		return
	}
	timeout := 20 * time.Second
	if s, err := strconv.Atoi(r.URL.Query().Get("timeout")); err == nil && s > 0 {
		timeout = time.Duration(s) * time.Second
	}
	id, ch := a.snaps.open()
	defer a.snaps.close(id)
	a.hub.Publish("snap", map[string]string{"id": id})
	select {
	case png := <-ch:
		path, err := a.store.SaveSnap(png)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSONResponse(w, http.StatusOK, map[string]string{"path": path})
	case <-time.After(timeout):
		fail(w, http.StatusGatewayTimeout, "no page answered")
	case <-r.Context().Done():
	}
}
