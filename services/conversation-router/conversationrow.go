// The create-time `conversations` row, shared by both stacks.
//
// These primitives used to live in devmode.go because only the kube-less stack wrote a row; the
// cluster path wrote a CR and nothing else. Production now writes BOTH (see dualCreator), so the
// row shape has to have ONE definition — otherwise the two stacks drift on what a new conversation
// looks like, and the kube-less e2e suite stops being evidence about production. Why: PR #654.
package main

// insertConversationSQL is that one definition. thread_id == id by construction (create.go mints a
// single id that is both). ON CONFLICT DO NOTHING keeps a retry or a double-create idempotent. The
// INSERT fires the conversations_changed trigger, so the router's own LISTEN loop pushes the new
// row to the sidebar without anyone having to publish it.
const insertConversationSQL = `
	INSERT INTO conversations
	  (id, thread_id, title, created_at, last_activity_at, model, owner, parent_id)
	VALUES ($1, $1, $2, $3, $3, $4, $5, $6)
	ON CONFLICT (id) DO NOTHING`

// conversationRowArgs projects a create into the row's columns, in insertConversationSQL's order.
// Pure, so the mapping (which create field becomes which column) is unit-testable without a
// database. title comes from the create itself, NOT from the spec map — the spec is the CR's, and
// the CR has no title field. It is a plain string because the column is NOT NULL (absent becomes
// "", not NULL); the nullable columns go through specString.
func conversationRowArgs(c NewConversation, now int64) (rowID string, createdAt int64, title string, model, owner, parent *string) {
	return c.Name, now, c.Title, specString(c.Spec, "model"), specString(c.Spec, "owner"), specString(c.Spec, "parentId")
}

// specString reads a string spec value, treating "" and a non-string as absent (a NULL column).
func specString(spec map[string]interface{}, k string) *string {
	if v, ok := spec[k].(string); ok && v != "" {
		return &v
	}
	return nil
}
