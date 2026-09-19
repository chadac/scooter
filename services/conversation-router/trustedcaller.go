package main

// Trusted-caller verification for the in-cluster services that create conversations
// ON BEHALF OF a human (webhooks, scheduler).
//
// Why `owner` needs a second path at all: the normal one is the identity header the
// INGRESS injects, whose name is deployment-configurable (AUTH_USER_HEADER) and in
// alb-oidc mode is a different header entirely. webhooks/scheduler never come through
// the ingress, so guessing that header's name on the sending side silently dropped the
// owner wherever the two disagreed (#527). They send `owner` in the BODY instead, and
// the router honors it only for a caller whose ServiceAccount token verifies via
// TokenReview. Mirrors the agent-host's check on /agui
// (services/agent-host/src/auth/webhooksCaller.ts) and the broker's SA auth.
//
// Deliberately fail-CLOSED, and never fatal: no token, an invalid token, a valid token
// for some other SA, no configured allowlist, or an unreachable TokenReview all mean
// "not trusted" → the body `owner` is ignored and the create proceeds with whatever the
// header said.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"k8s.io/client-go/rest"
)

// TrustedCaller reports whether a request proves it is one of the trusted in-cluster
// callers allowed to set `owner` on POST /conversations. Nil = verification disabled.
type TrustedCaller func(ctx context.Context, r *http.Request) bool

// tokenReviewTimeout bounds the extra apiserver round-trip a body-owner create costs.
// Only a create that actually carries a body owner pays it, so the browser path is
// untouched.
const tokenReviewTimeout = 5 * time.Second

// reviewTokenFunc verifies one bearer token, returning the username it authenticates
// as. Injectable so the create path is testable without an apiserver.
type reviewTokenFunc func(ctx context.Context, token string) (username string, authenticated bool, err error)

// --- the TokenReview wire types ---------------------------------------------------
// Hand-rolled rather than imported from k8s.io/api: the router's module graph has
// apimachinery + client-go only, and pulling k8s.io/api in for four fields would grow
// the vendor tree (and churn the nix vendorHash) for nothing.

type tokenReviewSpec struct {
	Token     string   `json:"token"`
	Audiences []string `json:"audiences,omitempty"`
}

type tokenReviewBody struct {
	APIVersion string          `json:"apiVersion"`
	Kind       string          `json:"kind"`
	Spec       tokenReviewSpec `json:"spec"`
}

type tokenReviewResult struct {
	Status struct {
		Authenticated bool `json:"authenticated"`
		User          struct {
			Username string `json:"username"`
		} `json:"user"`
		Error string `json:"error"`
	} `json:"status"`
}

// newTokenReviewer posts TokenReviews to the apiserver with the router's own
// credentials. `audience` must match what the caller's token was projected for
// (webhooks/scheduler mount an "agent-host" audience token — the router fronts that
// Service, so it is the same audience).
func newTokenReviewer(cfg *rest.Config, audience string) (reviewTokenFunc, error) {
	client, err := rest.HTTPClientFor(cfg)
	if err != nil {
		return nil, err
	}
	url := strings.TrimSuffix(cfg.Host, "/") + "/apis/authentication.k8s.io/v1/tokenreviews"
	return func(ctx context.Context, token string) (string, bool, error) {
		body, err := json.Marshal(tokenReviewBody{
			APIVersion: "authentication.k8s.io/v1",
			Kind:       "TokenReview",
			Spec:       tokenReviewSpec{Token: token, Audiences: audiences(audience)},
		})
		if err != nil {
			return "", false, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
		if err != nil {
			return "", false, err
		}
		req.Header.Set("content-type", "application/json")
		req.Header.Set("accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return "", false, err
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			return "", false, err
		}
		if resp.StatusCode >= 300 {
			// 403 here is the RBAC grant missing, which is a DEPLOY bug and not a spoof —
			// it must not read as "the caller lied". Surface the status so the log says which.
			return "", false, fmt.Errorf("tokenreview returned %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
		}
		var out tokenReviewResult
		if err := json.Unmarshal(raw, &out); err != nil {
			return "", false, err
		}
		if out.Status.Error != "" && !out.Status.Authenticated {
			return "", false, nil // a rejected token, not a transport failure
		}
		return out.Status.User.Username, out.Status.Authenticated, nil
	}, nil
}

func audiences(a string) []string {
	if a == "" {
		return nil
	}
	return []string{a}
}

// bearerToken extracts an `Authorization: Bearer <token>` value, "" if absent.
func bearerToken(r *http.Request) string {
	v := r.Header.Get("authorization")
	if len(v) < len("bearer ") || !strings.EqualFold(v[:len("bearer ")], "bearer ") {
		return ""
	}
	return strings.TrimSpace(v[len("bearer "):])
}

// trustedServiceAccounts parses the COMMA-SEPARATED allowlist of SA usernames (e.g.
// "system:serviceaccount:agent-sandbox:agent-webhooks"). Same env var the agent-host
// reads, so ONE setting configures both ends of the same trust chain.
func trustedServiceAccounts() map[string]bool {
	out := map[string]bool{}
	for _, s := range strings.Split(env("WEBHOOKS_SERVICE_ACCOUNT", ""), ",") {
		if s = strings.TrimSpace(s); s != "" {
			out[s] = true
		}
	}
	return out
}

// newTrustedCaller wraps a reviewer in the allowlist check. Returns nil when there is
// nothing to trust (no allowlist, or no reviewer) — the caller then never honors a body
// `owner`, which is the safe default for the kube-less dev stack.
func newTrustedCaller(review reviewTokenFunc, allowed map[string]bool) TrustedCaller {
	if len(allowed) == 0 || review == nil {
		return nil
	}
	log := logger("trusted-caller")
	return func(ctx context.Context, r *http.Request) bool {
		token := bearerToken(r)
		if token == "" {
			return false
		}
		ctx, cancel := context.WithTimeout(ctx, tokenReviewTimeout)
		defer cancel()
		username, ok, err := review(ctx, token)
		if err != nil {
			// Fail closed, but LOUDLY: a missing tokenreviews RBAC grant is
			// indistinguishable from a spoof attempt at this point, and silently
			// dropping the owner is the exact bug this path exists to fix.
			log.Warn("TokenReview failed, body owner not honored", errAttr(err))
			return false
		}
		if !ok || !allowed[username] {
			log.Warn("caller may not set an owner, body owner ignored",
				slog.String("username", username),
				slog.Bool("authenticated", ok))
			return false
		}
		return true
	}
}
