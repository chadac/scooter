// The conversation LIST, served by the router directly from Postgres instead of fanning out to
// every agent-host pod and merging their in-memory views. The merge is what let a stale per-pod
// copy flap `starred` between polls; reading the durable store once removes both the fan-out and
// the divergence. Only the JSON GET /conversations moves here — the /conversations/events SSE
// stream stays fed by each owning host (live changes come from the pod that owns the
// conversation), which the router still aggregates.
//
// The row is assembled the same way agent-host's old listAll() did: Postgres metadata
// (title/star/owner/timestamps) ⋈ the Conversation CR (EXISTENCE + phase→status + sandbox).
// The CR is the source of truth for existence — a metadata row with no CR was ended, so it is
// omitted rather than resurrected as a ghost.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"time"
)

type sandboxProjection struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// listRow is the exact shape agent-host's view()+withSources returns, so the router is a drop-in
// for the same endpoint (the UI merge reads these fields verbatim).
type listRow struct {
	ID             string            `json:"id"`
	ThreadID       string            `json:"threadId"`
	Status         string            `json:"status"`
	Title          string            `json:"title"`
	CreatedAt      int64             `json:"createdAt"`
	LastActivityAt int64             `json:"lastActivityAt"`
	IdleMs         int64             `json:"idleMs"`
	AgeMs          int64             `json:"ageMs"`
	Model          *string           `json:"model,omitempty"`
	Owner          *string           `json:"owner,omitempty"`
	ParentID       *string           `json:"parentId,omitempty"`
	UserTitled     bool              `json:"userTitled"`
	Starred        bool              `json:"starred"`
	Sandbox        sandboxProjection `json:"sandbox"`
	Sources        []string          `json:"sources"`
	Links          []Link            `json:"links"`
}

// assembleList joins metadata with the CR existence set, applies the visibility filter, enriches
// with links, and sorts newest-first — the whole GET /conversations body, as a pure function so
// it is unit-testable without a DB or a live watch.
func assembleList(metas []ConversationRow, crs []CRInfo, links map[string][]Link, now int64, callerOwner, scope string) []listRow {
	crByID := make(map[string]CRInfo, len(crs))
	for _, cr := range crs {
		crByID[cr.ID] = cr
	}
	rows := make([]listRow, 0, len(metas))
	for _, m := range metas {
		cr, ok := crByID[m.ID]
		if !ok {
			continue // EXISTENCE follows the CR: no CR => ended => omit.
		}
		if !visible(m.Owner, callerOwner, scope) {
			continue
		}
		// phase drives status uniformly (Suspended => suspended, everything else => running) —
		// the same mapping every pod used, which is what made the list consistent.
		status := "running"
		if cr.Phase == "Suspended" {
			status = "suspended"
		}
		ls := links[m.ID]
		if ls == nil {
			ls = []Link{}
		}
		rows = append(rows, listRow{
			ID:             m.ID,
			ThreadID:       m.ThreadID,
			Status:         status,
			Title:          m.Title,
			CreatedAt:      m.CreatedAt,
			LastActivityAt: m.LastActivityAt,
			IdleMs:         nonNeg(now - m.LastActivityAt),
			AgeMs:          nonNeg(now - m.CreatedAt),
			Model:          m.Model,
			Owner:          m.Owner,
			ParentID:       m.ParentID,
			UserTitled:     deref(m.UserTitled),
			Starred:        deref(m.Starred),
			// namespace is "" to match the old projection; the UI list ignores sandbox, and the
			// owner pod's GET /conversations/:id carries the live sandbox detail when needed.
			Sandbox: sandboxProjection{Name: cr.SandboxRef, Namespace: ""},
			Sources: sourcesOf(ls),
			Links:   ls,
		})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].CreatedAt > rows[j].CreatedAt })
	return rows
}

// visible mirrors agent-host's visibleFilter: scope=all or an anonymous caller sees everything;
// a known caller under the default "mine" scope sees strictly their own conversations.
func visible(owner *string, callerOwner, scope string) bool {
	if scope == "all" || callerOwner == "" {
		return true
	}
	return owner != nil && *owner == callerOwner
}

// sourcesOf is the distinct, sorted provider set for a conversation's links (the sidebar's
// per-row provider filter/icons).
func sourcesOf(links []Link) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, l := range links {
		if _, ok := seen[l.Source]; ok {
			continue
		}
		seen[l.Source] = struct{}{}
		out = append(out, l.Source)
	}
	sort.Strings(out)
	return out
}

// serveConversationListFromStore serves GET /conversations from Postgres. Returns false WITHOUT
// writing anything when it can't (no store configured, or a read error) so the caller falls back
// to the fleet aggregation — the router must never blank the sidebar just because the DB blipped.
func serveConversationListFromStore(w http.ResponseWriter, r *http.Request, store *Store, links *LinkStore, cache *OwnershipCache) bool {
	if store == nil {
		return false
	}
	log := logger("list")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	metas, err := store.Conversations(ctx)
	if err != nil {
		log.Warn("conversation list read failed; falling back to fleet aggregate", errAttr(err))
		return false
	}
	// Enrichment is best-effort: if the links DB is absent or errors, serve bare rows rather
	// than fail the whole list (agent-host degrades the same way when its link store is absent).
	linksByConv := map[string][]Link{}
	if links != nil {
		if lm, err := links.LinksByConversation(ctx); err != nil {
			log.Warn("link enrichment read failed; serving bare rows", errAttr(err))
		} else {
			linksByConv = lm
		}
	}

	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "mine"
	}
	rows := assembleList(metas, cache.ListCRs(), linksByConv, time.Now().UnixMilli(), ownerFrom(r), scope)

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(rows); err != nil {
		log.Warn("conversation list encode failed", errAttr(err), slog.Int("rows", len(rows)))
	}
	return true
}

func nonNeg(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

func deref(b *bool) bool { return b != nil && *b }
