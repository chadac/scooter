package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

type fakeOwned struct {
	fakeParents
	listErr error
}

func (f *fakeOwned) Conversations(context.Context) ([]ConversationRow, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := []ConversationRow{}
	for _, r := range f.rows {
		out = append(out, *r)
	}
	return out, nil
}

type gotGet struct {
	path, owner string
	query       url.Values
}

func ownedRows() *fakeOwned {
	row := func(id, owner, visibility string) *ConversationRow {
		return &ConversationRow{ID: id, ThreadID: id, Title: id, Owner: str(owner), Visibility: visibility}
	}
	rows := map[string]*ConversationRow{
		"src":         row("src", "alice", VisibilityPrivate),
		"alice-priv":  row("alice-priv", "alice", VisibilityPrivate),
		"alice-share": row("alice-share", "alice", VisibilityShared),
		"bob-priv":    row("bob-priv", "bob", VisibilityPrivate),
		"bob-share":   row("bob-share", "bob", VisibilityShared),
		"shared-src":  row("shared-src", "alice", VisibilityShared),
		"unowned":     {ID: "unowned", ThreadID: "unowned", Title: "unowned"},
	}
	return &fakeOwned{fakeParents: fakeParents{rows: rows}}
}

func ownedGet(t *testing.T, rows ownedListing, reader TrustedCaller, path string) (*httptest.ResponseRecorder, []gotGet) {
	t.Helper()
	var calls []gotGet
	get := func(_ context.Context, p string, q url.Values, owner string) (int, string, string) {
		calls = append(calls, gotGet{p, owner, q})
		return http.StatusOK, "application/json", `{"messages":[]}`
	}
	r := httptest.NewRequest(http.MethodGet, path, nil)
	src, target, ok := OwnedRead(r.Method, r.URL.Path)
	if !ok {
		t.Fatalf("%s did not match", path)
	}
	w := httptest.NewRecorder()
	serveOwnedRead(w, r, rows, src, target, reader, get)
	return w, calls
}

func TestOwnedReadRoute(t *testing.T) {
	if s, tg, ok := OwnedRead(http.MethodGet, "/conversations/a/owned"); !ok || s != "a" || tg != "" {
		t.Errorf("list: %q %q %v", s, tg, ok)
	}
	if s, tg, ok := OwnedRead(http.MethodGet, "/conversations/a/owned/b/messages"); !ok || s != "a" || tg != "b" {
		t.Errorf("messages: %q %q %v", s, tg, ok)
	}
	for _, p := range []string{"/conversations//owned", "/conversations/a/owned/b", "/conversations/a/owned/b/events", "/conversations/a/owned/b/messages/x"} {
		if _, _, ok := OwnedRead(http.MethodGet, p); ok {
			t.Errorf("%s must not match", p)
		}
	}
	if _, _, ok := OwnedRead(http.MethodPost, "/conversations/a/owned"); ok {
		t.Error("POST must not match")
	}
}

func TestOwnedListIsTheSourceOwnersConversations(t *testing.T) {
	w, _ := ownedGet(t, ownedRows(), allowAll, "/conversations/src/owned")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var rows []listRow
	_ = json.Unmarshal(w.Body.Bytes(), &rows)
	got := map[string]bool{}
	for _, r := range rows {
		got[r.ID] = true
	}
	want := map[string]bool{"src": true, "alice-priv": true, "alice-share": true, "shared-src": true}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for id := range want {
		if !got[id] {
			t.Errorf("missing %s in %v", id, got)
		}
	}
}

func TestOwnedListOfAnUnownedOrSharedSourceIsEmpty(t *testing.T) {
	for _, src := range []string{"unowned", "shared-src"} {
		w, _ := ownedGet(t, ownedRows(), allowAll, "/conversations/"+src+"/owned")
		if w.Code != http.StatusOK || w.Body.String() != "[]\n" {
			t.Errorf("%s: want an empty list, got %d %s", src, w.Code, w.Body)
		}
	}
}

func TestOwnedMessagesStampTheOwnerAndKeepOnlyPaging(t *testing.T) {
	w, calls := ownedGet(t, ownedRows(), allowAll, "/conversations/src/owned/alice-priv/messages?before=90&limit=20&scope=all")
	if w.Code != http.StatusOK || len(calls) != 1 {
		t.Fatalf("status %d, calls %v", w.Code, calls)
	}
	c := calls[0]
	if c.path != "/conversations/alice-priv/messages" || c.owner != "alice" {
		t.Errorf("wrong internal read: %+v", c)
	}
	if c.query.Get("before") != "90" || c.query.Get("limit") != "20" || c.query.Has("scope") {
		t.Errorf("query not narrowed: %v", c.query)
	}
}

func TestOwnedMessagesRefuseOtherOwners(t *testing.T) {
	for _, target := range []string{"bob-priv", "bob-share", "unowned", "missing"} {
		w, calls := ownedGet(t, ownedRows(), allowAll, "/conversations/src/owned/"+target+"/messages")
		if w.Code != http.StatusNotFound || len(calls) != 0 {
			t.Errorf("%s: want 404 and no read, got %d %v", target, w.Code, calls)
		}
	}
	// An unowned source owns nothing, not even other unowned rows.
	w, calls := ownedGet(t, ownedRows(), allowAll, "/conversations/unowned/owned/unowned/messages")
	if w.Code != http.StatusNotFound || len(calls) != 0 {
		t.Errorf("unowned source: want 404, got %d", w.Code)
	}
	// Other users may drive a shared source, so it reads none of the owner's.
	w, calls = ownedGet(t, ownedRows(), allowAll, "/conversations/shared-src/owned/alice-priv/messages")
	if w.Code != http.StatusNotFound || len(calls) != 0 {
		t.Errorf("shared source: want 404, got %d", w.Code)
	}
}

func TestOwnedReadRefusesUnverifiedCallersAlike(t *testing.T) {
	for _, reader := range []TrustedCaller{nil, denyAll} {
		for _, p := range []string{"/conversations/src/owned", "/conversations/src/owned/alice-priv/messages", "/conversations/missing/owned"} {
			w, calls := ownedGet(t, ownedRows(), reader, p)
			if w.Code != http.StatusNotFound || len(calls) != 0 {
				t.Errorf("%s: want 404, got %d", p, w.Code)
			}
		}
	}
}

func TestOwnedMessagesRejectBadPaging(t *testing.T) {
	w, calls := ownedGet(t, ownedRows(), allowAll, "/conversations/src/owned/alice-priv/messages?before=-1")
	if w.Code != http.StatusBadRequest || len(calls) != 0 {
		t.Errorf("want 400, got %d", w.Code)
	}
}

func TestOwnedReadLookupFailures(t *testing.T) {
	rows := ownedRows()
	rows.err = errors.New("db down")
	if w, _ := ownedGet(t, rows, allowAll, "/conversations/src/owned"); w.Code != http.StatusBadGateway {
		t.Errorf("source lookup failure: want 502, got %d", w.Code)
	}
	rows = ownedRows()
	rows.listErr = errors.New("db down")
	if w, _ := ownedGet(t, rows, allowAll, "/conversations/src/owned"); w.Code != http.StatusServiceUnavailable {
		t.Errorf("list failure: want 503, got %d", w.Code)
	}
}

func TestInternalGetStampsOwner(t *testing.T) {
	identity := identityConfig{userHeader: "x-auth-user", albIdentityHeader: "x-amzn-oidc-identity"}
	var got *http.Request
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	status, ct, body := internalGet(next, identity)(context.Background(), "/conversations/c/messages", url.Values{"limit": {"5"}}, "alice")
	if status != http.StatusOK || ct != "application/json" || body != `{"ok":true}` {
		t.Errorf("got %d %q %q", status, ct, body)
	}
	if got.Method != http.MethodGet || got.URL.Path != "/conversations/c/messages" || got.URL.Query().Get("limit") != "5" {
		t.Errorf("wrong request %s %s", got.Method, got.URL)
	}
	if got.Header.Get("x-auth-user") != "alice" || got.Header.Get("x-amzn-oidc-identity") != "alice" {
		t.Errorf("owner not stamped: %v", got.Header)
	}
}
