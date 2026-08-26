// Structured logging for the conversation-router.
//
// Mirrors services/agent-host/src/log.ts so a single Loki query can follow one conversation
// across both services. One JSON object per line:
//
//	{"ts":"…","level":"info","service":"conversation-router","component":"proxy",
//	 "msg":"proxy failed","conversation_id":"42bb375c-…","upstream":"10.42.0.2:8080"}
//
// `component` is the old prose prefix ("aggregate: …", "cache …") promoted to a field, and
// `msg` is a SHORT CONSTANT — every variable value is a field, because a constant msg is
// groupable and an interpolated one is not.
//
// The conversation id field is ALWAYS spelled `conversation_id`, matching the agent-host, so
// the cross-service query works. Go has no AsyncLocalStorage equivalent, so the id is passed
// explicitly where the router knows it (it knows it at exactly two layers — the proxy path and
// the create route — so this stays cheap).
//
// Output is stdout/stderr, one line each: the cluster collector (Alloy) already scrapes pod
// logs into Loki, so stdout IS the ingestion path and no exporter is needed.
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"syscall"
)

// serviceName rides every line. Cross-service queries filter on it.
const serviceName = "conversation-router"

// logLevel reads LOG_LEVEL, defaulting to info. Same spellings the agent-host honors.
func logLevel() slog.Level {
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		return slog.LevelDebug
	case "info":
		return slog.LevelInfo
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	if os.Getenv("DEBUG") == "1" {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}

// jsonOutput: JSON in a container, human-readable text at a terminal. k8s sets
// KUBERNETES_SERVICE_HOST in every pod, so this picks the right default with no config.
// LOG_FORMAT=json|pretty overrides, as in the agent-host.
func jsonOutput() bool {
	switch strings.ToLower(os.Getenv("LOG_FORMAT")) {
	case "json":
		return true
	case "pretty", "text":
		return false
	}
	return os.Getenv("KUBERNETES_SERVICE_HOST") != ""
}

// newHandler builds the slog handler, writing to w. Split out from setupLogging so tests can
// capture the output.
func newHandler(w io.Writer) slog.Handler {
	opts := &slog.HandlerOptions{
		Level: logLevel(),
		// Rename slog's built-ins to the shared convention: "time" -> "ts", "message" -> "msg"
		// (slog already emits "level"). Everything else passes through untouched.
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) > 0 {
				return a
			}
			switch a.Key {
			case slog.TimeKey:
				a.Key = "ts"
			case slog.MessageKey:
				a.Key = "msg"
			case slog.LevelKey:
				// slog renders levels UPPERCASE ("WARN"). The fleet convention is
				// lowercase, matching the TypeScript and Python services — without this
				// the natural cross-service query level="warn" silently misses every
				// line this service emits.
				if lv, ok := a.Value.Any().(slog.Level); ok {
					a.Value = slog.StringValue(strings.ToLower(lv.String()))
				}
			}
			return a
		},
	}
	if jsonOutput() {
		return slog.NewJSONHandler(w, opts)
	}
	return slog.NewTextHandler(w, opts)
}

// setupLogging installs the process-wide logger. Called once from main.
func setupLogging() {
	slog.SetDefault(slog.New(newHandler(os.Stderr)).With(slog.String("service", serviceName)))
}

// logger returns a logger bound to one component — the old prose prefix, now a queryable field.
//
//	log := logger("cache")
//	log.Error("watch failed", errAttr(err))
func logger(component string) *slog.Logger {
	return slog.Default().With(slog.String("component", component))
}

// convAttr is the ONE spelling of the conversation id field. Everything that knows an id logs
// it through here so no call site can drift to convId/conversationId and break the join.
//
// An empty id yields an EMPTY Attr, which slog drops: a non-scoped request (/healthz) has no
// conversation, and emitting conversation_id:"" would make it look like one whose id failed to
// resolve — and would pollute a `conversation_id != ""` query.
func convAttr(id string) slog.Attr {
	if id == "" {
		return slog.Attr{}
	}
	return slog.String("conversation_id", id)
}

// errAttr renders an error as a group with content, rather than a bare interpolation. Go's
// wrapped errors hide their useful parts behind Unwrap, and a syscall errno prints as prose;
// this pulls out the type and the unwrap chain so a failure is attributable without grepping
// the message text.
func errAttr(err error) slog.Attr {
	if err == nil {
		return slog.Attr{}
	}
	attrs := []any{slog.String("message", err.Error())}

	// The concrete type distinguishes "connection refused" (*net.OpError) from "context
	// deadline exceeded" without parsing the message.
	if t := errType(err); t != "" {
		attrs = append(attrs, slog.String("type", t))
	}
	// A syscall errno (ECONNREFUSED, EHOSTUNREACH) is THE useful discriminator for an
	// unreachable pod, and it is buried two Unwraps deep in a net error.
	var errno syscall.Errno
	if errors.As(err, &errno) {
		attrs = append(attrs, slog.String("errno", errno.Error()))
	}
	if u := errors.Unwrap(err); u != nil {
		attrs = append(attrs, slog.String("cause", u.Error()))
	}
	return slog.Group("error", attrs...)
}

func errType(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "context.Canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "context.DeadlineExceeded"
	case errors.Is(err, io.EOF):
		return "io.EOF"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return "io.ErrUnexpectedEOF"
	}
	return ""
}
