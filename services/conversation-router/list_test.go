package main

import (
	"encoding/json"
	"testing"
)

func sp(s string) *string { return &s }
func bp(b bool) *bool     { return &b }

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
	links := map[string][]Link{
		"a": {{Source: "github", ResourceType: "pull", URL: sp("http://x")}, {Source: "slack", ResourceType: "thread"}},
	}

	t.Run("all scope joins meta+CR+links, omits CR-less, sorts newest-first", func(t *testing.T) {
		rows := assembleList(metas, crs, links, 1000, "", "all")
		if len(rows) != 2 {
			t.Fatalf("want 2 rows (ended omitted), got %d", len(rows))
		}
		// newest createdAt first: b(200) before a(100).
		if rows[0].ID != "b" || rows[1].ID != "a" {
			t.Fatalf("wrong order: %s,%s", rows[0].ID, rows[1].ID)
		}
		// phase->status: Suspended => suspended, Assigned => running.
		if rows[0].Status != "suspended" || rows[1].Status != "running" {
			t.Errorf("status mapping wrong: %q %q", rows[0].Status, rows[1].Status)
		}
		a := rows[1]
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
		// a conversation with no links gets empty (non-null) arrays.
		if rows[0].Sources == nil || rows[0].Links == nil {
			t.Errorf("empty enrichment must be [] not null: %+v", rows[0])
		}
	})

	t.Run("mine scope shows only the caller's own", func(t *testing.T) {
		rows := assembleList(metas, crs, links, 1000, "alice", "mine")
		if len(rows) != 1 || rows[0].ID != "a" {
			t.Fatalf("mine should show only alice's live conv, got %+v", rows)
		}
	})

	t.Run("anonymous caller sees everyone under mine", func(t *testing.T) {
		rows := assembleList(metas, crs, links, 1000, "", "mine")
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
		[]CRInfo{{ID: "x", Phase: "Assigned"}},
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
