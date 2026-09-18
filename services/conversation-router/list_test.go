package main

import (
	"encoding/json"
	"testing"
)

func sp(s string) *string { return &s }
func bp(b bool) *bool     { return &b }

// crMap is a crLookup backed by a fixed CR set — the test stand-in for the CRD watch cache, so
// assembleList's existence join can be driven without a live watch.
type crMap map[string]CRInfo

func (m crMap) CR(id string) (CRInfo, bool) { c, ok := m[id]; return c, ok }

func crsOf(crs []CRInfo) crMap {
	m := crMap{}
	for _, c := range crs {
		m[c.ID] = c
	}
	return m
}

// assembleList is the whole GET /conversations body. These lock down the three ways it can go
// wrong: leaking an ended conversation (no CR), leaking someone else's under "mine", and getting
// the metadata⋈CR⋈links join wrong.
func TestAssembleList(t *testing.T) {
	metas := []ConversationRow{
		{ID: "a", ThreadID: "a", Title: "Alpha", CreatedAt: 100, LastActivityAt: 900, Owner: sp("alice"), Starred: bp(true)},
		{ID: "b", ThreadID: "b", Title: "Bravo", CreatedAt: 200, LastActivityAt: 800, Owner: sp("bob")},
		{ID: "ended", ThreadID: "ended", Title: "Ghost", CreatedAt: 300, LastActivityAt: 700, Owner: sp("alice")},
	}
	crs := []CRInfo{
		{ID: "a", Phase: "Assigned", SandboxRef: "conv-aa"},
		{ID: "b", Phase: "Suspended", SandboxRef: "conv-bb"},
		// no CR for "ended" — it was ended, so it must be omitted.
	}

	// statusForPhase is the phase->dot mapping the sidebar reads. Failed is terminal (the
	// zombie-repair escalation force-deleted the sandbox) and MUST NOT read as "running" —
	// the regression this locks down (a dead conversation showing the blue active dot).
	t.Run("statusForPhase maps each phase", func(t *testing.T) {
		for phase, want := range map[string]string{
			"Suspended": "suspended",
			"Failed":    "failed",
			"Assigned":  "running",
			"Pending":   "running",
			"":          "running",
		} {
			if got := statusForPhase(phase); got != want {
				t.Errorf("statusForPhase(%q) = %q, want %q", phase, got, want)
			}
		}
	})
	links := map[string][]Link{
		"a": {{Source: "github", ResourceType: "pull", URL: sp("http://x")}, {Source: "slack", ResourceType: "thread"}},
	}

	t.Run("all scope joins meta+CR+links, omits CR-less, sorts most-recently-active first", func(t *testing.T) {
		rows := assembleList(metas, crsOf(crs), links, 1000, "", "all")
		if len(rows) != 2 {
			t.Fatalf("want 2 rows (ended omitted), got %d", len(rows))
		}
		// The fixtures order createdAt and lastActivityAt OPPOSITELY on purpose, so this
		// pins which one the endpoint sorts on: a(activity 900) before b(800), even though
		// b was created later. Sorting on createdAt would invert it.
		if rows[0].ID != "a" || rows[1].ID != "b" {
			t.Fatalf("wrong order: %s,%s", rows[0].ID, rows[1].ID)
		}
		// phase->status: Assigned => running, Suspended => suspended.
		if rows[0].Status != "running" || rows[1].Status != "suspended" {
			t.Errorf("status mapping wrong: %q %q", rows[0].Status, rows[1].Status)
		}
		a := rows[0]
		if !a.Starred || a.IdleMs != 100 || a.AgeMs != 900 || a.Sandbox.Name != "conv-aa" {
			t.Errorf("row a projection wrong: %+v", a)
		}
		// links: distinct sorted sources, full link list.
		if len(a.Sources) != 2 || a.Sources[0] != "github" || a.Sources[1] != "slack" {
			t.Errorf("sources wrong: %v", a.Sources)
		}
		if len(a.Links) != 2 {
			t.Errorf("links not attached: %v", a.Links)
		}
		// a conversation with no links gets empty (non-null) arrays. b is the link-less one.
		if rows[1].Sources == nil || rows[1].Links == nil {
			t.Errorf("empty enrichment must be [] not null: %+v", rows[1])
		}
	})

	// Bulk-migrated rows share a last_activity_at. Without the createdAt tiebreak their relative
	// order is arbitrary, so the sidebar reshuffles between polls.
	t.Run("rows sharing a lastActivityAt fall back to newest-created", func(t *testing.T) {
		tied := []ConversationRow{
			{ID: "old", ThreadID: "old", Title: "Old", CreatedAt: 100, LastActivityAt: 500},
			{ID: "new", ThreadID: "new", Title: "New", CreatedAt: 300, LastActivityAt: 500},
			{ID: "mid", ThreadID: "mid", Title: "Mid", CreatedAt: 200, LastActivityAt: 500},
		}
		rows := assembleList(tied, allExisting{}, nil, 1000, "", "all")
		if len(rows) != 3 {
			t.Fatalf("want 3 rows, got %d", len(rows))
		}
		if rows[0].ID != "new" || rows[1].ID != "mid" || rows[2].ID != "old" {
			t.Fatalf("tiebreak should be newest-created: %s,%s,%s", rows[0].ID, rows[1].ID, rows[2].ID)
		}
	})

	t.Run("mine scope shows only the caller's own", func(t *testing.T) {
		rows := assembleList(metas, crsOf(crs), links, 1000, "alice", "mine")
		if len(rows) != 1 || rows[0].ID != "a" {
			t.Fatalf("mine should show only alice's live conv, got %+v", rows)
		}
	})

	t.Run("anonymous caller sees everyone under mine", func(t *testing.T) {
		rows := assembleList(metas, crsOf(crs), links, 1000, "", "mine")
		if len(rows) != 2 {
			t.Fatalf("anonymous sees all, got %d", len(rows))
		}
	})
}

// The JSON must match agent-host's contract: userTitled/starred always present as booleans, and
// a nil model/owner/parentId omitted (not null) — the UI reads these verbatim.
func TestListRowJSONShape(t *testing.T) {
	rows := assembleList(
		[]ConversationRow{{ID: "x", ThreadID: "x", Title: "X", CreatedAt: 1, LastActivityAt: 2}},
		crsOf([]CRInfo{{ID: "x", Phase: "Assigned"}}),
		nil, 10, "", "all",
	)
	b, _ := json.Marshal(rows[0])
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["starred"]; !ok {
		t.Error("starred must always be present")
	}
	if _, ok := m["userTitled"]; !ok {
		t.Error("userTitled must always be present")
	}
	if _, ok := m["model"]; ok {
		t.Error("nil model must be omitted, not null")
	}
	if s, ok := m["sandbox"].(map[string]any); !ok || s["namespace"] != "" {
		t.Errorf("sandbox projection wrong: %v", m["sandbox"])
	}
}
