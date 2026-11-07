package main

import (
	"log/slog"
	"net/http"
	"strings"

	"k8s.io/client-go/rest"

	"github.com/chadac-me/scooter/conversation-router/svcauth"
)

// defaultSessionCookies must match the agent-host's DEFAULT_SESSION_COOKIES.
const defaultSessionCookies = "_oauth2_proxy,AWSELBAuthSessionCookie"

func sessionCookiePrefixes() []string {
	var out []string
	for _, p := range strings.Split(env("AUTH_SESSION_COOKIES", defaultSessionCookies), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// buildGateways returns main and sandbox gateways; none in dev mode.
func buildGateways(kubeCfg *rest.Config, log *slog.Logger) (main, sandbox *gateway) {
	if kubeCfg == nil {
		return nil, nil
	}
	identity := identityConfigFromEnv()
	prefixes := sessionCookiePrefixes()
	enforce := env("AUTH_ENFORCE", "") == "true"
	var alb *albVerifier
	if region := env("AUTH_ALB_REGION", ""); region != "" && identity.mode == "alb-oidc" {
		alb = newAlbVerifier(region)
	}
	mk := func(listener, checkURL string) *gateway {
		g := newGateway(listener, identity)
		g.prefixes, g.alb, g.enforce = prefixes, alb, enforce
		if checkURL != "" && identity.mode != "alb-oidc" {
			g.session = newSessionChecker(checkURL, prefixes)
		}
		if !g.browserProof() && enforce {
			log.Error("browser identity cannot be verified on this listener, so every browser request is refused",
				slog.String("listener", listener))
		} else if !g.browserProof() {
			log.Warn("browser identity is not verified on this listener: set scooter.auth.sessionCheckUrl (or albRegion in alb-oidc mode)",
				slog.String("listener", listener))
		}
		return g
	}

	main = mk("main", env("AUTH_SESSION_CHECK_URL", ""))
	main.public = healthPaths
	main.assertions = newAssertionMinter(env("USER_ASSERTION_SECRET", ""),
		svcauth.ParseAllowlist(env("USER_ASSERTION_SERVICE_ACCOUNTS", "")))
	if main.assertions != nil && !enforce {
		log.Warn("USER_ASSERTION_SECRET is set without AUTH_ENFORCE, so no user assertions are minted")
	}
	main.policy = svcauth.Policy{
		Services:  svcauth.ParseAllowlist(env("ROUTER_SERVICE_ACCOUNTS", "")),
		Asserters: trustedServiceAccounts(),
	}
	audience := env("ROUTER_TOKEN_AUDIENCE", "scooter-router")
	if review, err := svcauth.NewTokenReviewer(kubeCfg, audience); err != nil {
		log.Warn("gateway TokenReview client init failed: service tokens are not checked", errAttr(err))
	} else {
		main.services = svcauth.NewVerifier(review)
	}
	if legacy := env("WEBHOOKS_TOKEN_AUDIENCE", "agent-host"); legacy != audience && main.services != nil && !enforce {
		if review, err := svcauth.NewTokenReviewer(kubeCfg, legacy); err == nil {
			main.legacy = svcauth.NewVerifier(review)
		}
	}

	sandbox = mk("sandbox", env("AUTH_SANDBOX_SESSION_CHECK_URL", env("AUTH_SESSION_CHECK_URL", "")))
	mode := "shadow"
	if enforce {
		mode = "enforce"
	}
	log.Info("auth gateway started",
		slog.String("mode", mode),
		slog.String("audience", audience),
		slog.Int("services", len(main.policy.Services)),
		slog.Int("asserters", len(main.policy.Asserters)))
	return main, sandbox
}

// guarded wraps h in g when there is one.
func guarded(g *gateway, h http.Handler) http.Handler {
	if g == nil {
		return h
	}
	return g.wrap(h)
}
