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

// fakeParents is a parentLookup over an in-memory map: a missing key is a deleted/unknown parent
// (nil, nil), matching Store.ConversationByID's contract.
type fakeParents struct {
	rows map[string]*ConversationRow
	err  error
}

func (f *fakeParents) ConversationByID(_ context.Context, id string) (*ConversationRow, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.rows[id], nil
}

func str(s string) *string { return &s }

// aParent is a live owned conversation on a provisioned pod — what a subagent inherits from.
func aParent(id string) *ConversationRow {
	return &ConversationRow{
		ID: id, ThreadID: id, Title: "Parent",
		Owner: str("alice"), Model: str("model-fast"), SandboxRef: str("conv-abc123"),
	}
}

func postSubagent(t *testing.T, c ConversationCreator, p parentLookup, parentID, body string, headers map[string]string, trusted TrustedCaller) *httptest.ResponseRecorder {
	t.Helper()
	path := "/conversations/" + parentID + "/subagents"
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(http.MethodPost, path, nil)
	} else {
		r = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	serveSubagentCreate(w, r, c, p, parentID, ownerFrom(r), trusted)
	return w
}

// The whole point of the endpoint: the child is created with what it INHERITS, from the parent row
// rather than from the request.
func TestSubagentInheritsOwnerSandboxAndModel(t *testing.T) {
	c := &fakeCreator{}
	p := &fakeParents{rows: map[string]*ConversationRow{"parent-1": aParent("parent-1")}}

	w := postSubagent(t, c, p, "parent-1", `{"title":"Review the diff"}`, map[string]string{"x-auth-user": "alice"}, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var resp subagentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if resp.ID == "" || resp.ID == "parent-1" {
		t.Fatalf("the child needs its own minted id, got %q", resp.ID)
	}
	if resp.ParentID != "parent-1" || resp.SandboxRef != "conv-abc123" {
		t.Errorf("response must report what was inherited: %+v", resp)
	}
	if len(c.calls) != 1 || c.calls[0].name != resp.ID {
		t.Fatalf("conversation not created under the returned id: %+v", c.calls)
	}
	spec := c.calls[0].spec
	if spec["parentId"] != "parent-1" {
		t.Errorf("parentId must be in the spec (the controller co-locates by it): %+v", spec)
	}
	if spec["owner"] != "alice" {
		t.Errorf("owner must be inherited from the parent row: %+v", spec)
	}
	if spec["sandboxRef"] != "conv-abc123" {
		t.Errorf("sandboxRef must be inherited (the child shares the parent's pod): %+v", spec)
	}
	if spec["model"] != "model-fast" {
		t.Errorf("model must be inherited when the request does not override: %+v", spec)
	}
	if c.calls[0].title != "Review the diff" {
		t.Errorf("title should ride alongside the spec: %q", c.calls[0].title)
	}
}

func TestSubagentModelOverrideWins(t *testing.T) {
	c := &fakeCreator{}
	p := &fakeParents{rows: map[string]*ConversationRow{"parent-1": aParent("parent-1")}}

	w := postSubagent(t, c, p, "parent-1", `{"model":"model-cheap"}`, map[string]string{"x-auth-user": "alice"}, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	if c.calls[0].spec["model"] != "model-cheap" {
		t.Errorf("an explicit model must override the parent's: %+v", c.calls[0].spec)
	}
	if c.calls[0].title != defaultSubagentTitle {
		t.Errorf("an untitled subagent must still list under something: %q", c.calls[0].title)
	}
}

// A caller who is not the owner must not be able to mint a conversation owned by someone else —
// the same escalation the body-`owner` gate on POST /conversations prevents.
func TestSubagentRefusesAStrangerAndDoesNotLeakExistence(t *testing.T) {
	c := &fakeCreator{}
	p := &fakeParents{rows: map[string]*ConversationRow{"parent-1": aParent("parent-1")}}

	w := postSubagent(t, c, p, "parent-1", `{}`, map[string]string{"x-auth-user": "bob"}, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404 (not 403 — a 403 confirms the parent exists), got %d", w.Code)
	}
	if len(c.calls) != 0 {
		t.Fatalf("nothing may be created for a refused caller: %+v", c.calls)
	}
}

// The agent-host is the caller that actually spawns subagents today, and it never passes through
// the ingress — it has no identity header at all, so TokenReview is its only way in.
func TestSubagentAllowsAVerifiedInClusterCaller(t *testing.T) {
	c := &fakeCreator{}
	p := &fakeParents{rows: map[string]*ConversationRow{"parent-1": aParent("parent-1")}}
	trusted := func(context.Context, *http.Request) bool { return true }

	w := postSubagent(t, c, p, "parent-1", `{}`, nil, trusted)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	if c.calls[0].spec["owner"] != "alice" {
		t.Errorf("the child still inherits the PARENT's owner, not the caller's: %+v", c.calls[0].spec)
	}
}

// The anonymous and kube-less stacks have no identity header and no TokenReview; an unowned parent
// has no owner to escalate to, so it must stay creatable.
func TestSubagentOfAnUnownedParentIsOpen(t *testing.T) {
	c := &fakeCreator{}
	parent := aParent("parent-1")
	parent.Owner = nil
	p := &fakeParents{rows: map[string]*ConversationRow{"parent-1": parent}}

	w := postSubagent(t, c, p, "parent-1", `{}`, nil, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	if _, ok := c.calls[0].spec["owner"]; ok {
		t.Errorf("an unowned parent must not invent an owner: %+v", c.calls[0].spec)
	}
}

func TestSubagentUnknownParentIs404(t *testing.T) {
	c := &fakeCreator{}
	p := &fakeParents{rows: map[string]*ConversationRow{}}

	w := postSubagent(t, c, p, "gone", `{}`, nil, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d (%s)", w.Code, w.Body.String())
	}
	if len(c.calls) != 0 {
		t.Fatalf("a subagent of nothing must not be created: %+v", c.calls)
	}
}

// Without the parent row there is nothing to inherit. Guessing (no owner, no sandbox ref) would
// produce a subagent that lists under nobody and cannot be co-located, so report unavailable.
func TestSubagentWithoutAStoreIs503(t *testing.T) {
	c := &fakeCreator{}
	w := postSubagent(t, c, nil, "parent-1", `{}`, nil, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503, got %d (%s)", w.Code, w.Body.String())
	}
	if len(c.calls) != 0 {
		t.Fatalf("nothing may be created without a parent to inherit from: %+v", c.calls)
	}
}

func TestSubagentSurfacesLookupAndCreateFailures(t *testing.T) {
	c := &fakeCreator{}
	w := postSubagent(t, c, &fakeParents{err: errors.New("pg down")}, "parent-1", `{}`, nil, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("parent lookup failure: want 502, got %d", w.Code)
	}

	failing := &fakeCreator{err: errors.New("apiserver down")}
	p := &fakeParents{rows: map[string]*ConversationRow{"parent-1": aParent("parent-1")}}
	w = postSubagent(t, failing, p, "parent-1", `{}`, map[string]string{"x-auth-user": "alice"}, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("create failure: want 502, got %d", w.Code)
	}
}

func TestSubagentRejectsMalformedBodyAndBadModel(t *testing.T) {
	p := &fakeParents{rows: map[string]*ConversationRow{"parent-1": aParent("parent-1")}}
	owner := map[string]string{"x-auth-user": "alice"}

	if w := postSubagent(t, &fakeCreator{}, p, "parent-1", `{`, owner, nil); w.Code != http.StatusBadRequest {
		t.Errorf("malformed body: want 400, got %d", w.Code)
	}
	if w := postSubagent(t, &fakeCreator{}, p, "parent-1", `{"model":"../etc/passwd"}`, owner, nil); w.Code != http.StatusBadRequest {
		t.Errorf("bad model: want 400, got %d", w.Code)
	}
	// An empty body is legal — everything is inherited.
	if w := postSubagent(t, &fakeCreator{}, p, "parent-1", "", owner, nil); w.Code != http.StatusCreated {
		t.Errorf("empty body: want 201, got %d", w.Code)
	}
}

func TestSubagentCreateMatchesOnlyThePostRoute(t *testing.T) {
	cases := []struct {
		method, path string
		wantID       string
	}{
		{http.MethodPost, "/conversations/abc/subagents", "abc"},
		{http.MethodPost, "/conversations/abc/subagents/", "abc"},
		{http.MethodGet, "/conversations/abc/subagents", ""},
		{http.MethodPost, "/conversations/abc", ""},
		{http.MethodPost, "/conversations", ""},
		{http.MethodPost, "/conversations/abc/subagents/xyz", ""},
		{http.MethodPost, "/conversations//subagents", ""},
		{http.MethodPost, "/conversations/abc/agui", ""},
	}
	for _, tc := range cases {
		id, ok := SubagentCreate(tc.method, tc.path)
		if (tc.wantID != "") != ok || id != tc.wantID {
			t.Errorf("%s %s: want (%q, %v), got (%q, %v)", tc.method, tc.path, tc.wantID, tc.wantID != "", id, ok)
		}
	}
}
