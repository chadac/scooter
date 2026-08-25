package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// CREATING A CONVERSATION IS A CONTROL-PLANE WRITE.
//
// It used to be served by the agent-host, which is a capacity-bounded fleet: the
// controller assigns a conversation to "the least-loaded ready pod under a per-pod
// cap" and, when none can take it, leaves it Pending (conversation-controller/
// reconcile.py:6-10). With N replicas x cap C, conversation N*C+1 could not be
// CREATED — the request had to land on a fleet with no room, and its id would be
// minted by the very component that could not host it.
//
// So the router creates the CR instead. It is always-on, already watches
// Conversations (cache.go), and consults no agent-host capacity. `Pending` becomes
// a normal, visible state: the conversation genuinely exists before it has a host,
// and the controller assigns one when capacity appears.
//
// Provisioning (the Sandbox pod) still happens in the agent-host — moving that is a
// separate migration. See todo/draft/ASYNC_CONVERSATION_CREATE.md.

// ConversationCreator creates a Conversation CR. Narrow on purpose: it keeps the
// route testable with a hand-written fake, with no new module dependency (the nix
// build pins vendorHash, so an added import means a hash bump).
type ConversationCreator interface {
	Create(ctx context.Context, name string, spec map[string]interface{}) error
}

// dynamicCreator is the production implementation, over the same dynamic client
// the ownership cache already uses.
type dynamicCreator struct {
	dyn       dynamic.Interface
	namespace string
}

func (d *dynamicCreator) Create(ctx context.Context, name string, spec map[string]interface{}) error {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": conversationGVR.Group + "/" + conversationGVR.Version,
		"kind":       "Conversation",
		"metadata":   map[string]interface{}{"name": name, "namespace": d.namespace},
		"spec":       spec,
	}}
	_, err := d.dyn.Resource(conversationGVR).Namespace(d.namespace).Create(ctx, obj, metav1.CreateOptions{})
	return err
}

// createRequest is the accepted body. Note there is no threadId: the server mints
// the conversation id (see todo/draft/SERVER_OWNS_CONVERSATION_IDS.md). A stray
// `threadId` key is simply ignored by encoding/json — the caller gets the id from
// the response either way.
type createRequest struct {
	Title    string `json:"title"`
	Model    string `json:"model"`
	ParentID string `json:"parentId"`
}

type createResponse struct {
	// The conversation id. It IS the thread id — manager.ts:648 sets
	// `const id: SessionId = threadId`, so they are the same value by
	// construction. This endpoint returns it once.
	ID        string `json:"id"`
	Status    string `json:"status"`
	Title     string `json:"title"`
	CreatedAt int64  `json:"createdAt"`
	Owner     string `json:"owner,omitempty"`
}

// IsConversationCreate reports whether this request should be handled here rather
// than proxied to an agent-host.
func IsConversationCreate(method, path string) bool {
	return method == http.MethodPost && strings.TrimSuffix(path, "/") == "/conversations"
}

// modelRe guards the one free-form field that reaches a CR spec. Conservative on
// purpose: the id is server-minted, so this is the only client-controlled string.
var modelRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// serveConversationCreate mints the id, writes the CR, and returns 201 immediately.
// It does NOT wait for assignment or provisioning — that is the whole point.
func serveConversationCreate(w http.ResponseWriter, r *http.Request, creator ConversationCreator, owner string) {
	var req createRequest
	if r.Body != nil {
		// An empty body is valid (everything is optional); only malformed JSON is a 400.
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&req); err != nil && err.Error() != "EOF" {
			writeJSONError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}

	if req.Model != "" && !modelRe.MatchString(req.Model) {
		writeJSONError(w, http.StatusBadRequest, "invalid model")
		return
	}

	id := uuid.NewString()
	spec := map[string]interface{}{}
	if owner != "" {
		spec["owner"] = owner
	}
	if req.Model != "" {
		spec["model"] = req.Model
	}
	if req.ParentID != "" {
		spec["parentId"] = req.ParentID
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := creator.Create(ctx, id, spec); err != nil {
		// A failed CR write is a real failure — the conversation does not exist, so
		// returning an id would hand back something unusable. Surface it.
		logf("conversation create failed for %s: %v", id, err)
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("could not create conversation: %v", err))
		return
	}

	// 201 as soon as the CR lands. No agent-host was consulted, so this succeeds
	// even when every replica is at cap — the conversation is simply Pending until
	// the controller can assign it.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(createResponse{
		ID:        id,
		Status:    "pending",
		Title:     req.Title,
		CreatedAt: time.Now().UnixMilli(),
		Owner:     owner,
	})
}

// ownerFrom resolves WHO is creating this conversation, so the router can stamp
// spec.owner on the CR. The header is consumed here — it is not forwarded; the
// owner becomes a field on the object.
//
// Same header + AUTH_USER_HEADER override the agent-host uses
// (agent-host/src/auth/identity.ts:142), so a conversation created here is owned
// identically to one created there. Empty = anonymous, a valid scope
// (single-user / no-ingress-auth deployments), not an error.
//
// TRUST: the header is only meaningful because the ingress (oauth2-proxy) sets
// it and strips any client-supplied copy. Anything that can reach the router
// directly — a port-forward, an in-cluster caller — can assert any owner. That
// is pre-existing (the agent-host has the same property) and the ingress is the
// boundary, but this is now a WRITE path for identity, so it matters more.
func ownerFrom(r *http.Request) string {
	h := os.Getenv("AUTH_USER_HEADER")
	if h == "" {
		h = "x-auth-user"
	}
	return strings.TrimSpace(r.Header.Get(h))
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
