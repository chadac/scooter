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
		if parts[1] != "" {
			return parts[1], true
		}
	}
	return "", false
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

// TargetURL builds the upstream base URL for an owner pod's stable DNS name. `hostPod`
// is the StatefulSet ordinal pod name (e.g. "agent-host-0"); it's reached at
// <hostPod>.<headlessService>.<namespace>.svc.cluster.local:<port>.
func TargetURL(hostPod, headlessService, namespace string, port int) *url.URL {
	return &url.URL{
		Scheme: "http",
		Host:   hostPod + "." + headlessService + "." + namespace + ".svc.cluster.local:" + itoa(port),
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
