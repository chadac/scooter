package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetadataPatch(t *testing.T) {
	cases := []struct {
		method, path string
		wantField    string
		wantID       string
		wantOK       bool
	}{
		{"PATCH", "/conversations/abc/starred", "starred", "abc", true},
		{"PATCH", "/conversations/abc/title", "title", "abc", true},
		{"PATCH", "/conversations/xyz-123/starred", "starred", "xyz-123", true},
		{"GET", "/conversations/abc/starred", "", "", false},   // only PATCH
		{"PATCH", "/conversations/abc", "", "", false},         // no field
		{"PATCH", "/conversations/abc/suspend", "", "", false}, // other subroute
		{"PATCH", "/conversations/abc/title/x", "", "", false}, // too deep
		{"PATCH", "/conversations", "", "", false},             // no id
		{"PATCH", "/c/abc/starred", "", "", false},             // wrong prefix
	}
	for _, c := range cases {
		field, id, ok := MetadataPatch(c.method, c.path)
		if field != c.wantField || id != c.wantID || ok != c.wantOK {
			t.Errorf("MetadataPatch(%q,%q) = (%q,%q,%v), want (%q,%q,%v)",
				c.method, c.path, field, id, ok, c.wantField, c.wantID, c.wantOK)
		}
	}
}

// --- fakes for the handler test ---

type fakeMeta struct {
	rows        map[string]*ConversationRow
	readErr     error
	writeErr    error
	setTitle    *string
	setVis      *string
	writeCalled bool
}

func (f *fakeMeta) ConversationByID(_ context.Context, id string) (*ConversationRow, error) {
	if f.readErr != nil {
		return nil, f.readErr
	}
	return f.rows[id], nil
}
func (f *fakeMeta) SetUserTitle(_ context.Context, id, title string) (*ConversationRow, error) {
	f.writeCalled = true
	f.setTitle = &title
	if f.writeErr != nil {
		return nil, f.writeErr
	}
	row := f.rows[id]
	if row == nil {
		return nil, nil
	}
	row.Title = title
	yes := true
	row.UserTitled = &yes
	return row, nil
}

func (f *fakeMeta) SetVisibility(_ context.Context, id, visibility string) (*ConversationRow, error) {
	f.writeCalled = true
	f.setVis = &visibility
	if f.writeErr != nil {
		return nil, f.writeErr
	}
	row := f.rows[id]
	if row == nil {
		return nil, nil
	}
	row.Visibility = visibility
	return row, nil
}

func strptr(s string) *string { return &s }

func rowFixture(id string, owner *string) *ConversationRow {
	return &ConversationRow{ID: id, ThreadID: id, Title: "t", CreatedAt: 1, LastActivityAt: 2, Owner: owner}
}

func patch(t *testing.T, f *fakeMeta, field, id, body, caller string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPatch, "/conversations/"+id+"/"+field, strings.NewReader(body))
	if caller != "" {
		r.Header.Set("x-auth-user", caller)
	}
	w := httptest.NewRecorder()
	serveConversationMetadataPatch(w, r, field, id, f, f)
	return w
}

func TestMetadataPatchHandler(t *testing.T) {
	t.Run("rename sets the title and locks it", func(t *testing.T) {
		f := &fakeMeta{rows: map[string]*ConversationRow{"c1": rowFixture("c1", nil)}}
		w := patch(t, f, "title", "c1", `{"title":"  My Project  "}`, "")
		if w.Code != 200 {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
		if f.setTitle == nil || *f.setTitle != "My Project" {
			t.Fatalf("SetUserTitle not called with trimmed title: %+v", f.setTitle)
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		if out["userTitled"] != true {
			t.Errorf("response userTitled = %v, want true", out["userTitled"])
		}
	})

	t.Run("404 when the conversation row does not exist", func(t *testing.T) {
		f := &fakeMeta{rows: map[string]*ConversationRow{}}
		w := patch(t, f, "title", "gone", `{"title":"T"}`, "")
		if w.Code != 404 {
			t.Fatalf("want 404, got %d", w.Code)
		}
		if f.writeCalled {
			t.Error("must not write when the row is absent")
		}
	})

	t.Run("403 when an identified caller is not the owner", func(t *testing.T) {
		f := &fakeMeta{rows: map[string]*ConversationRow{"c1": rowFixture("c1", strptr("alice"))}}
		w := patch(t, f, "title", "c1", `{"title":"T"}`, "bob")
		if w.Code != 403 {
			t.Fatalf("want 403, got %d", w.Code)
		}
		if f.writeCalled {
			t.Error("must not write on a 403")
		}
	})

	t.Run("owner may mutate their own conversation", func(t *testing.T) {
		f := &fakeMeta{rows: map[string]*ConversationRow{"c1": rowFixture("c1", strptr("alice"))}}
		w := patch(t, f, "title", "c1", `{"title":"T"}`, "alice")
		if w.Code != 200 {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("anonymous caller may mutate any conversation (single-user mode)", func(t *testing.T) {
		f := &fakeMeta{rows: map[string]*ConversationRow{"c1": rowFixture("c1", strptr("alice"))}}
		w := patch(t, f, "title", "c1", `{"title":"T"}`, "")
		if w.Code != 200 {
			t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("400 on an empty title", func(t *testing.T) {
		f := &fakeMeta{rows: map[string]*ConversationRow{"c1": rowFixture("c1", nil)}}
		w := patch(t, f, "title", "c1", `{"title":"   "}`, "")
		if w.Code != 400 {
			t.Fatalf("want 400, got %d", w.Code)
		}
	})

	t.Run("502 when the write fails", func(t *testing.T) {
		f := &fakeMeta{rows: map[string]*ConversationRow{"c1": rowFixture("c1", nil)}, writeErr: errors.New("boom")}
		w := patch(t, f, "title", "c1", `{"title":"T"}`, "")
		if w.Code != http.StatusBadGateway {
			t.Fatalf("want 502, got %d", w.Code)
		}
	})

	t.Run("404 when the row is deleted between the auth read and the write", func(t *testing.T) {
		// The row is present for the auth read, but the write returns (nil,nil).
		f := &fakeMeta{rows: map[string]*ConversationRow{"c1": rowFixture("c1", nil)}}
		fw := &raceWriter{fakeMeta: f}
		r := httptest.NewRequest(http.MethodPatch, "/conversations/c1/title", strings.NewReader(`{"title":"T"}`))
		w := httptest.NewRecorder()
		serveConversationMetadataPatch(w, r, "title", "c1", f, fw)
		if w.Code != 404 {
			t.Fatalf("want 404, got %d", w.Code)
		}
	})
}

// raceWriter returns (nil,nil) from the write to simulate a delete that raced the write.
type raceWriter struct{ *fakeMeta }

func (r *raceWriter) SetUserTitle(context.Context, string, string) (*ConversationRow, error) {
	return nil, nil
}

// assignedResolver reports every conversation as live on an owner pod.
type assignedResolver struct{ assigned bool }

func (a assignedResolver) Resolve(context.Context, string) (string, string, bool, error) {
	return "", "", false, nil
}
func (a assignedResolver) Assigned(context.Context, string) bool { return a.assigned }

// Title is router-only even when live; live visibility goes to the owner pod.
func TestRouterServesPatch(t *testing.T) {
	ctx := context.Background()
	live, idle := assignedResolver{true}, assignedResolver{false}
	cases := []struct {
		field    string
		resolver ownerResolver
		want     bool
	}{
		{"title", live, true},
		{"title", nil, true},
		{"visibility", live, false},
		{"visibility", idle, true},
		{"visibility", nil, false},
	}
	for _, c := range cases {
		if got := routerServesPatch(ctx, c.resolver, c.field, "c1"); got != c.want {
			t.Errorf("routerServesPatch(%T%v, %q) = %v, want %v", c.resolver, c.resolver, c.field, got, c.want)
		}
	}
}
