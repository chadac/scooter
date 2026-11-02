package main

// Trusted-caller verification for the in-cluster services that create conversations on
// behalf of a human (webhooks, scheduler). They never come through the ingress that injects
// the identity header, so they send `owner` in the body, which the router honors only for
// a caller whose ServiceAccount token verifies via TokenReview against an allowlist. It
// fails closed and is never fatal: anything not trusted means the body `owner` is ignored.

import (
	"context"
	"log/slog"
	"net/http"

	"k8s.io/client-go/rest"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

// TrustedCaller reports whether a request proves it is a trusted in-cluster caller allowed to set `owner`; nil means verification is disabled.
type TrustedCaller func(ctx context.Context, r *http.Request) bool

// reviewTokenFunc verifies one bearer token, returning the username it authenticates as.
type reviewTokenFunc = svcauth.ReviewFunc

func newTokenReviewer(cfg *rest.Config, audience string) (reviewTokenFunc, error) {
	return svcauth.NewTokenReviewer(cfg, audience)
}

// bearerToken extracts an `Authorization: Bearer <token>` value, "" if absent.
func bearerToken(r *http.Request) string { return svcauth.BearerToken(r) }

// trustedServiceAccounts parses the comma-separated allowlist of SA usernames from the env var the agent-host also reads.
func trustedServiceAccounts() map[string]bool {
	return svcauth.ParseAllowlist(env("WEBHOOKS_SERVICE_ACCOUNT", ""))
}

// newTrustedCaller wraps a reviewer in the allowlist check, returning nil when there is no allowlist or no reviewer.
func newTrustedCaller(review reviewTokenFunc, allowed map[string]bool) TrustedCaller {
	if len(allowed) == 0 || review == nil {
		return nil
	}
	log := logger("trusted-caller")
	verifier := svcauth.NewVerifier(review)
	policy := svcauth.Policy{Services: allowed}
	return func(ctx context.Context, r *http.Request) bool {
		if svcauth.BearerToken(r) == "" {
			return false
		}
		p, err := verifier.Resolve(ctx, r, policy)
		if err != nil {
			// Fail closed but loudly, since a missing RBAC grant is indistinguishable from a spoof here.
			log.Warn("caller may not set an owner, body owner ignored",
				slog.String("username", p.ServiceAccount), errAttr(err))
			return false
		}
		return true
	}
}
