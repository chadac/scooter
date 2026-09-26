package main

import "testing"

// EXISTENCE IS THE ROW. This used to be the dev stack's special case (allExisting) against a
// cluster path that joined a CRD watch cache and omitted any row it had no CR for. Both stacks run
// this one rule now, so the kube-less e2e suite exercises the same list code production does.
//
// A row with NULL sandbox_ref, under noPhase, is the kube-less stack's normal shape — the projection
// must match what a CR with no phase and no sandboxRef produced: status "running", empty sandbox name.
func TestListsWhateverRowsExist(t *testing.T) {
	metas := []ConversationRow{
		{ID: "a", ThreadID: "a", Title: "A", CreatedAt: 100, LastActivityAt: 100},
		{ID: "b", ThreadID: "b", Title: "B", CreatedAt: 200, LastActivityAt: 200},
	}
	rows := assembleList(metas, noPhase{}, nil, 1000, "", "all")
	if len(rows) != 2 {
		t.Fatalf("every existing row must be listed, got %d", len(rows))
	}
	for _, r := range rows {
		if r.Status != "running" || r.Sandbox.Name != "" {
			t.Errorf("no phase + NULL sandbox_ref must project as running + blank sandbox: %+v", r)
		}
	}
}

// conversationRowArgs is the create -> conversations-row projection (shared by both stacks). Locks down which fields map to which
// nullable columns, that "" / a missing key become a NULL (nil) rather than an empty string, and
// that the title comes from the create itself — it is not, and must not be, a spec key.
func TestConversationRowArgs(t *testing.T) {
	id, now, title, model, owner, parent := conversationRowArgs(NewConversation{
		Name:  "conv-1",
		Title: "Seeded one",
		Spec: map[string]interface{}{
			"owner":    "alice",
			"model":    "model-fast",
			"parentId": "",
		},
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
	_, _, title, model, owner, parent = conversationRowArgs(NewConversation{Name: "conv-2", Spec: map[string]interface{}{}}, 1)
	if title != "" {
		t.Errorf("bare spec title must be empty string, got %q", title)
	}
	if model != nil || owner != nil || parent != nil {
		t.Errorf("bare spec must be all-NULL, got model=%v owner=%v parent=%v", model, owner, parent)
	}

	// A title smuggled into the spec is NOT a title. The spec is the CR's, and the CR has no
	// such field — the apiserver prunes it, so anything that read it there would be reading a
	// value production never stores.
	_, _, title, _, _, _ = conversationRowArgs(NewConversation{
		Name: "conv-3",
		Spec: map[string]interface{}{"title": "from the spec"},
	}, 1)
	if title != "" {
		t.Errorf("spec[title] must not become the row title, got %q", title)
	}
}
