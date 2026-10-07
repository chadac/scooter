package main

import "testing"

// EXISTENCE IS THE ROW — one rule, run by both stacks, which is what lets the kube-less e2e suite
// exercise the same list code production does. A dev-only substitute here (or a cluster-only join
// against a CRD watch cache) would break that.
//
// A row with NULL phase and NULL sandbox_ref is the kube-less stack's normal shape (nothing writes
// a phase where there is no controller) — the projection must match what a CR with no phase and no
// sandboxRef produced: status "running", empty sandbox name.
func TestListsWhateverRowsExist(t *testing.T) {
	metas := []ConversationRow{
		{ID: "a", ThreadID: "a", Title: "A", CreatedAt: 100, LastActivityAt: 100},
		{ID: "b", ThreadID: "b", Title: "B", CreatedAt: 200, LastActivityAt: 200},
	}
	rows := assembleList(metas, nil, 1000, "", "all")
	if len(rows) != 2 {
		t.Fatalf("every existing row must be listed, got %d", len(rows))
	}
	for _, r := range rows {
		if r.Status != "running" || r.Sandbox.Name != "" {
			t.Errorf("no phase + NULL sandbox_ref must project as running + blank sandbox: %+v", r)
		}
	}
}

// conversationRowOf maps create fields onto the row's nullable columns.
func TestConversationRowOf(t *testing.T) {
	r := conversationRowOf(NewConversation{
		Name:  "conv-1",
		Title: "Seeded one",
		Spec: map[string]interface{}{
			"owner":      "alice",
			"model":      "model-fast",
			"parentId":   "",
			"sandboxRef": "conv-abc123",
		},
	}, 4242)
	if r.ID != "conv-1" || r.Now != 4242 {
		t.Fatalf("id/now wrong: %s %d", r.ID, r.Now)
	}
	if r.Title != "Seeded one" {
		t.Errorf("title should map through: %q", r.Title)
	}
	if r.Owner == nil || *r.Owner != "alice" {
		t.Errorf("owner should map through: %v", r.Owner)
	}
	if r.Model == nil || *r.Model != "model-fast" {
		t.Errorf("model should map through: %v", r.Model)
	}
	if r.SandboxRef == nil || *r.SandboxRef != "conv-abc123" {
		t.Errorf("sandboxRef should map through: %v", r.SandboxRef)
	}
	if r.ParentID != nil {
		t.Errorf("empty parentId must be NULL (nil), got %q", *r.ParentID)
	}

	// A bare spec (top-level create, no owner/model/title): title is "" (NOT NULL column) and the
	// nullable columns are NULL.
	r = conversationRowOf(NewConversation{Name: "conv-2", Spec: map[string]interface{}{}}, 1)
	if r.Title != "" {
		t.Errorf("bare spec title must be empty string, got %q", r.Title)
	}
	if r.Model != nil || r.Owner != nil || r.ParentID != nil || r.SandboxRef != nil {
		t.Errorf("bare spec must be all-NULL, got %+v", r)
	}

	// A title smuggled into the spec is NOT a title. The spec is the CR's, and the CR has no
	// such field — the apiserver prunes it, so anything that read it there would be reading a
	// value production never stores.
	r = conversationRowOf(NewConversation{
		Name: "conv-3",
		Spec: map[string]interface{}{"title": "from the spec"},
	}, 1)
	if r.Title != "" {
		t.Errorf("spec[title] must not become the row title, got %q", r.Title)
	}
}

// args() alone fixes column order against the INSERT's placeholders.
func TestConversationRowArgsOrderMatchesTheInsert(t *testing.T) {
	owner, model, parent, ref := "alice", "model-fast", "conv-parent", "conv-abc123"
	args := conversationRow{
		ID: "conv-1", Title: "T", Now: 7,
		Model: &model, Owner: &owner, ParentID: &parent, SandboxRef: &ref,
	}.args()
	want := []any{"conv-1", "T", int64(7), &model, &owner, &parent, &ref}
	if len(args) != len(want) {
		t.Fatalf("want %d args, got %d", len(want), len(args))
	}
	for i := range want {
		if args[i] != want[i] {
			t.Errorf("arg %d: want %v, got %v", i+1, want[i], args[i])
		}
	}
}
