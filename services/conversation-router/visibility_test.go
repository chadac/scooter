package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// The same cases the agent-host's canAccess is held to (services/agent-host/test/fixtures).
func TestCanAccessFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/visibility-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Name       string  `json:"name"`
			Owner      *string `json:"owner"`
			Visibility string  `json:"visibility"`
			Caller     *string `json:"caller"`
			Allowed    bool    `json:"allowed"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range fx.Cases {
		caller := ""
		if c.Caller != nil {
			caller = *c.Caller
		}
		if got := canAccess(c.Owner, c.Visibility, caller); got != c.Allowed {
			t.Errorf("%s: canAccess = %v, want %v", c.Name, got, c.Allowed)
		}
	}
}

func TestVisibleHidesPrivateEvenUnderScopeAll(t *testing.T) {
	alice := strptr("alice")
	if visible(alice, VisibilityPrivate, "bob", "all") {
		t.Error("bob sees alice's private conversation under scope=all")
	}
	if visible(alice, VisibilityPrivate, "", "all") {
		t.Error("an anonymous caller sees a private conversation")
	}
	if !visible(alice, VisibilityPrivate, "alice", "mine") {
		t.Error("alice cannot see her own private conversation")
	}
	if !visible(alice, VisibilityShared, "bob", "all") {
		t.Error("bob cannot see a shared conversation under scope=all")
	}
}

func TestAssembleListDropsOthersPrivateRows(t *testing.T) {
	rows := []ConversationRow{
		{ID: "pub", Owner: strptr("alice"), Visibility: VisibilityShared},
		{ID: "priv", Owner: strptr("alice"), Visibility: VisibilityPrivate},
	}
	got := assembleList(rows, nil, 0, "bob", "all")
	if len(got) != 1 || got[0].ID != "pub" {
		t.Fatalf("bob's list = %+v, want only pub", got)
	}
	mine := assembleList(rows, nil, 0, "alice", "mine")
	if len(mine) != 2 || mine[1].Visibility != VisibilityPrivate {
		t.Fatalf("alice's list = %+v, want both with visibility", mine)
	}
}

func TestMetadataPatchVisibility(t *testing.T) {
	alice := strptr("alice")
	fresh := func(vis string, parent *string) *fakeMeta {
		row := rowFixture("c1", alice)
		row.Visibility = vis
		row.ParentID = parent
		return &fakeMeta{rows: map[string]*ConversationRow{"c1": row}}
	}

	t.Run("the owner makes it private", func(t *testing.T) {
		f := fresh(VisibilityShared, nil)
		w := patch(t, f, "visibility", "c1", `{"visibility":"private"}`, "alice")
		if w.Code != 200 || f.setVis == nil || *f.setVis != VisibilityPrivate {
			t.Fatalf("got %d %s, setVis=%v", w.Code, w.Body.String(), f.setVis)
		}
		if !strings.Contains(w.Body.String(), `"visibility":"private"`) {
			t.Errorf("response lacks the new visibility: %s", w.Body.String())
		}
	})
	t.Run("another user may not, even on a shared conversation", func(t *testing.T) {
		f := fresh(VisibilityShared, nil)
		if w := patch(t, f, "visibility", "c1", `{"visibility":"private"}`, "bob"); w.Code != 403 || f.writeCalled {
			t.Fatalf("got %d, writeCalled=%v", w.Code, f.writeCalled)
		}
	})
	t.Run("an anonymous caller may not", func(t *testing.T) {
		f := fresh(VisibilityShared, nil)
		if w := patch(t, f, "visibility", "c1", `{"visibility":"private"}`, ""); w.Code != 403 || f.writeCalled {
			t.Fatalf("got %d, writeCalled=%v", w.Code, f.writeCalled)
		}
	})
	t.Run("going shared needs confirm", func(t *testing.T) {
		f := fresh(VisibilityPrivate, nil)
		if w := patch(t, f, "visibility", "c1", `{"visibility":"shared"}`, "alice"); w.Code != 409 || f.writeCalled {
			t.Fatalf("got %d, writeCalled=%v", w.Code, f.writeCalled)
		}
		if w := patch(t, f, "visibility", "c1", `{"visibility":"shared","confirm":true}`, "alice"); w.Code != 200 {
			t.Fatalf("with confirm: got %d %s", w.Code, w.Body.String())
		}
	})
	t.Run("a subagent follows its parent", func(t *testing.T) {
		f := fresh(VisibilityShared, strptr("root"))
		if w := patch(t, f, "visibility", "c1", `{"visibility":"private"}`, "alice"); w.Code != 409 || f.writeCalled {
			t.Fatalf("got %d, writeCalled=%v", w.Code, f.writeCalled)
		}
	})
	t.Run("an invalid value is a 400", func(t *testing.T) {
		f := fresh(VisibilityShared, nil)
		if w := patch(t, f, "visibility", "c1", `{"visibility":"secret"}`, "alice"); w.Code != 400 {
			t.Fatalf("got %d", w.Code)
		}
	})
}

// recv returns the next frame queued for s, or "" if none arrives promptly.
func recv(s *sseSub) string {
	select {
	case b := <-s.ch:
		return string(b)
	case <-time.After(50 * time.Millisecond):
		return ""
	}
}

func TestPrivateRowFanOut(t *testing.T) {
	hub := newSSEHub()
	owner := hub.subscribe("alice", "mine")
	other := hub.subscribe("bob", "all")
	anon := hub.subscribe("", "all")

	hub.broadcast(listRow{ID: "c1", Owner: strptr("alice"), Visibility: VisibilityPrivate})
	if recv(owner) == "" {
		t.Error("the owner missed the upsert")
	}
	if f := recv(other); f != "" {
		t.Errorf("bob got a private upsert: %s", f)
	}
	if f := recv(anon); f != "" {
		t.Errorf("an anonymous subscriber got a private upsert: %s", f)
	}

	hub.broadcastRemove("c1", strptr("alice"), VisibilityPrivate)
	if recv(owner) == "" {
		t.Error("the owner missed the removal")
	}
	if f := recv(other); f != "" {
		t.Errorf("bob got a private removal: %s", f)
	}
}

func TestWentPrivateRevokesNonOwners(t *testing.T) {
	hub := newSSEHub()
	owner := hub.subscribe("alice", "all")
	other := hub.subscribe("bob", "all")
	mineOnly := hub.subscribe("carol", "mine") // never saw it, so needs no removal

	handleNotification(context.Background(),
		`{"id":"c1","op":"upsert","kind":"meta","owner":"alice","visibility":"private","went_private":true}`,
		nil, nil, hub, logger("test"), nil, nil)

	if f := recv(other); !strings.Contains(f, `"remove"`) || !strings.Contains(f, `"c1"`) {
		t.Errorf("bob did not get a removal: %q", f)
	}
	if f := recv(owner); strings.Contains(f, `"remove"`) {
		t.Errorf("the owner got a removal: %q", f)
	}
	if f := recv(mineOnly); f != "" {
		t.Errorf("carol (scope mine) got a frame: %q", f)
	}
}

func TestLiveRegistryRevokesOnlyNonOwners(t *testing.T) {
	l := newLiveRegistry()
	mk := func(caller string) (*http.Request, func()) {
		return l.track(httptest.NewRequest(http.MethodGet, "/conversations/c1/events", nil), "c1", caller)
	}
	ownerReq, releaseOwner := mk("alice")
	defer releaseOwner()
	bobReq, releaseBob := mk("bob")
	defer releaseBob()
	anonReq, releaseAnon := mk("")
	defer releaseAnon()
	otherConv, releaseOther := l.track(httptest.NewRequest(http.MethodGet, "/", nil), "c2", "bob")
	defer releaseOther()

	if n := l.revoke("c1", strptr("alice")); n != 2 {
		t.Errorf("revoked %d, want 2 (bob and anonymous)", n)
	}
	if ownerReq.Context().Err() != nil {
		t.Error("the owner's request was cancelled")
	}
	if bobReq.Context().Err() == nil || anonReq.Context().Err() == nil {
		t.Error("a non-owner request survived")
	}
	if otherConv.Context().Err() != nil {
		t.Error("a request for another conversation was cancelled")
	}
}

func TestLiveRegistryReleaseForgets(t *testing.T) {
	l := newLiveRegistry()
	_, release := l.track(httptest.NewRequest(http.MethodGet, "/", nil), "c1", "bob")
	release()
	if n := l.revoke("c1", strptr("alice")); n != 0 {
		t.Errorf("revoked %d released requests", n)
	}
	if len(l.byID) != 0 {
		t.Errorf("registry kept %d empty entries", len(l.byID))
	}
}

func TestCreateVisibility(t *testing.T) {
	run := func(body, caller string) (*httptest.ResponseRecorder, *recordingCreator) {
		c := &recordingCreator{}
		r := httptest.NewRequest(http.MethodPost, "/conversations", strings.NewReader(body))
		if caller != "" {
			r.Header.Set("x-auth-user", caller)
		}
		w := httptest.NewRecorder()
		serveConversationCreate(w, r, c, ownerFrom(r), nil)
		return w, c
	}
	if w, c := run(`{"visibility":"private"}`, "alice"); w.Code != 201 || c.got.Spec["visibility"] != VisibilityPrivate {
		t.Fatalf("private create: %d %s spec=%v", w.Code, w.Body.String(), c.got.Spec)
	}
	if w, c := run(`{}`, "alice"); w.Code != 201 || c.got.Spec["visibility"] != nil {
		t.Fatalf("default create: %d spec=%v", w.Code, c.got.Spec)
	}
	if w, _ := run(`{"visibility":"private"}`, ""); w.Code != 400 {
		t.Fatalf("anonymous private create: got %d, want 400", w.Code)
	}
	if w, _ := run(`{"visibility":"hidden"}`, "alice"); w.Code != 400 {
		t.Fatalf("invalid visibility: got %d, want 400", w.Code)
	}
}

type recordingCreator struct{ got NewConversation }

func (r *recordingCreator) Create(_ context.Context, c NewConversation) error {
	r.got = c
	return nil
}

func TestConversationRowCarriesVisibility(t *testing.T) {
	row := conversationRowOf(NewConversation{Name: "c1", Spec: map[string]interface{}{"visibility": "private"}}, 1)
	if row.Visibility == nil || *row.Visibility != VisibilityPrivate {
		t.Fatalf("Visibility = %v", row.Visibility)
	}
	if got := len(row.args()); got != 10 {
		t.Fatalf("args() has %d placeholders' worth, want 10", got)
	}
}

func TestWentPrivateClearsTheDirectProxyCache(t *testing.T) {
	d := newDirectProxy()
	d.cache["c1\x00marimo\x00label\x00h"] = directEntry{target: &directTarget{}, expires: time.Now().Add(time.Minute)}
	d.cache["c2\x00marimo\x00label\x00h"] = directEntry{target: &directTarget{}, expires: time.Now().Add(time.Minute)}
	payload := `{"id":"c1","op":"update","kind":"meta","owner":"alice","visibility":"private","went_private":true}`
	handleNotification(context.Background(), payload, nil, nil, newSSEHub(), logger("test"), nil, d.invalidate)
	if _, ok := d.cache["c1\x00marimo\x00label\x00h"]; ok {
		t.Error("c1's cached target survived the switch to private")
	}
	if _, ok := d.cache["c2\x00marimo\x00label\x00h"]; !ok {
		t.Error("an unrelated conversation's target was dropped")
	}
}
