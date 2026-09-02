package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"syscall"
)

// THE FALSE-ERROR BUG.
//
// httputil.ReverseProxy calls its ErrorHandler for TWO categorically different events, and the
// router used to log both at error:
//
//  1. the upstream is genuinely broken — dial refused, no route to host, a real 502; and
//  2. a stream ENDED normally — the SSE client navigated away, the WebSocket closed, the body
//     finished. The proxy surfaces those as context.Canceled or io.EOF.
//
// (2) is the overwhelming majority (~55/day on odin), and burying the real failures under it is
// exactly what made the real ones hard to find. So: classify first, then pick a level. A routine
// ending is logged at debug (there is nothing to act on), a real failure stays at error.
//
// THE SUBTLETY. context.Canceled means "somebody cancelled" — it does NOT by itself say who.
// A client hanging up is routine; the SERVER shutting down mid-request and cancelling in-flight
// work is not the same event and must not be silently downgraded to debug. Those are told apart
// by WHICH context was cancelled: the per-request context (r.Context(), cancelled by net/http
// when the client's connection drops) versus the process shutdown context. classifyProxyError
// takes the shutdown context explicitly and checks it first, so a shutdown-time cancellation is
// reported as a shutdown rather than mislabelled as a client disconnect.

// proxyErrorKind is why a proxied request ended.
type proxyErrorKind int

const (
	// proxyErrUpstream — a genuine proxy failure: dial refused, host unreachable, TLS error,
	// upstream timeout. The client gets a 502 and somebody should look at it.
	proxyErrUpstream proxyErrorKind = iota
	// proxyErrClientGone — the CLIENT went away (navigated off an SSE page, closed a WebSocket,
	// aborted a fetch). Routine. Nothing is broken and there is nobody left to send a 502 to.
	proxyErrClientGone
	// proxyErrStreamDone — the upstream body ended cleanly (io.EOF). Routine.
	proxyErrStreamDone
	// proxyErrShutdown — WE are terminating and cancelled the in-flight request. Not routine in
	// the same way a client disconnect is: it is expected during a rollout but is still the
	// server dropping somebody's request, so it is reported (at warn), not hidden.
	proxyErrShutdown
)

// classifyProxyError decides why a proxied request ended.
//
// shutdownCtx is the process-lifetime context (cancelled on SIGTERM/SIGINT); reqCtx is the
// per-request context (cancelled by net/http when the client's connection drops). Checking
// shutdown FIRST is what keeps a server-initiated cancellation from being misreported as a
// routine client disconnect — during shutdown BOTH contexts end up cancelled, so order decides.
func classifyProxyError(err error, shutdownCtx, reqCtx context.Context) proxyErrorKind {
	// A clean end of body. Never a failure — there is no such thing as a "502 EOF".
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return proxyErrStreamDone
	}

	if errors.Is(err, context.Canceled) {
		if shutdownCtx != nil && shutdownCtx.Err() != nil {
			return proxyErrShutdown
		}
		if reqCtx != nil && reqCtx.Err() != nil {
			return proxyErrClientGone
		}
		// Cancelled, but neither context we hold is done — a cancellation from deeper in the
		// stack (an inner per-attempt context). Nothing is unreachable, so it is not an
		// upstream failure; treat as a client-side ending rather than crying 502.
		return proxyErrClientGone
	}

	// The client's TCP connection died under us mid-stream. net/http reports this as a reset or
	// a broken pipe on the WRITE side; both mean "the reader left", not "the upstream broke".
	// ErrAbortHandler is what a hijacked/aborted (WebSocket) handler panics with.
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, http.ErrAbortHandler) {
		return proxyErrClientGone
	}

	// Anything else — including a DIAL failure (ECONNREFUSED / EHOSTUNREACH, the stale-pod-IP
	// case the retry exists for) and a DEADLINE (upstream too slow) — is a real failure.
	return proxyErrUpstream
}

// routine reports whether this ending needs no operator attention: a client that left or a
// stream that finished. Used to pick the log level, and to decide whether writing a 502 is even
// meaningful (it is not — nobody is listening).
func (k proxyErrorKind) routine() bool {
	return k == proxyErrClientGone || k == proxyErrStreamDone
}

// String is the `reason` field: one stable token per kind, so the ~55/day can be counted and
// alerted on separately from the real failures instead of sharing one bucket.
func (k proxyErrorKind) String() string {
	switch k {
	case proxyErrClientGone:
		return "client_disconnected"
	case proxyErrStreamDone:
		return "stream_finished"
	case proxyErrShutdown:
		return "server_shutdown"
	}
	return "upstream_failure"
}

// isDialFailure reports whether the error is a CONNECT failure — the upstream could not be
// reached at all. This is precisely the case the fallback retry exists for (a stale owner pod
// IP after the pod was replaced), and it is distinguishable from an upstream that accepted the
// connection and then misbehaved.
func isDialFailure(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	return errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.ETIMEDOUT)
}
