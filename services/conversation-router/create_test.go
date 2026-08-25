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

// fakeCreator records what would have been written to the API server. Note it has
// NO notion of agent-host capacity — which is the point of the whole change.
type fakeCreator struct {
	calls []struct {
		name string
		spec map[string]interface{}
	}
	err error
}

func (f *fakeCreator) Create(_ context.Context, name string, spec map[string]interface{}) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, struct {
		name string
		spec map[string]interface{}
	}{name, spec})
	return nil
}

func postCreate(t *testing.T, c ConversationCreator, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(http.MethodPost, "/conversations", nil)
	} else {
		r = httptest.NewRequest(http.MethodPost, "/conversations", strings.NewReader(body))
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	serveConversationCreate(w, r, c, ownerFrom(r))
	return w
}

func TestCreateMintsIdAndReturns201(t *testing.T) {
	c := &fakeCreator{}
	w := postCreate(t, c, `{}`, nil)

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var resp createResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if resp.ID == "" {
		t.Fatal("no id returned")
	}
	// The conversation exists but has no host yet — that is normal, not a failure.
	if resp.Status != "pending" {
		t.Fatalf("want status=pending, got %q", resp.Status)
	}
	if len(c.calls) != 1 || c.calls[0].name != resp.ID {
		t.Fatalf("CR not created under the returned id: %+v", c.calls)
	}
}

// THE POINT OF THE CHANGE. The agent-host is capacity-bounded: the controller
// leaves a conversation Pending when every pod is at cap. Creation must not
// consult that at all — conversation N*C+1 is still creatable.
func TestCreateDoesNotConsultAgentHostCapacity(t *testing.T) {
	c := &fakeCreator{}
	for i := 0; i < 50; i++ { // far beyond any plausible replicas x cap
		w := postCreate(t, c, `{}`, nil)
		if w.Code != http.StatusCreated {
			t.Fatalf("conversation %d failed with %d — creation must not depend on host capacity", i+1, w.Code)
		}
	}
	if len(c.calls) != 50 {
		t.Fatalf("want 50 CRs, got %d", len(c.calls))
	}
	seen := map[string]bool{}
	for _, call := range c.calls {
		if seen[call.name] {
			t.Fatalf("duplicate conversation id minted: %s", call.name)
		}
		seen[call.name] = true
	}
}

// A stray threadId is ignored, not honored — the server mints the id. There is no
// rejection branch: encoding/json drops the unknown key, and the caller gets the
// real id from the response.
func TestCreateIgnoresAStrayThreadId(t *testing.T) {
	c := &fakeCreator{}
	w := postCreate(t, c, `{"threadId":"attacker-chosen-id"}`, nil)

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	var resp createResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if resp.ID == "attacker-chosen-id" || c.calls[0].name == "attacker-chosen-id" {
		t.Fatalf("client-supplied id must never be used, got %q / CR %q", resp.ID, c.calls[0].name)
	}
}

func TestCreateStampsOwnerFromIdentityHeader(t *testing.T) {
	c := &fakeCreator{}
	w := postCreate(t, c, `{}`, map[string]string{"x-auth-user": "chadac"})
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d", w.Code)
	}
	if got := c.calls[0].spec["owner"]; got != "chadac" {
		t.Fatalf("want spec.owner=chadac, got %v", got)
	}
}

func TestCreateAnonymousOmitsOwner(t *testing.T) {
	c := &fakeCreator{}
	w := postCreate(t, c, `{}`, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d", w.Code)
	}
	// Anonymous is a valid scope; an EMPTY owner must not be written, or the
	// conversation would be owned by "" rather than being unowned.
	if _, present := c.calls[0].spec["owner"]; present {
		t.Fatalf("owner must be absent when anonymous, got %+v", c.calls[0].spec)
	}
}

func TestCreateSurfacesApiServerFailure(t *testing.T) {
	c := &fakeCreator{err: errors.New("apiserver unreachable")}
	w := postCreate(t, c, `{}`, nil)

	// A failed CR write means the conversation does NOT exist. Returning an id
	// would hand back something unusable, so this must be an error.
	if w.Code != http.StatusBadGateway {
		t.Fatalf("want 502 when the CR write fails, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestCreateRejectsMalformedBodyAndBadModel(t *testing.T) {
	c := &fakeCreator{}
	if w := postCreate(t, c, `{not json`, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for malformed JSON, got %d", w.Code)
	}
	if w := postCreate(t, c, `{"model":"../../etc/passwd"}`, nil); w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for an invalid model, got %d", w.Code)
	}
	if len(c.calls) != 0 {
		t.Fatalf("no CR should be created on a rejected request: %+v", c.calls)
	}
}

func TestCreateAcceptsEmptyBody(t *testing.T) {
	c := &fakeCreator{}
	if w := postCreate(t, c, "", nil); w.Code != http.StatusCreated {
		t.Fatalf("an empty body is valid (all fields optional), got %d", w.Code)
	}
}

func TestIsConversationCreateMatchesOnlyThePostRoute(t *testing.T) {
	cases := []struct {
		method, path string
		want         bool
	}{
		{http.MethodPost, "/conversations", true},
		{http.MethodPost, "/conversations/", true},
		{http.MethodGet, "/conversations", false},      // the fleet-aggregate list
		{http.MethodPost, "/conversations/abc", false}, // a sub-route: proxy it
		{http.MethodPost, "/conversations/abc/messages", false},
		{http.MethodPost, "/agui", false},
	}
	for _, tc := range cases {
		if got := IsConversationCreate(tc.method, tc.path); got != tc.want {
			t.Errorf("IsConversationCreate(%s %s) = %v, want %v", tc.method, tc.path, got, tc.want)
		}
	}
}
