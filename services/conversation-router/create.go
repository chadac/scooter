package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
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
	// Owner is PRIVILEGED and honored ONLY for a TokenReview-verified in-cluster
	// caller (webhooks/scheduler creating on a human's behalf) — see trustedcaller.go.
	// From anyone else it is ignored, never an error.
	Owner string `json:"owner"`
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
//
// `owner` is the ingress-resolved caller (ownerFrom). `trusted` may be nil; when it is
// not, a body `owner` from a verified in-cluster caller wins over the header — that is
// the path webhooks/scheduler use, because the header's NAME is deployment-specific and
// they do not come through the ingress that sets it (#527).
func serveConversationCreate(w http.ResponseWriter, r *http.Request, creator ConversationCreator, owner string, trusted TrustedCaller) {
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

	if req.Owner != "" && req.Owner != owner {
		// Verify only when it would change the outcome: a browser create carries no
		// body owner, so it never pays the TokenReview round-trip.
		if trusted != nil && trusted(r.Context(), r) {
			owner = req.Owner
		} else {
			logger("create").Warn("ignored a body owner from an unverified caller",
				slog.Bool("had_header_owner", owner != ""))
		}
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
	// A create-time title. In cluster the CRD is a structural schema with no `title` property, so
	// the apiserver PRUNES this key — production keeps its "title arrives later (agent <title>)"
	// behaviour untouched. In dev mode devCreator reads it and persists it on the row, so an
	// API-seeded conversation that is never prompted still lists with its title (sessions.spec.ts
	// "fresh first visit", fast-only).
	if req.Title != "" {
		spec["title"] = req.Title
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

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
