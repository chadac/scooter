package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeFolders struct {
	owner, convID, folderID string
	unstarred, subfolders   bool
	locked, service         bool
	parentID                string
	created                 string
	patch                   FolderPatch
	err                     error
}

func (f *fakeFolders) Folders(_ context.Context, owner string) (FolderList, error) {
	f.owner = owner
	return FolderList{Folders: []Folder{{ID: StarredFolderID, Name: "Starred", Kind: "starred"}}, Placements: map[string]string{}}, f.err
}
func (f *fakeFolders) CreateFolder(_ context.Context, owner, name, parentID string, locked, service bool) (Folder, error) {
	f.owner, f.created, f.parentID, f.locked, f.service = owner, name, parentID, locked, service
	return Folder{ID: "f1", Name: name, Kind: "user", Position: 1}, f.err
}
func (f *fakeFolders) UpdateFolder(_ context.Context, owner, id string, p FolderPatch, service bool) error {
	f.patch, f.service = p, service
	f.owner, f.folderID = owner, id
	return f.err
}
func (f *fakeFolders) DeleteFolder(_ context.Context, owner, id string, subfolders, service bool) error {
	f.owner, f.folderID, f.subfolders, f.service = owner, id, subfolders, service
	return f.err
}
func (f *fakeFolders) PlaceConversation(_ context.Context, owner, convID, folderID string) error {
	f.owner, f.convID, f.folderID = owner, convID, folderID
	return f.err
}
func (f *fakeFolders) Unstar(_ context.Context, owner, convID string) error {
	f.owner, f.convID, f.unstarred = owner, convID, true
	return f.err
}

func folderReq(method, path, body, caller string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if caller != "" {
		r.Header.Set("x-auth-user", caller)
	}
	return r
}

func TestFolderRoutes(t *testing.T) {
	for _, c := range []struct {
		path, id string
		ok       bool
	}{
		{"/folders", "", true},
		{"/folders/abc", "abc", true},
		{"/folders/abc/x", "", false},
		{"/conversations", "", false},
	} {
		if id, ok := FolderRoute(c.path); id != c.id || ok != c.ok {
			t.Errorf("FolderRoute(%q) = %q, %v", c.path, id, ok)
		}
	}
	if id, ok := PlacementPut("PUT", "/conversations/c1/folder"); !ok || id != "c1" {
		t.Errorf("PlacementPut = %q, %v", id, ok)
	}
	if _, ok := PlacementPut("PATCH", "/conversations/c1/folder"); ok {
		t.Error("only PUT files a conversation")
	}
}

func TestServeFolders(t *testing.T) {
	t.Run("GET is scoped to the caller", func(t *testing.T) {
		f := &fakeFolders{}
		w := httptest.NewRecorder()
		serveFolders(w, folderReq("GET", "/folders", "", "alice"), "", f, nil)
		var out FolderList
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if w.Code != 200 || f.owner != "alice" || out.Folders[0].ID != StarredFolderID {
			t.Fatalf("got %d %s, owner %q", w.Code, w.Body.String(), f.owner)
		}
	})
	t.Run("POST trims the name", func(t *testing.T) {
		f := &fakeFolders{}
		w := httptest.NewRecorder()
		serveFolders(w, folderReq("POST", "/folders", `{"name":"  Work "}`, "alice"), "", f, nil)
		if w.Code != 201 || f.created != "Work" {
			t.Fatalf("got %d, created %q", w.Code, f.created)
		}
	})
	for _, name := range []string{`""`, `"starred"`, `"` + strings.Repeat("x", 101) + `"`} {
		f := &fakeFolders{}
		w := httptest.NewRecorder()
		serveFolders(w, folderReq("POST", "/folders", `{"name":`+name+`}`, "alice"), "", f, nil)
		if w.Code != 400 || f.created != "" {
			t.Errorf("name %.12s: got %d", name, w.Code)
		}
	}
	t.Run("a taken name is a 409", func(t *testing.T) {
		w := httptest.NewRecorder()
		serveFolders(w, folderReq("POST", "/folders", `{"name":"Work"}`, "alice"), "", &fakeFolders{err: errFolderNameTaken}, nil)
		if w.Code != 409 {
			t.Fatalf("got %d", w.Code)
		}
	})
	t.Run("PATCH validates the icon", func(t *testing.T) {
		for body, want := range map[string]int{
			`{"icon":" chart-column "}`:                  204,
			`{"icon":""}`:                                204,
			`{"icon":"two words"}`:                       400,
			`{"icon":"Briefcase"}`:                       400,
			`{"icon":"` + strings.Repeat("a", 41) + `"}`: 400,
		} {
			f := &fakeFolders{}
			w := httptest.NewRecorder()
			serveFolders(w, folderReq("PATCH", "/folders/f1", body, "alice"), "f1", f, nil)
			if w.Code != want {
				t.Errorf("%s: got %d, want %d", body, w.Code, want)
			}
		}
		f := &fakeFolders{}
		serveFolders(httptest.NewRecorder(), folderReq("PATCH", "/folders/f1", `{"icon":" chart-column "}`, "alice"), "f1", f, nil)
		if f.patch.Icon == nil || *f.patch.Icon != "chart-column" || f.patch.Name != nil {
			t.Errorf("patch = %+v", f.patch)
		}
	})
	t.Run("Starred can't be changed", func(t *testing.T) {
		for _, m := range []string{"PATCH", "DELETE"} {
			f := &fakeFolders{}
			w := httptest.NewRecorder()
			serveFolders(w, folderReq(m, "/folders/starred", `{"name":"x"}`, "alice"), StarredFolderID, f, nil)
			if w.Code != 409 || f.folderID != "" {
				t.Errorf("%s: got %d", m, w.Code)
			}
		}
	})
	t.Run("only a folder service creates a locked folder", func(t *testing.T) {
		f := &fakeFolders{}
		w := httptest.NewRecorder()
		serveFolders(w, folderReq("POST", "/folders", `{"name":"Board","locked":true}`, "alice"), "", f, nil)
		if w.Code != http.StatusForbidden || f.created != "" {
			t.Errorf("user: got %d", w.Code)
		}
		kanban := FolderService(func(context.Context, *http.Request) (string, bool) { return "bob", true })
		r := folderReq("POST", "/folders", `{"name":"Board","locked":true}`, "alice")
		r.Header.Set("Authorization", "Bearer t")
		serveFolders(httptest.NewRecorder(), r, "", f, kanban)
		if f.owner != "bob" || !f.locked || !f.service {
			t.Errorf("service: %+v", f)
		}
	})
	t.Run("a refused bearer is just the user", func(t *testing.T) {
		f := &fakeFolders{}
		refuse := FolderService(func(context.Context, *http.Request) (string, bool) { return "", false })
		r := folderReq("DELETE", "/folders/f1", "", "alice")
		r.Header.Set("Authorization", "Bearer t")
		serveFolders(httptest.NewRecorder(), r, "f1", f, refuse)
		if f.owner != "alice" || f.service {
			t.Errorf("got %+v", f)
		}
	})
	t.Run("a locked folder is a 409", func(t *testing.T) {
		w := httptest.NewRecorder()
		serveFolders(w, folderReq("DELETE", "/folders/f1", "", "alice"), "f1", &fakeFolders{err: errFolderLocked}, nil)
		if w.Code != http.StatusConflict {
			t.Errorf("got %d", w.Code)
		}
	})
	t.Run("POST passes the parent", func(t *testing.T) {
		f := &fakeFolders{}
		serveFolders(httptest.NewRecorder(), folderReq("POST", "/folders", `{"name":"Sub","parentId":"f1"}`, "alice"), "", f, nil)
		if f.parentID != "f1" {
			t.Errorf("parent = %q", f.parentID)
		}
	})
	t.Run("DELETE chooses what happens to subfolders", func(t *testing.T) {
		for q, want := range map[string]bool{"": false, "?subfolders=delete": true, "?subfolders=lift": false} {
			f := &fakeFolders{}
			serveFolders(httptest.NewRecorder(), folderReq("DELETE", "/folders/f1"+q, "", "alice"), "f1", f, nil)
			if f.subfolders != want {
				t.Errorf("%q: subfolders = %v", q, f.subfolders)
			}
		}
	})
	t.Run("PATCH validates the lifetime", func(t *testing.T) {
		for body, want := range map[string]int{
			`{"conversationLifetimeHours":24}`:     204,
			`{"conversationLifetimeHours":0}`:      204,
			`{"conversationLifetimeHours":null}`:   204,
			`{"conversationLifetimeHours":-1}`:     400,
			`{"conversationLifetimeHours":999999}`: 400,
		} {
			w := httptest.NewRecorder()
			serveFolders(w, folderReq("PATCH", "/folders/f1", body, "alice"), "f1", &fakeFolders{}, nil)
			if w.Code != want {
				t.Errorf("%s: got %d, want %d", body, w.Code, want)
			}
		}
		f := &fakeFolders{}
		serveFolders(httptest.NewRecorder(), folderReq("PATCH", "/folders/f1", `{"conversationLifetimeHours":null}`, "alice"), "f1", f, nil)
		if !f.patch.ConversationLifetimeHours.Set || f.patch.ConversationLifetimeHours.Value != nil {
			t.Errorf("null must clear: %+v", f.patch.ConversationLifetimeHours)
		}
		serveFolders(httptest.NewRecorder(), folderReq("PATCH", "/folders/f1", `{"name":"x"}`, "alice"), "f1", f, nil)
		if f.patch.ConversationLifetimeHours.Set {
			t.Errorf("absent must keep: %+v", f.patch.ConversationLifetimeHours)
		}
	})
	t.Run("too deep and cycles are 409s", func(t *testing.T) {
		for _, err := range []error{errFolderTooDeep, errFolderCycle} {
			w := httptest.NewRecorder()
			serveFolders(w, folderReq("PATCH", "/folders/f1", `{"parentId":"f2"}`, "alice"), "f1", &fakeFolders{err: err}, nil)
			if w.Code != 409 {
				t.Errorf("%v: got %d", err, w.Code)
			}
		}
	})
	t.Run("someone else's folder is a 404", func(t *testing.T) {
		w := httptest.NewRecorder()
		serveFolders(w, folderReq("DELETE", "/folders/f1", "", "bob"), "f1", &fakeFolders{err: errFolderNotFound}, nil)
		if w.Code != 404 {
			t.Fatalf("got %d", w.Code)
		}
	})
}

func TestServePlacement(t *testing.T) {
	rows := func() *fakeMeta {
		return &fakeMeta{rows: map[string]*ConversationRow{
			"c1":    rowFixture("c1", strptr("alice")),
			"priv":  {ID: "priv", Owner: strptr("alice"), Visibility: VisibilityPrivate},
			"child": {ID: "child", ParentID: strptr("c1")},
		}}
	}
	place := func(f *fakeFolders, method, conv, body, caller string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		servePlacement(w, folderReq(method, "/conversations/"+conv+"/x", body, caller), conv, rows(), f, nil)
		return w
	}

	t.Run("anyone who can see a conversation may star it", func(t *testing.T) {
		f := &fakeFolders{}
		w := place(f, "PATCH", "c1", `{"starred":true}`, "bob")
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if w.Code != 200 || f.owner != "bob" || f.folderID != StarredFolderID || out["starred"] != true {
			t.Fatalf("got %d %s, %+v", w.Code, w.Body.String(), f)
		}
	})
	t.Run("unstar only leaves Starred", func(t *testing.T) {
		f := &fakeFolders{}
		if w := place(f, "PATCH", "c1", `{"starred":false}`, "bob"); w.Code != 200 || !f.unstarred {
			t.Fatalf("got %d, %+v", w.Code, f)
		}
	})
	t.Run("PUT files and null unfiles", func(t *testing.T) {
		f := &fakeFolders{}
		if w := place(f, "PUT", "c1", `{"folderId":"f1"}`, "alice"); w.Code != 204 || f.folderID != "f1" {
			t.Fatalf("got %d, %+v", w.Code, f)
		}
		if w := place(f, "PUT", "c1", `{"folderId":null}`, "alice"); w.Code != 204 || f.folderID != "" {
			t.Fatalf("got %d, %+v", w.Code, f)
		}
	})
	t.Run("a private conversation of someone else is a 404", func(t *testing.T) {
		f := &fakeFolders{}
		if w := place(f, "PUT", "priv", `{"folderId":"f1"}`, "bob"); w.Code != 404 || f.convID != "" {
			t.Fatalf("got %d", w.Code)
		}
	})
	t.Run("a subagent can't be filed", func(t *testing.T) {
		f := &fakeFolders{}
		if w := place(f, "PATCH", "child", `{"starred":true}`, "alice"); w.Code != 409 || f.convID != "" {
			t.Fatalf("got %d", w.Code)
		}
	})
	t.Run("a folder service files a conversation for the user it names", func(t *testing.T) {
		f := &fakeFolders{}
		kanban := FolderService(func(context.Context, *http.Request) (string, bool) { return "alice", true })
		r := folderReq("PUT", "/conversations/priv/folder", `{"folderId":"stage"}`, "")
		r.Header.Set("Authorization", "Bearer t")
		w := httptest.NewRecorder()
		servePlacement(w, r, "priv", rows(), f, kanban)
		if w.Code != 204 || f.owner != "alice" || f.folderID != "stage" {
			t.Fatalf("got %d, %+v", w.Code, f)
		}
	})
	t.Run("a folder service files a conversation for the user it names", func(t *testing.T) {
		f := &fakeFolders{}
		kanban := FolderService(func(context.Context, *http.Request) (string, bool) { return "alice", true })
		r := folderReq("PUT", "/conversations/priv/folder", `{"folderId":"stage"}`, "")
		r.Header.Set("Authorization", "Bearer t")
		w := httptest.NewRecorder()
		servePlacement(w, r, "priv", rows(), f, kanban)
		if w.Code != 204 || f.owner != "alice" || f.folderID != "stage" {
			t.Fatalf("got %d, %+v", w.Code, f)
		}
	})
	t.Run("a non-boolean star is a 400", func(t *testing.T) {
		if w := place(&fakeFolders{}, "PATCH", "c1", `{"starred":"yes"}`, "alice"); w.Code != 400 {
			t.Fatalf("got %d", w.Code)
		}
	})
}

func TestFolderFramesReachOnlyTheirOwner(t *testing.T) {
	hub := newSSEHub()
	alice, bob := hub.subscribe("alice", "all"), hub.subscribe("bob", "all")
	owner, ok := folderNotifyOwner(`{"owner":"alice"}`)
	if !ok {
		t.Fatal("payload rejected")
	}
	hub.deliver(sseData([]byte(`{"kind":"folders"}`)), func(s *sseSub) bool { return s.callerOwner == owner })
	if got := recv(alice); !strings.Contains(got, `"folders"`) {
		t.Errorf("alice got %q", got)
	}
	if got := recv(bob); got != "" {
		t.Errorf("bob got %q", got)
	}
	if _, ok := folderNotifyOwner(`{}`); ok {
		t.Error("a payload with no owner is dropped")
	}
}
