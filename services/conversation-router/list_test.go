package main

import (
	"encoding/json"
	"testing"
)

func sp(s string) *string { return &s }
func bp(b bool) *bool     { return &b }

// assembleList is the whole GET /conversations body: visibility under "mine" and the metadata-links join.
func TestAssembleList(t *testing.T) {
	metas := []ConversationRow{
		{ID: "a", ThreadID: "a", Title: "Alpha", CreatedAt: 100, LastActivityAt: 900, Owner: sp("alice"),
			Phase: sp("Assigned"), SandboxRef: sp("conv-aa")},
		{ID: "b", ThreadID: "b", Title: "Bravo", CreatedAt: 200, LastActivityAt: 800, Owner: sp("bob"),
			Phase: sp("Suspended"), SandboxRef: sp("conv-bb")},
	}

	// Failed is terminal and must not read as "running".
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

	t.Run("all scope joins meta+links and preserves input order", func(t *testing.T) {
		rows := assembleList(metas, links, 1000, "", "all")
		if len(rows) != 2 {
			t.Fatalf("want 2 rows, got %d", len(rows))
		}
		// The order is the store's, and a and b must come out as they arrived.
		if rows[0].ID != "a" || rows[1].ID != "b" {
			t.Fatalf("wrong order: %s,%s", rows[0].ID, rows[1].ID)
		}
		// Assigned maps to running, Suspended to suspended.
		if rows[0].Status != "running" || rows[1].Status != "suspended" {
			t.Errorf("status mapping wrong: %q %q", rows[0].Status, rows[1].Status)
		}
		a := rows[0]
		if a.IdleMs != 100 || a.AgeMs != 900 || a.Sandbox.Name != "conv-aa" {
			t.Errorf("row a projection wrong: %+v", a)
		}
		// Distinct sorted sources, full link list.
		if len(a.Sources) != 2 || a.Sources[0] != "github" || a.Sources[1] != "slack" {
			t.Errorf("sources wrong: %v", a.Sources)
		}
		if len(a.Links) != 2 {
			t.Errorf("links not attached: %v", a.Links)
		}
		// A conversation with no links gets empty, non-null arrays.
		if rows[1].Sources == nil || rows[1].Links == nil {
			t.Errorf("empty enrichment must be [] not null: %+v", rows[1])
		}
	})

	// Feed an order that matches neither timestamp and require it back verbatim.
	t.Run("does not reorder: input order is returned verbatim", func(t *testing.T) {
		scrambled := []ConversationRow{
			{ID: "m", ThreadID: "m", Title: "M", CreatedAt: 200, LastActivityAt: 500},
			{ID: "z", ThreadID: "z", Title: "Z", CreatedAt: 900, LastActivityAt: 100},
			{ID: "q", ThreadID: "q", Title: "Q", CreatedAt: 100, LastActivityAt: 900},
		}
		rows := assembleList(scrambled, nil, 1000, "", "all")
		if len(rows) != 3 {
			t.Fatalf("want 3 rows, got %d", len(rows))
		}
		for i, want := range []string{"m", "z", "q"} {
			if rows[i].ID != want {
				t.Fatalf("assembleList reordered rows: got %s,%s,%s", rows[0].ID, rows[1].ID, rows[2].ID)
			}
		}
	})

	t.Run("mine scope shows only the caller's own", func(t *testing.T) {
		rows := assembleList(metas, links, 1000, "alice", "mine")
		if len(rows) != 1 || rows[0].ID != "a" {
			t.Fatalf("mine should show only alice's live conv, got %+v", rows)
		}
	})

	t.Run("anonymous caller sees everyone under mine", func(t *testing.T) {
		rows := assembleList(metas, links, 1000, "", "mine")
		if len(rows) != 2 {
			t.Fatalf("anonymous sees all, got %d", len(rows))
		}
	})
}

// The JSON must match agent-host's contract: userTitled/starred always present, and a nil model/owner/parentId omitted rather than null.
func TestListRowJSONShape(t *testing.T) {
	rows := assembleList(
		[]ConversationRow{{ID: "x", ThreadID: "x", Title: "X", CreatedAt: 1, LastActivityAt: 2, Phase: sp("Assigned")}},
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

// A subagent is a conversation with a parent, and the UI's nesting keys off `parentId` arriving on a listed row.
func TestAssembleListSubagent(t *testing.T) {
	metas := []ConversationRow{
		{ID: "parent", ThreadID: "parent", Title: "Parent", CreatedAt: 100, LastActivityAt: 900, Owner: sp("alice"),
			Phase: sp("Assigned"), SandboxRef: sp("conv-p")},
		// A subagent inherits its parent's owner, carries parentId, and shares the parent's sandbox.
		{ID: "sub", ThreadID: "sub", Title: "research", CreatedAt: 200, LastActivityAt: 800, Owner: sp("alice"),
			ParentID: sp("parent"), Phase: sp("Assigned"), SandboxRef: sp("conv-p")},
	}

	t.Run("a subagent is listed and carries parentId", func(t *testing.T) {
		rows := assembleList(metas, nil, 1000, "alice", "mine")
		if len(rows) != 2 {
			t.Fatalf("parent + subagent must both be listed, got %d", len(rows))
		}
		sub := rows[1]
		if sub.ParentID == nil {
			t.Fatal("a subagent row must carry parentId; without it the UI renders it as a top-level chat")
		}
		if *sub.ParentID != "parent" {
			t.Errorf("parentId = %q, want %q", *sub.ParentID, "parent")
		}
		if sub.Sandbox.Name != rows[0].Sandbox.Name {
			t.Errorf("a subagent shares its parent's sandbox: %q vs %q", sub.Sandbox.Name, rows[0].Sandbox.Name)
		}
	})

	t.Run("parentId survives JSON as the UI reads it", func(t *testing.T) {
		rows := assembleList(metas, nil, 1000, "", "all")
		b, _ := json.Marshal(rows[1])
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		if m["parentId"] != "parent" {
			t.Errorf("serialized parentId = %v, want \"parent\"", m["parentId"])
		}
		// A top-level row must omit it rather than send null, since the UI treats any present parentId as a subagent.
		b0, _ := json.Marshal(rows[0])
		var m0 map[string]any
		_ = json.Unmarshal(b0, &m0)
		if _, ok := m0["parentId"]; ok {
			t.Error("a top-level conversation must OMIT parentId, not send null")
		}
	})

	t.Run("a subagent is not hidden from its owner under mine", func(t *testing.T) {
		// The subagent inherits the parent's owner, so "mine" must show both.
		rows := assembleList(metas, nil, 1000, "alice", "mine")
		var sawSub bool
		for _, r := range rows {
			if r.ID == "sub" {
				sawSub = true
			}
		}
		if !sawSub {
			t.Error("a subagent owned by the caller must appear under scope=mine")
		}
	})
}
