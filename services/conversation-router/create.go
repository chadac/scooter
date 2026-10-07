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
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// Creating a conversation is a control-plane write: mint the id, write the
// Conversation CR, return. No agent-host is consulted, so this succeeds even when
// the fleet is at capacity — the conversation is Pending until assigned.

// NewConversation is the conversation to persist: the CR spec, plus the create-time
// metadata that is NOT part of the CR.
//
// Title is separate from Spec on purpose. It used to be put in the spec map, where the
// cluster's structural CRD schema — which has no `title` property — silently PRUNED it,
// and only dev mode (a Postgres row, no schema) ever saw it. That made an apiserver
// pruning rule the mechanism a feature depended on: invisible in the code, undetectable
// at the call site, and one `title: {type: string}` away from changing behaviour in
// production by accident. The field now says where it applies, and the CR carries only
// what its schema declares. Why: PR #556.
type NewConversation struct {
	Name string
	Spec map[string]interface{}
	// Title is create-time ROW metadata, not a CR field. In cluster it is dropped here
	// rather than by the apiserver: the title arrives later, from the agent's <title>.
	Title string
}

// ConversationCreator creates a Conversation CR. Narrow so the route is testable
// with a hand-written fake.
type ConversationCreator interface {
	Create(ctx context.Context, c NewConversation) error
}

// dynamicCreator uses the same dynamic client as the ownership cache.
type dynamicCreator struct {
	dyn       dynamic.Interface
	namespace string
}

func (d *dynamicCreator) Create(ctx context.Context, c NewConversation) error {
	// c.Title is deliberately not written: it is not in the CRD schema, so the apiserver
	// would prune it anyway. Dropping it here makes that visible in the code.
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": conversationGVR.Group + "/" + conversationGVR.Version,
		"kind":       "Conversation",
		"metadata":   map[string]interface{}{"name": c.Name, "namespace": d.namespace},
		"spec":       c.Spec,
	}}
	_, err := d.dyn.Resource(conversationGVR).Namespace(d.namespace).Create(ctx, obj, metav1.CreateOptions{})
	return err
}

// Remove deletes the CR, for dualCreator's rollback when the row write fails. An
// already-gone CR is success: the goal is "no CR left behind", and someone else having
// deleted it satisfies that.
func (d *dynamicCreator) Remove(ctx context.Context, name string) error {
	err := d.dyn.Resource(conversationGVR).Namespace(d.namespace).Delete(ctx, name, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// dualCreator writes both stores on create: the Conversation CR and the `conversations` row. It
// exists so the row can become the source of truth for existence — nothing can read a row that no
// writer produces, and in the cluster stack nothing produced one at create time.
//
// BOTH writes are now required. A row failure used to be logged and swallowed, which was the right
// asymmetry while the agent-host's saveMeta would insert the row later anyway: the create degraded
// to "absent from the list until the host writes meta". The host no longer inserts (#726) — it only
// updates columns on a row its creator wrote, and its append fence refuses a conversation whose row
// is gone. So a swallowed row failure would now hand back a 201 for a conversation that can neither
// list nor take a turn, which is worse than a failed create the caller can retry.
//
// The CR written moments earlier is rolled back when the row fails, so a failed create leaves
// nothing behind. Best-effort: a rollback that itself fails leaves an orphan CR with no row, which
// the controller sees as a conversation that never materialised — logged loudly, and still better
// than the 201 that preceded it.
// conversationRowWriter is the row half. Narrow for the same reason ConversationCreator is: the
// interesting behaviour here is which failure is fatal, and that must be testable without a
// Postgres.
type conversationRowWriter interface {
	CreateConversation(ctx context.Context, c NewConversation) error
}

// crRemover rolls back the CR when the row write fails. Optional — a creator that cannot delete
// (a test fake, a stack with no CR) simply leaves the CR, which is the pre-#726 outcome.
type crRemover interface {
	Remove(ctx context.Context, name string) error
}

type dualCreator struct {
	cr   ConversationCreator
	rows conversationRowWriter
}

func (d *dualCreator) Create(ctx context.Context, c NewConversation) error {
	if err := d.cr.Create(ctx, c); err != nil {
		return err
	}
	if err := d.rows.CreateConversation(ctx, c); err != nil {
		log := logger("create")
		remover, ok := d.cr.(crRemover)
		if ok {
			// Use a context that is NOT the request's: the row failure may well BE a cancelled
			// request, and a rollback that inherits the cancellation never runs.
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if rerr := remover.Remove(rctx, c.Name); rerr != nil {
				log.Error("conversation row insert failed AND the CR rollback failed; a CR with no row is left behind",
					errAttr(rerr), slog.String("conversation_id", c.Name), slog.String("row_error", err.Error()))
				return fmt.Errorf("could not write the conversation row: %w", err)
			}
		}
		log.Error("conversation row insert failed; the create is refused",
			errAttr(err), slog.String("conversation_id", c.Name), slog.Bool("cr_rolled_back", ok))
		return fmt.Errorf("could not write the conversation row: %w", err)
	}
	return nil
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
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	// The title rides ALONGSIDE the spec, not in it: dev mode persists it on the row (so an
	// API-seeded conversation that is never prompted still lists with its title —
	// sessions.spec.ts "fresh first visit", fast-only), and the CR has no field for it.
	if err := creator.Create(ctx, NewConversation{Name: id, Spec: spec, Title: req.Title}); err != nil {
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
