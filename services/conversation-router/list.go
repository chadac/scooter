// The conversation list, served directly from Postgres. Every field the response needs is
// a column on `conversations`, so the list makes no Kubernetes read and a CR-versus-row
// disagreement has nowhere to live; existence is the row's own existence, which end()
// deletes.
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

// listRow is the exact shape agent-host's view()+withSources returns, which the UI merge reads verbatim.
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
	// Set while a run is in flight (ms epoch); the sidebar shows it as "active".
	RunStartedAt *int64 `json:"runStartedAt,omitempty"`
	// When the last run ended (ms epoch); the UI derives "unread" from it.
	LastReplyAt *int64 `json:"lastReplyAt,omitempty"`
	// Set while the agent waits on the user's answer (ms epoch); the sidebar shows it as "!".
	AwaitingInputAt *int64 `json:"awaitingInputAt,omitempty"`
	// "shared" or "private"; the sidebar shows a lock for private.
	Visibility string `json:"visibility"`
	// "subagent" or "session"; absent for a top-level conversation.
	Kind *string `json:"kind,omitempty"`
}

// assembleList applies the visibility filter and enriches with links, preserving the order of metas that Store.Conversations establishes.
func assembleList(metas []ConversationRow, links map[string][]Link, now int64, callerOwner, scope string) []listRow {
	rows := make([]listRow, 0, len(metas))
	for _, m := range metas {
		if !visible(m.Owner, m.Visibility, callerOwner, scope) {
			continue
		}
		rows = append(rows, makeListRow(m, links[m.ID], now))
	}
	return rows
}

// statusForPhase maps status.phase to the sidebar dot state: Suspended and Failed are distinguished, and Pending, Assigned and "" are "running".
func statusForPhase(phase string) string {
	switch phase {
	case "Suspended":
		return "suspended"
	case "Failed":
		return "failed"
	default:
		return "running"
	}
}

// makeListRow projects one metadata row and its links into the wire shape, shared by the snapshot and the live upsert so both emit byte-identical rows.
func makeListRow(m ConversationRow, ls []Link, now int64) listRow {
	// A NULL phase means no writer has reached this row yet, which maps to "running".
	phase := ""
	if m.Phase != nil {
		phase = *m.Phase
	}
	status := statusForPhase(phase)
	if ls == nil {
		ls = []Link{}
	}
	return listRow{
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
		Visibility:     visibilityOf(m.Visibility),
		ParentID:       m.ParentID,
		Kind:           m.Kind,
		UserTitled:     deref(m.UserTitled),
		// The UI list ignores sandbox; the owner pod's GET /conversations/:id carries the live detail.
		Sandbox:         sandboxProjection{Name: derefStr(m.SandboxRef), Namespace: ""},
		Sources:         sourcesOf(ls),
		Links:           ls,
		RunStartedAt:    m.RunStartedAt,
		LastReplyAt:     m.LastReplyAt,
		AwaitingInputAt: m.AwaitingInputAt,
	}
}

// listScope reads the ?scope= filter shared by GET /conversations and its events stream, defaulting to "mine".
func listScope(r *http.Request) string {
	if s := r.URL.Query().Get("scope"); s != "" {
		return s
	}
	return "mine"
}

// visible mirrors agent-host's visibleFilter: scope=all or an anonymous caller sees every shared row, a known caller under "mine" sees only their own, and a private row only its owner.
func visible(owner *string, visibility, callerOwner, scope string) bool {
	if !canAccess(owner, visibility, callerOwner) {
		return false
	}
	if scope == "all" || callerOwner == "" {
		return true
	}
	return owner != nil && *owner == callerOwner
}

// sourcesOf is the distinct, sorted provider set for a conversation's links.
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

// serveConversationList serves GET /conversations from Postgres; a read error yields 503 rather than an empty 200, and link enrichment is best-effort.
func serveConversationList(w http.ResponseWriter, r *http.Request, store *Store, links *LinkStore) {
	log := logger("list")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	metas, err := store.Conversations(ctx)
	if err != nil {
		log.Warn("conversation list read failed", errAttr(err))
		http.Error(w, "conversation store read failed", http.StatusServiceUnavailable)
		return
	}
	linksByConv := map[string][]Link{}
	if links != nil {
		if lm, err := links.LinksByConversation(ctx); err != nil {
			log.Warn("link enrichment read failed; serving bare rows", errAttr(err))
		} else {
			linksByConv = lm
		}
	}

	rows := assembleList(metas, linksByConv, time.Now().UnixMilli(), ownerFrom(r), listScope(r))

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(rows); err != nil {
		log.Warn("conversation list encode failed", errAttr(err), slog.Int("rows", len(rows)))
	}
}

func nonNeg(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

func deref(b *bool) bool { return b != nil && *b }

// derefStr reads a nullable text column as "".
func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
