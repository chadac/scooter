package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

const webhooksSA = "system:serviceaccount:agent-sandbox:agent-webhooks"

func withBearer(token string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/conversations", nil)
	if token != "" {
		r.Header.Set("authorization", "Bearer "+token)
	}
	return r
}

// reviewer answers `username` for the one token it knows, and rejects anything else.
func reviewer(knownToken, username string) reviewTokenFunc {
	return func(_ context.Context, token string) (string, bool, error) {
		if token != knownToken {
			return "", false, nil
		}
		return username, true, nil
	}
}

func TestBearerTokenParsing(t *testing.T) {
	cases := []struct{ header, want string }{
		{"Bearer abc", "abc"},
		{"bearer abc", "abc"}, // scheme is case-insensitive per RFC 7235
		{"BEARER  abc ", "abc"},
		{"Basic abc", ""},
		{"abc", ""},
		{"", ""},
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodPost, "/conversations", nil)
		if tc.header != "" {
			r.Header.Set("authorization", tc.header)
		}
		if got := bearerToken(r); got != tc.want {
			t.Errorf("bearerToken(%q) = %q, want %q", tc.header, got, tc.want)
		}
	}
}

func TestTrustedCallerAcceptsAnAllowlistedServiceAccount(t *testing.T) {
	tc := newTrustedCaller(reviewer("good", webhooksSA), map[string]bool{webhooksSA: true})
	if tc == nil {
		t.Fatal("verifier must be built when an allowlist is configured")
	}
	if !tc(context.Background(), withBearer("good")) {
		t.Fatal("the webhooks SA must be trusted")
	}
}

func TestTrustedCallerRejectsEverythingElse(t *testing.T) {
	allowed := map[string]bool{webhooksSA: true}
	tc := newTrustedCaller(reviewer("good", webhooksSA), allowed)
	if tc(context.Background(), withBearer("")) {
		t.Error("no token must not be trusted")
	}
	if tc(context.Background(), withBearer("forged")) {
		t.Error("an unauthenticated token must not be trusted")
	}
	// A VALID token for a different SA — e.g. a sandbox's own SA — must not pass.
	other := newTrustedCaller(reviewer("good", "system:serviceaccount:agent-sandbox:conv-abc"), allowed)
	if other(context.Background(), withBearer("good")) {
		t.Error("a valid token for a non-allowlisted SA must not be trusted")
	}
}

// A TokenReview that ERRORS (RBAC missing, apiserver unreachable) must fail CLOSED —
// never trusted, never a panic, never a failed create.
func TestTrustedCallerFailsClosedOnReviewError(t *testing.T) {
	failing := func(context.Context, string) (string, bool, error) {
		return "", false, errors.New("tokenreviews.authentication.k8s.io is forbidden")
	}
	tc := newTrustedCaller(failing, map[string]bool{webhooksSA: true})
	if tc(context.Background(), withBearer("good")) {
		t.Fatal("a failed TokenReview must not be trusted")
	}
}

func TestTrustedCallerDisabledWithoutAnAllowlist(t *testing.T) {
	if tc := newTrustedCaller(reviewer("good", webhooksSA), nil); tc != nil {
		t.Fatal("no allowlist must disable verification entirely (nil), not trust everyone")
	}
	if tc := newTrustedCaller(nil, map[string]bool{webhooksSA: true}); tc != nil {
		t.Fatal("no reviewer must disable verification entirely (nil)")
	}
}

func TestTrustedServiceAccountsParsesTheSharedEnvVar(t *testing.T) {
	// Same variable the agent-host reads (WEBHOOKS_SERVICE_ACCOUNT), so one setting
	// configures both ends of the trust chain.
	t.Setenv("WEBHOOKS_SERVICE_ACCOUNT", " "+webhooksSA+" ,system:serviceaccount:agent-sandbox:agent-scheduler,")
	got := trustedServiceAccounts()
	if len(got) != 2 || !got[webhooksSA] || !got["system:serviceaccount:agent-sandbox:agent-scheduler"] {
		t.Fatalf("want both SAs parsed, got %+v", got)
	}
	t.Setenv("WEBHOOKS_SERVICE_ACCOUNT", "")
	if len(trustedServiceAccounts()) != 0 {
		t.Fatal("unset must yield an empty allowlist (verification disabled)")
	}
}
