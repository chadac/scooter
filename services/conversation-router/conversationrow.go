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
// sandbox_ref is NULL for a top-level create (the host provisions the sandbox and patches the ref
// in later) and SET for a subagent, which inherits its parent's pod. The kube-less stack has no CR
// to converge the column from, so a subagent row that did not carry the ref at insert would never
// get one. Why: PR #726.
const insertConversationSQL = `
	INSERT INTO conversations
	  (id, thread_id, title, created_at, last_activity_at, model, owner, parent_id, sandbox_ref)
	VALUES ($1, $1, $2, $3, $3, $4, $5, $6, $7)
	ON CONFLICT (id) DO NOTHING`

// conversationRow is a create projected onto insertConversationSQL's columns. A struct rather than
// a positional tuple because args() below is then the ONE place that fixes column order: a new
// column cannot be added to the SQL and silently bound to the wrong parameter at one call site.
type conversationRow struct {
	ID    string
	Title string
	// Now fills created_at AND last_activity_at (one bind, $3 twice).
	Now        int64
	Model      *string
	Owner      *string
	ParentID   *string
	SandboxRef *string
}

// conversationRowOf projects a create onto the row's columns. Pure, so the mapping (which create
// field becomes which column) is unit-testable without a database. Title comes from the create
// itself, NOT from the spec map — the spec is the CR's, and the CR has no title field. It is a
// plain string because the column is NOT NULL (absent becomes "", not NULL); the nullable columns
// go through specString.
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
