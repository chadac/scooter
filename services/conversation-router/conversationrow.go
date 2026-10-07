// The create-time `conversations` row, shared by both stacks.
//
// ONE definition of the row shape, for both writers: the cluster path (dualCreator, CR + row) and
// the kube-less path (devCreator, row alone). A second definition would let the two stacks disagree
// about what a new conversation looks like, and the kube-less e2e suite would stop being evidence
// about production. Why: PR #654.
package main

// insertConversationSQL is that one definition. thread_id == id by construction (create.go mints a
// single id that is both). ON CONFLICT DO NOTHING keeps a retry or a double-create idempotent. The
// INSERT fires the conversations_changed trigger, so the router's own LISTEN loop pushes the new
// row to the sidebar without anyone having to publish it.
//
// sandbox_ref is SET for a subagent, NULL for top-level.
const insertConversationSQL = `
	INSERT INTO conversations
	  (id, thread_id, title, created_at, last_activity_at, model, owner, parent_id, sandbox_ref)
	VALUES ($1, $1, $2, $3, $3, $4, $5, $6, $7)
	ON CONFLICT (id) DO NOTHING`

// conversationRow is the row projection; args() alone fixes order.
type conversationRow struct {
	ID    string
	Title string
	// Fills created_at AND last_activity_at ($3 twice).
	Now        int64
	Model      *string
	Owner      *string
	ParentID   *string
	SandboxRef *string
}

// conversationRowOf is that projection, pure and so testable.
func conversationRowOf(c NewConversation, now int64) conversationRow {
	return conversationRow{
		ID:         c.Name,
		Title:      c.Title,
		Now:        now,
		Model:      specString(c.Spec, "model"),
		Owner:      specString(c.Spec, "owner"),
		ParentID:   specString(c.Spec, "parentId"),
		SandboxRef: specString(c.Spec, "sandboxRef"),
	}
}

// args binds the row to insertConversationSQL's placeholders, in order.
func (r conversationRow) args() []any {
	return []any{r.ID, r.Title, r.Now, r.Model, r.Owner, r.ParentID, r.SandboxRef}
}

// specString reads a string spec value, treating "" and a non-string as absent (a NULL column).
func specString(spec map[string]interface{}, k string) *string {
	if v, ok := spec[k].(string); ok && v != "" {
		return &v
	}
	return nil
}
