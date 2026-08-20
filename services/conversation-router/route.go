// Package main — the conversation router. This file holds the PURE routing logic:
// extract a conversation id from a request, and resolve which upstream (owner pod) a
// request should go to. No k8s, no network — fully unit-testable (route_test.go).
package main

import (
	"net/url"
	"strings"
)

// ConvIDFromPath extracts the conversation id from a request PATH, for the path-scoped
// routes. Returns ("", false) if the path carries no conversation id (a non-scoped route
// like /healthz or /conversations with no id).
//
// Recognized shapes:
//
//	/conversations/<id>                     -> <id>
//	/conversations/<id>/<anything...>       -> <id>   (events.integrity, cancel, links, …)
//	/c/<id>/<service>/<rest...>             -> <id>   (the web-service proxy, incl. WS)
//
// POST /agui carries the id in the BODY (threadId), not the path — the caller reads that
// separately (ConvIDFromAgui) since it needs the parsed body anyway.
func ConvIDFromPath(path string) (string, bool) {
	parts := splitPath(path)
	if len(parts) < 2 {
		return "", false
	}
	switch parts[0] {
	case "conversations", "c":
		// GUARD: /conversations/events is the FLEET-WIDE list stream, not a conversation whose id
		// happens to be "events". Without this it parses as convID="events", finds no such owner,
		// and silently falls back to one arbitrary pod — so the sidebar's live stream showed only
		// that pod's slice of the conversations. Same class as the /conversations list bug.
		if parts[0] == "conversations" && parts[1] == "events" {
			return "", false
		}
		if parts[1] != "" {
			return parts[1], true
		}
	}
	return "", false
}

// IsFleetAggregate reports whether a request must be answered from the WHOLE FLEET rather than by
// any single pod. These endpoints read an agent-host's IN-MEMORY conversation map (sessions.list()),
// which on a multi-replica deployment holds only the conversations THAT pod currently hosts — with
// podCap=1 the controller deliberately spreads them one-per-pod, so any single pod sees a small,
// disjoint slice. Proxying such a request to one pod therefore returns a fraction of the user's
// conversations (observed on odin: per-pod 0,2,2,4,4,4,7,7,8,8 while 20 CRs existed), and WHICH
// fraction changes with load-balancing — conversations appear to vanish between refreshes.
//
// The router fans these out to every ready pod and merges the results (see aggregate.go).
func IsFleetAggregate(method, path string) bool {
	if method != "GET" {
		return false
	}
	parts := splitPath(path)
	if len(parts) == 1 && parts[0] == "conversations" {
		return true // GET /conversations — the list
	}
	if len(parts) == 2 && parts[0] == "conversations" && parts[1] == "events" {
		return true // GET /conversations/events — the live list stream
	}
	return false
}

// IsAguiPost reports whether this is the POST /agui route (id lives in the body).
func IsAguiPost(method, path string) bool {
	parts := splitPath(path)
	return method == "POST" && len(parts) == 1 && parts[0] == "agui"
}

// IsNonScoped reports whether a path is NOT conversation-scoped (routable to any ready
// pod) — health checks and the like.
func IsNonScoped(path string) bool {
	parts := splitPath(path)
	if len(parts) == 0 {
		return true
	}
	switch parts[0] {
	case "healthz", "health", "metrics":
		return true
	}
	return false
}

// TargetURL builds the upstream base URL for an owner pod, addressed by its POD IP.
// Deployments give random-named pods no stable DNS, so the router proxies straight to
// the IP the controller recorded in status.hostIP (see route table in the CR). `hostIP`
// is e.g. "10.42.0.49"; the upstream is http://<hostIP>:<port>.
//
// DESIGN NOTE: this replaces the old headless-Service DNS form
// (<hostPod>.<headless>.<ns>.svc). The headless Service is being removed.
func TargetURL(hostIP string, port int) *url.URL {
	return &url.URL{
		Scheme: "http",
		Host:   hostIP + ":" + itoa(port),
	}
}

// FallbackURL is the upstream for non-scoped / unassigned / stale-IP requests: the
// regular agent-host ClusterIP Service, which load-balances to ANY ready pod. Used when
// (a) the path isn't conversation-scoped, (b) the conversation has no known hostIP yet, or
// (c) a dial to the owner's hostIP fails (the pod was replaced this tick) — the controller
// converges the correct hostIP shortly.
//
// DESIGN STUB — signature only; the dial-fail retry that routes here lives in main.go.
func FallbackURL(clusterIPService, namespace string, port int) *url.URL {
	return &url.URL{
		Scheme: "http",
		Host:   clusterIPService + "." + namespace + ".svc.cluster.local:" + itoa(port),
	}
}

func splitPath(path string) []string {
	out := make([]string, 0, 4)
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// itoa avoids importing strconv just for a small positive int (ports).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
