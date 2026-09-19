package main

import (
	"net/http"
	"strings"
)

// Caller identity, read off the request the ingress already authenticated.
//
// This MUST agree with the agent-host's resolver (services/agent-host/src/auth/identity.ts):
// both serve the same ingress-injected identity, and a disagreement does not fail loudly —
// every caller simply looks anonymous, and `visible()` (list.go) then returns true for
// everything, so every user sees every conversation. Issue #527.
type identityConfig struct {
	// "header" (a proxy sets userHeader) or "alb-oidc" (AWS ALB with OIDC).
	mode string
	// header mode: the request header carrying the authenticated user id.
	userHeader string
	// alb-oidc: the header carrying the OIDC subject. The email/name claims live in
	// the signed x-amzn-oidc-data JWT, which the router has no use for — it needs the
	// stable id only.
	albIdentityHeader string
}

func identityConfigFromEnv() identityConfig {
	return identityConfig{
		mode:              strings.ToLower(env("AUTH_MODE", "header")),
		userHeader:        env("AUTH_USER_HEADER", "x-auth-user"),
		albIdentityHeader: env("AUTH_ALB_IDENTITY_HEADER", "x-amzn-oidc-identity"),
	}
}

// identityHeader is the header this mode reads the user id from.
func (c identityConfig) identityHeader() string {
	if c.mode == "alb-oidc" {
		return c.albIdentityHeader
	}
	return c.userHeader
}

func (c identityConfig) owner(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get(c.identityHeader()))
}

// ownerFrom resolves the CALLER for spec.owner and the list scope. Empty = anonymous,
// a valid scope. Trusted only because the ingress sets it and strips client copies —
// which is also why an in-cluster caller (webhooks/scheduler, never through the
// ingress) must not use it; see trustedcaller.go.
func ownerFrom(r *http.Request) string {
	return identityConfigFromEnv().owner(r)
}
