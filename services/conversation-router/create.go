package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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

// Creating a conversation is a control-plane write: mint the id, write the
// Conversation CR, return. No agent-host is consulted, so this succeeds even when
// the fleet is at capacity — the conversation is Pending until assigned.

// ConversationCreator creates a Conversation CR. Narrow so the route is testable
// with a hand-written fake.
type ConversationCreator interface {
	Create(ctx context.Context, name string, spec map[string]interface{}) error
}

// dynamicCreator uses the same dynamic client as the ownership cache.
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

// createRequest is the accepted body. No threadId: the server mints the id.
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

// IsConversationCreate reports whether to handle here rather than proxy.
func IsConversationCreate(method, path string) bool {
	return method == http.MethodPost && strings.TrimSuffix(path, "/") == "/conversations"
}

// modelRe guards the only client-controlled string that reaches the CR spec.
var modelRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// serveConversationCreate returns 201 without waiting for assignment or provisioning.
func serveConversationCreate(w http.ResponseWriter, r *http.Request, creator ConversationCreator, owner string) {
	var req createRequest
	if r.Body != nil {
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
		logger("create").Error("conversation create failed",
			convAttr(id),
			slog.String("owner", owner),
			errAttr(err))
		writeJSONError(w, http.StatusBadGateway, fmt.Sprintf("could not create conversation: %v", err))
		return
	}

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

// ownerFrom resolves the creator for spec.owner. Same header the agent-host uses.
// Empty = anonymous, a valid scope. Trusted only because the ingress sets it and
// strips client copies.
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
