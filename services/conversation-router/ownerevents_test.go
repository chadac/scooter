package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeNotifier struct {
	payloads []string
	err      error
}

func (f *fakeNotifier) NotifyFolders(_ context.Context, payload []byte) error {
	f.payloads = append(f.payloads, string(payload))
	return f.err
}

func TestOwnerEventRoute(t *testing.T) {
	for _, c := range []struct {
		method, path string
		ok           bool
	}{
		{"POST", "/conversations/events", true},
		{"GET", "/conversations/events", false},
		{"POST", "/conversations/c1/events", false},
	} {
		if got := IsOwnerEventPost(c.method, c.path); got != c.ok {
			t.Errorf("%s %s: got %v", c.method, c.path, got)
		}
	}
}

func TestServeOwnerEvent(t *testing.T) {
	notes := FolderService(func(context.Context, *http.Request) (string, bool) { return "alice", true })
	post := func(n ownerNotifier, body string, services FolderService) *httptest.ResponseRecorder {
		r := folderReq("POST", "/conversations/events", body, "mallory")
		r.Header.Set("Authorization", "Bearer t")
		w := httptest.NewRecorder()
		serveOwnerEvent(w, r, n, services)
		return w
	}
	t.Run("a folder service's event notifies the user it names", func(t *testing.T) {
		n := &fakeNotifier{}
		w := post(n, `{"contrib":"notes","conversations":["c1","c2"]}`, notes)
		if w.Code != http.StatusAccepted || len(n.payloads) != 1 {
			t.Fatalf("got %d, %v", w.Code, n.payloads)
		}
		owner, frame, ok := folderNotify(n.payloads[0])
		if !ok || owner != "alice" || string(frame) != `{"kind":"contrib","contrib":"notes","conversations":["c1","c2"]}` {
			t.Errorf("owner %q, frame %s", owner, frame)
		}
	})
	t.Run("a user is refused", func(t *testing.T) {
		n := &fakeNotifier{}
		if w := post(n, `{"contrib":"notes"}`, nil); w.Code != http.StatusForbidden || len(n.payloads) != 0 {
			t.Fatalf("got %d, %v", w.Code, n.payloads)
		}
	})
	for name, body := range map[string]string{
		"a bad contrib name":    `{"contrib":"Kan/ban"}`,
		"a bad conversation id": `{"contrib":"notes","conversations":["a b"]}`,
		"too many ids":          `{"contrib":"notes","conversations":["` + strings.Repeat(`c","`, maxEventConversations) + `c"]}`,
		"a broken body":         `{`,
	} {
		t.Run(name+" is a 400", func(t *testing.T) {
			if w := post(&fakeNotifier{}, body, notes); w.Code != http.StatusBadRequest {
				t.Fatalf("got %d", w.Code)
			}
		})
	}
	t.Run("a failed notify is a 502", func(t *testing.T) {
		if w := post(&fakeNotifier{err: errors.New("down")}, `{"contrib":"notes"}`, notes); w.Code != http.StatusBadGateway {
			t.Fatalf("got %d", w.Code)
		}
	})
}

func TestFolderNotifyFrames(t *testing.T) {
	if owner, frame, ok := folderNotify(`{"owner":"alice"}`); !ok || owner != "alice" || string(frame) != `{"kind":"folders"}` {
		t.Errorf("folder change: %q %s %v", owner, frame, ok)
	}
	if _, frame, ok := folderNotify(`{"owner":"","contrib":"notes"}`); !ok || string(frame) != `{"kind":"contrib","contrib":"notes","conversations":[]}` {
		t.Errorf("contrib event: %s %v", frame, ok)
	}
	if _, _, ok := folderNotify(`{}`); ok {
		t.Error("a payload with no owner is dropped")
	}
}
