package main

import "testing"

// In dev mode every metadata row is a real conversation (no CRs, no controller), so assembleList
// under allExisting must keep ALL rows — the opposite of the cluster join, which omits a row whose
// CR it has not seen. This is the seam that would otherwise render an always-empty sidebar in the
// kube-less stack.
func TestAllExistingKeepsEveryRow(t *testing.T) {
	metas := []ConversationRow{
		{ID: "a", ThreadID: "a", Title: "A", CreatedAt: 100, LastActivityAt: 100},
		{ID: "b", ThreadID: "b", Title: "B", CreatedAt: 200, LastActivityAt: 200},
	}
	rows := assembleList(metas, allExisting{}, nil, 1000, "", "all")
	if len(rows) != 2 {
		t.Fatalf("allExisting must keep every row, got %d", len(rows))
	}
	// No CR => blank sandbox + the makeListRow "running" default (there are no suspended CRs in dev).
	for _, r := range rows {
		if r.Status != "running" || r.Sandbox.Name != "" {
			t.Errorf("dev row projection wrong: %+v", r)
		}
	}
}

// allExisting answers true for ANY id (existence == "the store knows it"), unlike the cache which
// only knows observed CRs.
func TestAllExistingAnyID(t *testing.T) {
	if _, ok := (allExisting{}).CR("never-seen"); !ok {
		t.Fatal("allExisting must treat any id as existing")
	}
}

// devRowArgs is the create spec -> conversations-row projection. Locks down which spec keys map to
// which nullable columns, and that "" / a missing key become a NULL (nil), not an empty string.
func TestDevRowArgs(t *testing.T) {
	id, now, title, model, owner, parent := devRowArgs("conv-1", map[string]interface{}{
		"owner":    "alice",
		"model":    "model-fast",
		"parentId": "",
		"title":    "Seeded one",
	}, 4242)
	if id != "conv-1" || now != 4242 {
		t.Fatalf("id/now wrong: %s %d", id, now)
	}
	if title != "Seeded one" {
		t.Errorf("title should map through: %q", title)
	}
	if owner == nil || *owner != "alice" {
		t.Errorf("owner should map through: %v", owner)
	}
	if model == nil || *model != "model-fast" {
		t.Errorf("model should map through: %v", model)
	}
	if parent != nil {
		t.Errorf("empty parentId must be NULL (nil), got %q", *parent)
	}

	// A bare spec (top-level create, no owner/model/title): title is "" (NOT NULL column) and the
	// three nullable columns are NULL.
	_, _, title, model, owner, parent = devRowArgs("conv-2", map[string]interface{}{}, 1)
	if title != "" {
		t.Errorf("bare spec title must be empty string, got %q", title)
	}
	if model != nil || owner != nil || parent != nil {
		t.Errorf("bare spec must be all-NULL, got model=%v owner=%v parent=%v", model, owner, parent)
	}
}
