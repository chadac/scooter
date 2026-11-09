package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const selfNS = "agent-sandbox"

func strp(s string) *string { return &s }

// selfFixture: sandbox "abc123" runs conversation "conv-1" (and subagent "sub-1"); "conv-2" belongs to another sandbox.
func selfFixture(t *testing.T) (*selfAccess, *int, *http.Request) {
	t.Helper()
	reviews := 0
	review := func(_ context.Context, token string) (string, bool, error) {
		reviews++
		switch token {
		case "good":
			return "system:serviceaccount:" + selfNS + ":sandbox-abc123", true, nil
		case "other-ns":
			return "system:serviceaccount:elsewhere:sandbox-abc123", true, nil
		case "not-sandbox":
			return "system:serviceaccount:" + selfNS + ":agent-webhooks", true, nil
		case "boom":
			return "", false, errors.New("apiserver down")
		}
		return "", false, nil
	}
	rows := map[string]*ConversationRow{
		"conv-1": {ID: "conv-1", SandboxRef: strp("conv-abc123"), Owner: strp("alice")},
		"sub-1":  {ID: "sub-1", SandboxRef: strp("conv-abc123"), Owner: strp("alice"), ParentID: strp("conv-1")},
		"ses-1":  {ID: "ses-1", SandboxRef: strp("conv-abc123"), Owner: strp("alice"), ParentID: strp("conv-1"), Kind: strp(KindSession)},
		"conv-2": {ID: "conv-2", SandboxRef: strp("conv-zzz999"), Owner: strp("bob")},
		"conv-3": {ID: "conv-3"}, // sandbox_ref not yet written
	}
	lookup := func(_ context.Context, id string) (*ConversationRow, error) { return rows[id], nil }
	s := newSelfAccess(review, selfNS, lookup, identityConfig{mode: "header", userHeader: "x-auth-user", albIdentityHeader: "x-amzn-oidc-identity"}, 2, 1)
	return s, &reviews, nil
}

type seen struct {
	called  bool
	headers http.Header
}

func (s *seen) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.called = true
		s.headers = r.Header.Clone()
		w.WriteHeader(http.StatusAccepted)
	})
}

func do(s *selfAccess, method, path, token string, extra map[string]string) (int, *seen) {
	var got seen
	r := httptest.NewRequest(method, path, nil)
	if token != "" {
		r.Header.Set("authorization", "Bearer "+token)
	}
	for k, v := range extra {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.wrap(got.handler()).ServeHTTP(w, r)
	return w.Code, &got
}

func TestSelfRouteAllowlist(t *testing.T) {
	cases := []struct {
		method, path string
		ok           bool
	}{
		{"GET", "/conversations/c/events", true},
		{"GET", "/conversations/c/events.integrity", true},
		{"POST", "/conversations/c/events.integrity", false},
		{"GET", "/conversations/c/eventsXintegrity", false},
		{"GET", "/conversations/c/history", true},
		{"POST", "/conversations/c/messages", true},
		{"POST", "/conversations/c/cancel", true},
		{"POST", "/conversations/c/permission/tool-1", false}, // approvals stay with humans
		{"GET", "/conversations/c/messages", false},
		{"POST", "/conversations/c/events", false},
		{"GET", "/conversations", false},
		{"POST", "/conversations", false},
		{"POST", "/agui", false},
		{"PATCH", "/conversations/c/title", false},
		{"GET", "/conversations/c/events/x", false},
		{"POST", "/conversations/c/sessions", true},
		{"GET", "/conversations/c/sessions", true},
		{"POST", "/conversations/c/suspend", true},
		{"DELETE", "/conversations/c", false},
		{"GET", "/conversations/c/suspend", false},
		{"POST", "/conversations/c/subagents", false},
	}
	for _, tc := range cases {
		if _, _, ok := selfRoute(tc.method, tc.path); ok != tc.ok {
			t.Errorf("selfRoute(%s %s) = %v, want %v", tc.method, tc.path, ok, tc.ok)
		}
	}
}

func TestSandboxIDFromUsername(t *testing.T) {
	cases := []struct {
		user, want string
		ok         bool
	}{
		{"system:serviceaccount:agent-sandbox:sandbox-abc123", "abc123", true},
		{"system:serviceaccount:other:sandbox-abc123", "", false},
		{"system:serviceaccount:agent-sandbox:agent-host", "", false},
		{"system:serviceaccount:agent-sandbox:sandbox-", "", false},
		{"system:serviceaccount:agent-sandbox:sandbox-a/b", "", false},
		{"alice", "", false},
	}
	for _, tc := range cases {
		got, ok := sandboxIDFromUsername(tc.user, selfNS)
		if got != tc.want || ok != tc.ok {
			t.Errorf("sandboxIDFromUsername(%q) = %q,%v want %q,%v", tc.user, got, ok, tc.want, tc.ok)
		}
	}
}

func TestSelfAccessAdmitsOwnConversation(t *testing.T) {
	s, _, _ := selfFixture(t)
	for _, path := range []string{"/conversations/conv-1/events", "/conversations/conv-1/events.integrity", "/conversations/sub-1/history"} {
		code, got := do(s, "GET", path, "good", nil)
		if code != http.StatusAccepted || !got.called {
			t.Fatalf("%s: code %d called %v, want proxied", path, code, got.called)
		}
	}
}

func TestSelfAccessStripsIdentityAndToken(t *testing.T) {
	s, _, _ := selfFixture(t)
	code, got := do(s, "POST", "/conversations/conv-1/messages", "good", map[string]string{
		"x-auth-user": "mallory", "x-auth-email": "m@x", "x-amzn-oidc-identity": "mallory", "x-amzn-oidc-data": "jwt",
	})
	if code != http.StatusAccepted {
		t.Fatalf("code %d", code)
	}
	for _, h := range []string{"x-auth-email", "x-amzn-oidc-data", "authorization"} {
		if v := got.headers.Get(h); v != "" {
			t.Errorf("%s forwarded as %q, want stripped", h, v)
		}
	}
	// The pod's forged identity is replaced by the conversation's owner, which it acts for.
	for _, h := range []string{"x-auth-user", "x-amzn-oidc-identity"} {
		if v := got.headers.Get(h); v != "alice" {
			t.Errorf("%s forwarded as %q, want the owner alice", h, v)
		}
	}
	if got.headers.Get("x-scooter-caller") != "sandbox" {
		t.Errorf("x-scooter-caller not set")
	}
}

func TestSelfAccessStripsIdentityEvenWhenRejected(t *testing.T) {
	s, _, _ := selfFixture(t)
	r := httptest.NewRequest("GET", "/conversations/conv-2/events", nil)
	r.Header.Set("x-auth-user", "mallory")
	s.wrap(http.NotFoundHandler()).ServeHTTP(httptest.NewRecorder(), r)
	if r.Header.Get("x-auth-user") != "" {
		t.Fatal("identity header survived a rejected request")
	}
}

func TestSelfAccessRejections(t *testing.T) {
	s, _, _ := selfFixture(t)
	cases := []struct {
		name, method, path, token string
		want                      int
	}{
		{"no token", "GET", "/conversations/conv-1/events", "", http.StatusUnauthorized},
		{"bad token", "GET", "/conversations/conv-1/events", "nope", http.StatusForbidden},
		{"other namespace", "GET", "/conversations/conv-1/events", "other-ns", http.StatusForbidden},
		{"not a sandbox SA", "GET", "/conversations/conv-1/events", "not-sandbox", http.StatusForbidden},
		{"another sandbox's conversation", "GET", "/conversations/conv-2/events", "good", http.StatusForbidden},
		{"unknown conversation", "GET", "/conversations/nope/events", "good", http.StatusForbidden},
		{"sandbox_ref not yet written", "GET", "/conversations/conv-3/events", "good", http.StatusForbidden},
		{"route not allowed", "POST", "/conversations/conv-1/permission/t1", "good", http.StatusNotFound},
		{"list not allowed", "GET", "/conversations", "good", http.StatusNotFound},
		{"apiserver down", "GET", "/conversations/conv-1/events", "boom", http.StatusServiceUnavailable},
	}
	for _, tc := range cases {
		code, got := do(s, tc.method, tc.path, tc.token, nil)
		if code != tc.want || got.called {
			t.Errorf("%s: code %d called %v, want %d and not proxied", tc.name, code, got.called, tc.want)
		}
	}
}

func TestSelfAccessCachesReviews(t *testing.T) {
	s, reviews, _ := selfFixture(t)
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }
	do(s, "GET", "/conversations/conv-1/events", "good", nil)
	do(s, "GET", "/conversations/conv-1/history", "good", nil)
	if *reviews != 1 {
		t.Fatalf("reviews = %d, want 1 (cached)", *reviews)
	}
	now = now.Add(selfReviewTTL + time.Second)
	do(s, "GET", "/conversations/conv-1/events", "good", nil)
	if *reviews != 2 {
		t.Fatalf("reviews = %d, want 2 after TTL", *reviews)
	}
	// Errors are never cached.
	do(s, "GET", "/conversations/conv-1/events", "boom", nil)
	do(s, "GET", "/conversations/conv-1/events", "boom", nil)
	if *reviews != 4 {
		t.Fatalf("reviews = %d, want 4 (errors not cached)", *reviews)
	}
}

func TestSelfAccessRateLimitsMessages(t *testing.T) {
	s, _, _ := selfFixture(t)
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now }
	for i := 0; i < 2; i++ {
		if code, _ := do(s, "POST", "/conversations/conv-1/messages", "good", nil); code != http.StatusAccepted {
			t.Fatalf("message %d: code %d", i, code)
		}
	}
	if code, _ := do(s, "POST", "/conversations/conv-1/messages", "good", nil); code != http.StatusTooManyRequests {
		t.Fatalf("3rd message: code %d, want 429", code)
	}
	// Reads and cancel are not limited.
	if code, _ := do(s, "POST", "/conversations/conv-1/cancel", "good", nil); code != http.StatusAccepted {
		t.Fatalf("cancel limited: %d", code)
	}
	now = now.Add(time.Minute)
	if code, _ := do(s, "POST", "/conversations/conv-1/messages", "good", nil); code != http.StatusAccepted {
		t.Fatalf("after a minute: code %d", code)
	}
}

func TestSelfAccessRateLimitsSessions(t *testing.T) {
	s, _, _ := selfFixture(t)
	if code, _ := do(s, "POST", "/conversations/conv-1/sessions", "good", nil); code != http.StatusAccepted {
		t.Fatalf("1st session: code %d", code)
	}
	if code, _ := do(s, "POST", "/conversations/conv-1/sessions", "good", nil); code != http.StatusTooManyRequests {
		t.Fatalf("2nd session: code %d, want 429", code)
	}
	// Creating sessions does not spend the message cap.
	if code, _ := do(s, "POST", "/conversations/conv-1/messages", "good", nil); code != http.StatusAccepted {
		t.Fatalf("message after session: code %d", code)
	}
}

func TestSelfAccessClosesOnlySessions(t *testing.T) {
	s, _, _ := selfFixture(t)
	if code, got := do(s, "POST", "/conversations/ses-1/suspend", "good", nil); code != http.StatusAccepted || !got.called {
		t.Fatalf("close session: code %d called %v", code, got.called)
	}
	for _, id := range []string{"conv-1", "sub-1"} {
		if code, got := do(s, "POST", "/conversations/"+id+"/suspend", "good", nil); code != http.StatusForbidden || got.called {
			t.Fatalf("close %s: code %d called %v, want 403", id, code, got.called)
		}
	}
}
