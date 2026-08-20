// Package main — FLEET AGGREGATION for endpoints that must see every conversation.
//
// Why this exists: an agent-host answers GET /conversations from its IN-MEMORY session map, which
// holds only the conversations THAT pod currently hosts. With podCap=1 the controller deliberately
// spreads conversations one-per-pod, so proxying the list to a single pod returns a fraction of the
// user's conversations — and WHICH fraction changes with load-balancing, so conversations appear to
// vanish and reappear between refreshes. (Observed on odin: per-pod counts 0,2,2,4,4,4,7,7,8,8 while
// 20 Conversation CRs existed.)
//
// So the router fans these requests out to every owner pod it knows about and merges the results:
//   - JSON list  (GET /conversations)        -> concatenate, de-dupe by id, newest first
//   - SSE stream (GET /conversations/events) -> multiplex every pod's frames onto one response
//
// PARTIAL FAILURE IS NOT FATAL. A pod that errors or times out is skipped with a log line: a
// degraded (smaller) list is strictly better than a 502 that blanks the sidebar entirely. That is
// the same "never make the user's data look lost" principle the bug itself violated.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// aggregateTimeout bounds ONE pod's contribution to a fan-out list request. Generous enough for a
// loaded pod, short enough that one sick pod can't hang the sidebar.
const aggregateTimeout = 10 * time.Second

// upstreamsFor returns the base URLs to fan a request out to: every owner pod the cache knows,
// falling back to the ClusterIP Service when the cache is empty (single-replica / cold start), so
// behaviour degrades to exactly the pre-aggregation path rather than returning nothing.
func upstreamsFor(cfg config, cache *OwnershipCache, fallback *url.URL) []*url.URL {
	hosts := cache.Hosts()
	if len(hosts) == 0 {
		return []*url.URL{fallback}
	}
	out := make([]*url.URL, 0, len(hosts))
	for _, ip := range hosts {
		out = append(out, TargetURL(ip, cfg.upstreamPort))
	}
	return out
}

// serveAggregatedList fans GET /conversations out to every upstream, merges the JSON arrays,
// de-dupes by conversation id, and writes one array newest-first.
func serveAggregatedList(w http.ResponseWriter, r *http.Request, ups []*url.URL) {
	type row = map[string]any

	var (
		mu      sync.Mutex
		merged  []row
		wg      sync.WaitGroup
		okCount int
	)
	for _, u := range ups {
		wg.Add(1)
		go func(u *url.URL) {
			defer wg.Done()
			rows, err := fetchList(r, u)
			if err != nil {
				// Degrade, don't fail: one unreachable pod must not blank the whole sidebar.
				logf("aggregate: %s failed (%v) — skipping, list will be partial", u.Host, err)
				return
			}
			mu.Lock()
			merged = append(merged, rows...)
			okCount++
			mu.Unlock()
		}(u)
	}
	wg.Wait()

	// De-dupe by id. A conversation can legitimately appear on two pods during a reassignment
	// hand-off; without this the UI would render it twice.
	seen := make(map[string]struct{}, len(merged))
	uniq := make([]row, 0, len(merged))
	for _, c := range merged {
		id, _ := c["id"].(string)
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		uniq = append(uniq, c)
	}
	// Newest first — the same order a single pod returns, so the UI is unchanged.
	sort.SliceStable(uniq, func(i, j int) bool {
		return numField(uniq[i], "lastActivityAt") > numField(uniq[j], "lastActivityAt")
	})

	if okCount == 0 && len(ups) > 0 {
		// EVERY upstream failed — that is a real outage, not a partial view. Say so rather than
		// returning an empty array the UI would render as "you have no conversations".
		http.Error(w, "all agent-host replicas failed to answer the conversation list", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(uniq)
}

func numField(m map[string]any, k string) float64 {
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 0
}

// fetchList performs the upstream GET, forwarding the caller's identity headers so each pod applies
// the SAME per-user visibility filter it would for a direct request.
func fetchList(r *http.Request, u *url.URL) ([]map[string]any, error) {
	ctx, cancel := contextWithTimeout(r, aggregateTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String()+r.URL.RequestURI(), nil)
	if err != nil {
		return nil, err
	}
	copyIdentityHeaders(r, req)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream status %d", res.StatusCode)
	}
	var rows []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// serveAggregatedSSE multiplexes every upstream's /conversations/events stream onto ONE response, so
// the sidebar's live stream reflects the whole fleet instead of one pod's slice.
func serveAggregatedSSE(w http.ResponseWriter, r *http.Request, ups []*url.URL) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	var mu sync.Mutex // one writer at a time: frames must not interleave mid-frame
	var wg sync.WaitGroup
	for _, u := range ups {
		wg.Add(1)
		go func(u *url.URL) {
			defer wg.Done()
			req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String()+r.URL.RequestURI(), nil)
			if err != nil {
				return
			}
			copyIdentityHeaders(r, req)
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				logf("aggregate SSE: %s failed (%v) — that pod's updates will be missing", u.Host, err)
				return
			}
			defer res.Body.Close()
			sc := bufio.NewScanner(res.Body)
			sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
			for sc.Scan() {
				line := sc.Text()
				mu.Lock()
				_, werr := io.WriteString(w, line+"\n")
				if line == "" { // frame boundary
					flusher.Flush()
				}
				mu.Unlock()
				if werr != nil {
					return // client hung up
				}
			}
		}(u)
	}
	wg.Wait()
}

// contextWithTimeout derives a bounded context from the request, so one slow pod cannot hold the
// whole fan-out open (and so a client disconnect cancels every upstream call).
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

// copyIdentityHeaders forwards the headers an agent-host uses to identify the caller, so each pod
// applies the SAME per-user visibility filter it would for a direct request. Without this the
// fan-out could return conversations the caller is not entitled to see.
func copyIdentityHeaders(src *http.Request, dst *http.Request) {
	for k, vs := range src.Header {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-auth-") || strings.HasPrefix(lk, "x-amzn-oidc-") ||
			lk == "authorization" || lk == "cookie" || lk == "accept" {
			for _, v := range vs {
				dst.Header.Add(k, v)
			}
		}
	}
}
