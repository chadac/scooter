package main

// User assertions: a short-lived HS256 token naming the user the gateway proved, which the
// agent-host relays with an approval so the broker can check who answered.
// Must match services/broker/broker/core/user_assertion.py.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"
)

const (
	userAssertionHeader   = "X-Scooter-User-Assertion"
	userAssertionIssuer   = "scooter-router"
	userAssertionAudience = "scooter-user-assertion"
	// userAssertionTTL covers one answer's relay, not a session.
	userAssertionTTL = 5 * time.Minute
)

type userAssertionClaims struct {
	Iss   string `json:"iss"`
	Aud   string `json:"aud"`
	Sub   string `json:"sub"`
	Email string `json:"email,omitempty"`
	Iat   int64  `json:"iat"`
	Exp   int64  `json:"exp"`
}

type assertionMinter struct {
	secret []byte
	// services are the asserters vouched for; other asserters' users get no assertion.
	services map[string]bool
	now      func() time.Time
}

// newAssertionMinter returns nil without a secret, so nothing is minted.
func newAssertionMinter(secret string, services map[string]bool) *assertionMinter {
	if secret == "" {
		return nil
	}
	return &assertionMinter{secret: []byte(secret), services: services, now: time.Now}
}

// eligible: a proven browser user, or a user named by an allowlisted asserter.
func (m *assertionMinter) eligible(p gatewayPrincipal) bool {
	if m == nil || p.user == "" {
		return false
	}
	return p.kind == "user" || (p.kind == "service" && m.services[p.serviceAccount])
}

func (m *assertionMinter) mint(user, email string) string {
	now := m.now()
	claims, _ := json.Marshal(userAssertionClaims{
		Iss: userAssertionIssuer, Aud: userAssertionAudience, Sub: user, Email: email,
		Iat: now.Unix(), Exp: now.Add(userAssertionTTL).Unix(),
	})
	enc := base64.RawURLEncoding
	signing := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc.EncodeToString(claims)
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(signing))
	return signing + "." + enc.EncodeToString(mac.Sum(nil))
}

// stamp sets r's assertion for p, or leaves none.
func (m *assertionMinter) stamp(r *http.Request, p gatewayPrincipal) {
	if m.eligible(p) {
		r.Header.Set(userAssertionHeader, m.mint(p.user, p.email))
	}
}
