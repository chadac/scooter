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

// fakeCreator records the conversations the route asked to create.
type fakeCreator struct {
	calls []struct {
		name  string
		spec  map[string]interface{}
		title string
	}
	err error
}

func (f *fakeCreator) Create(_ context.Context, c NewConversation) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, struct {
		name  string
		spec  map[string]interface{}
		title string
	}{c.Name, c.Spec, c.Title})
	return nil
}

func postCreate(t *testing.T, c ConversationCreator, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	return postCreateAs(t, c, body, headers, nil)
}

// postCreateAs is postCreate with an explicit trusted-caller verifier, nil meaning no in-cluster trust.
func postCreateAs(t *testing.T, c ConversationCreator, body string, headers map[string]string, trusted TrustedCaller) *httptest.ResponseRecorder {
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
	serveConversationCreate(w, r, c, ownerFrom(r), trusted)
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
	if resp.Status != "pending" {
		t.Fatalf("want status=pending, got %q", resp.Status)
	}
	if len(c.calls) != 1 || c.calls[0].name != resp.ID {
		t.Fatalf("CR not created under the returned id: %+v", c.calls)
	}
}

// Creation must not consult agent-host capacity.
func TestCreateDoesNotConsultAgentHostCapacity(t *testing.T) {
	c := &fakeCreator{}
	for i := 0; i < 50; i++ { // beyond any plausible replicas x cap
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

// A stray threadId is ignored, not honored.
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
	// An empty owner must not be written.
	if _, present := c.calls[0].spec["owner"]; present {
		t.Fatalf("owner must be absent when anonymous, got %+v", c.calls[0].spec)
	}
}

func TestCreateSurfacesApiServerFailure(t *testing.T) {
	c := &fakeCreator{err: errors.New("apiserver unreachable")}
	w := postCreate(t, c, `{}`, nil)

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
		{http.MethodGet, "/conversations", false},      // the list
		{http.MethodPost, "/conversations/abc", false}, // a sub-route, proxied
		{http.MethodPost, "/conversations/abc/messages", false},
		{http.MethodPost, "/agui", false},
	}
	for _, tc := range cases {
		if got := IsConversationCreate(tc.method, tc.path); got != tc.want {
			t.Errorf("IsConversationCreate(%s %s) = %v, want %v", tc.method, tc.path, got, tc.want)
		}
	}
}

// --- owner: the in-cluster (webhooks/scheduler) path -----------------------------

// alwaysTrusted / neverTrusted stand in for the TokenReview verifier.
func alwaysTrusted() TrustedCaller {
	return func(context.Context, *http.Request) bool { return true }
}

func neverTrusted() TrustedCaller {
	return func(context.Context, *http.Request) bool { return false }
}

func TestCreateHonorsBodyOwnerFromATrustedCaller(t *testing.T) {
	c := &fakeCreator{}
	w := postCreateAs(t, c, `{"owner":"slack-resolved-user"}`, nil, alwaysTrusted())
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	if got := c.calls[0].spec["owner"]; got != "slack-resolved-user" {
		t.Fatalf("want spec.owner=slack-resolved-user, got %v", got)
	}
}

// The body owner must survive a non-default identity header.
func TestCreateBodyOwnerSurvivesANonDefaultIdentityHeader(t *testing.T) {
	t.Setenv("AUTH_USER_HEADER", "x-amzn-oidc-identity")
	c := &fakeCreator{}
	w := postCreateAs(t, c, `{"owner":"slack-resolved-user"}`,
		map[string]string{"x-auth-user": "slack-resolved-user"}, alwaysTrusted())
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d", w.Code)
	}
	if got := c.calls[0].spec["owner"]; got != "slack-resolved-user" {
		t.Fatalf("owner dropped when AUTH_USER_HEADER is renamed: spec=%+v", c.calls[0].spec)
	}
}

// An unverified caller must not be able to claim someone else's identity.
func TestCreateIgnoresBodyOwnerFromAnUnverifiedCaller(t *testing.T) {
	c := &fakeCreator{}
	w := postCreateAs(t, c, `{"owner":"someone-else"}`, nil, neverTrusted())
	if w.Code != http.StatusCreated {
		t.Fatalf("want 201 (ignored, not rejected), got %d", w.Code)
	}
	if _, present := c.calls[0].spec["owner"]; present {
		t.Fatalf("an unverified body owner must be dropped, got %+v", c.calls[0].spec)
	}
}

// No verifier configured at all is the same answer: ignored.
func TestCreateIgnoresBodyOwnerWhenTrustIsUnconfigured(t *testing.T) {
	c := &fakeCreator{}
	postCreateAs(t, c, `{"owner":"someone-else"}`, nil, nil)
	if _, present := c.calls[0].spec["owner"]; present {
		t.Fatalf("no verifier => no body owner, got %+v", c.calls[0].spec)
	}
}

// An unverified caller must not be able to replace the identity the ingress established.
func TestCreateBodyOwnerCannotOverrideTheHeaderIdentityUnverified(t *testing.T) {
	c := &fakeCreator{}
	postCreateAs(t, c, `{"owner":"victim"}`, map[string]string{"x-auth-user": "attacker"}, neverTrusted())
	if got := c.calls[0].spec["owner"]; got != "attacker" {
		t.Fatalf("want the header identity to stand (attacker), got %v", got)
	}
}

// The title is its own field, never a spec key.
func TestCreateKeepsTitleOutOfTheSpec(t *testing.T) {
	c := &fakeCreator{}
	w := postCreate(t, c, `{"title":"Seeded one"}`, nil)

	if w.Code != http.StatusCreated {
		t.Fatalf("want 201, got %d (%s)", w.Code, w.Body.String())
	}
	if _, present := c.calls[0].spec["title"]; present {
		t.Fatalf("title must not be a spec key, got spec=%+v", c.calls[0].spec)
	}
	if c.calls[0].title != "Seeded one" {
		t.Fatalf("title must reach the creator as its own field, got %q", c.calls[0].title)
	}
}

// The response echoes the requested title.
func TestCreateEchoesTheRequestedTitle(t *testing.T) {
	c := &fakeCreator{}
	w := postCreate(t, c, `{"title":"Seeded one"}`, nil)

	var resp createResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if resp.Title != "Seeded one" {
		t.Fatalf("want the title echoed, got %q", resp.Title)
	}
}

// fakeRowWriter records row inserts, failing with err when set.
type fakeRowWriter struct {
	calls []NewConversation
	err   error
}

func (f *fakeRowWriter) CreateConversation(_ context.Context, c NewConversation) error {
	if f.err != nil {
		return f.err
	}
	f.calls = append(f.calls, c)
	return nil
}

// The cluster create is the row insert, carrying the id, the spec and the title.
func TestRowCreatorWritesTheRow(t *testing.T) {
	rows := &fakeRowWriter{}
	if err := (rowCreator{rows: rows}).Create(context.Background(), NewConversation{
		Name: "conv-1", Title: "Seeded", Spec: map[string]interface{}{"owner": "alice"},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(rows.calls) != 1 || rows.calls[0].Name != "conv-1" || rows.calls[0].Title != "Seeded" {
		t.Fatalf("row not written as asked: %+v", rows.calls)
	}
}

// The route surfaces a row failure rather than reporting success: no row, no conversation.
func TestCreateSurfacesARowFailure(t *testing.T) {
	w := postCreate(t, rowCreator{rows: &fakeRowWriter{err: errors.New("pg down")}}, `{}`, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "pg down") {
		t.Errorf("the cause should survive: %s", w.Body.String())
	}
}

// A cluster router with no write store refuses creates instead of minting ids nothing records.
func TestCreateWithoutAWriteStoreIsRefused(t *testing.T) {
	w := postCreate(t, unavailableCreator{}, `{}`, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d (%s)", w.Code, w.Body.String())
	}
}

func TestCreateStoresOneshot(t *testing.T) {
	c := &fakeCreator{}
	w := postCreate(t, c, `{"oneshot":true}`, nil)
	if w.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if got := c.calls[0].spec["oneshot"]; got != true {
		t.Errorf("spec oneshot = %v", got)
	}
	var resp createResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.Oneshot {
		t.Error("response oneshot = false")
	}
	if !conversationRowOf(NewConversation{Name: "x", Spec: c.calls[0].spec}, 1).Oneshot {
		t.Error("row oneshot = false")
	}
}

func TestCreateOmitsOneshotByDefault(t *testing.T) {
	c := &fakeCreator{}
	if w := postCreate(t, c, `{}`, nil); w.Code != http.StatusCreated {
		t.Fatalf("status %d", w.Code)
	}
	if _, ok := c.calls[0].spec["oneshot"]; ok {
		t.Errorf("spec has oneshot without asking: %v", c.calls[0].spec)
	}
}

func TestCreateRejectsAOneshotSubagent(t *testing.T) {
	c := &fakeCreator{}
	if w := postCreate(t, c, `{"oneshot":true,"parentId":"p1"}`, nil); w.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", w.Code)
	}
	if len(c.calls) != 0 {
		t.Error("created anyway")
	}
}
