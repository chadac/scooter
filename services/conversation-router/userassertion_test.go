package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

type userAssertionVector struct {
	Secret string              `json:"secret"`
	Claims userAssertionClaims `json:"claims"`
	Token  string              `json:"token"`
}

func readUserAssertionVector(t *testing.T) userAssertionVector {
	t.Helper()
	raw, err := os.ReadFile("testdata/user-assertion.json")
	if err != nil {
		t.Fatal(err)
	}
	var v userAssertionVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The broker verifies this same token, so a wire-format change fails one suite.
func TestUserAssertionMatchesVector(t *testing.T) {
	v := readUserAssertionVector(t)
	m := newAssertionMinter(v.Secret, nil)
	m.now = func() time.Time { return time.Unix(v.Claims.Iat, 0) }
	if got := m.mint(v.Claims.Sub, v.Claims.Email); got != v.Token {
		t.Fatalf("minted\n%s\nwant\n%s", got, v.Token)
	}
}

func TestNoSecretMintsNothing(t *testing.T) {
	if newAssertionMinter("", nil) != nil {
		t.Fatal("a minter without a secret")
	}
	var m *assertionMinter
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	m.stamp(r, gatewayPrincipal{kind: "user", user: "alice"})
	if r.Header.Get(userAssertionHeader) != "" {
		t.Fatal("a nil minter stamped an assertion")
	}
}

func TestGatewayStampsUserAssertion(t *testing.T) {
	status, calls := 0, int32(0)
	g, _ := testGateway(t, authProxy(t, &status, &calls).URL)
	g.enforce, g.legacy = true, nil
	scheduler := "system:serviceaccount:" + gwNS + ":agent-scheduler"
	g.policy.Asserters[scheduler] = true
	g.assertions = newAssertionMinter("router-test-secret", map[string]bool{gwWebhooks: true})
	at := time.Unix(1700000000, 0)
	g.assertions.now = func() time.Time { return at }
	var seen string
	h := g.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get(userAssertionHeader)
		w.WriteHeader(http.StatusNoContent)
	}))
	serve := func(r *http.Request) string {
		r.Header.Set(userAssertionHeader, "forged")
		seen = "unserved"
		h.ServeHTTP(httptest.NewRecorder(), r)
		return seen
	}
	asserted := func(sa string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/conversations/abc/interrupts/i/answer", nil)
		r.Header.Set("Authorization", "Bearer scooter-router:"+sa)
		r.Header.Set(svcauth.UserHeader, "carol")
		return r
	}

	cases := []struct {
		name string
		req  *http.Request
		want string
	}{
		{"browser user", browserReq("alice"), g.assertions.mint("alice", "alice@example.com")},
		{"allowlisted asserter", asserted(gwWebhooks), g.assertions.mint("carol", "")},
		{"asserter off the allowlist", asserted(scheduler), ""},
		{"plain service", asserted(gwBroker), ""},
		{"public path", httptest.NewRequest(http.MethodGet, "/healthz", nil), ""},
	}
	for _, c := range cases {
		if got := serve(c.req); got != c.want {
			t.Errorf("%s: assertion %q, want %q", c.name, got, c.want)
		}
	}
}
