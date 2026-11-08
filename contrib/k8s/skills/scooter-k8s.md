---
name: scooter-k8s
type: knowledge
version: 1.0.0
triggers:
- kubernetes
- k8s
- kubectl
- cluster
- pod
- deployment
- namespace
---

# Kubernetes clusters (scooter-k8s)

You reach the deployment's Kubernetes clusters through the `k8s_*` tools. The
broker holds the credentials, so there is no kubeconfig in your sandbox, and
`kubectl` won't reach these clusters. Don't go looking for a token.

Start with `k8s_clusters`. It lists each cluster, its default namespace,
whether it's read-only, whether it allows write grants and who approves its
requests. If only one cluster is configured, you can leave `cluster` empty.

## Reads: no approval needed

`k8s_api_resources`, `k8s_list`, `k8s_get`, `k8s_describe`, `k8s_events` and
`k8s_logs` answer straight away. Kinds resolve the way kubectl's do, so
`deploy`, `deployments` and `Deployment` all work. Pass `api_version` only
when a kind name is ambiguous.

Secrets never show their values in these tools, only their key names and
value lengths.

## Writes: a person approves

`k8s_apply`, `k8s_delete`, `k8s_scale`, `k8s_rollout_restart`, `k8s_exec` and
`k8s_secret_reveal` each raise a card in the conversation:

- The call first runs a server-side dry run. If it fails (validation, RBAC,
  admission), you get the error at once and no card is raised.
- On a cluster where `k8s_clusters` shows `writes_as`, writes, exec and
  Secret reads run as that Kubernetes user. A 403 then means that user lacks
  the permission. Tell the user which one; retrying won't help.
- Otherwise the call returns `pending_approval` straight away. **Don't retry
  and don't wait.** Carry on with other work, or end your turn. A message
  tells you the outcome, with the result.
- When a request is approved, exactly what you sent runs, so get it right
  before you ask. If it's denied, nothing ran.
- A conversation can have at most 5 requests waiting at once.
- Prefer `k8s_apply` with complete manifests. Render Helm or Kustomize in the
  sandbox first, then apply the output.

### Write grants

If a cluster allows grants and you expect several changes in one namespace,
ask once with `k8s_request_grant(namespace, minutes, reason)`. Once it's
approved, apply, delete, scale and rollout restart calls in that namespace run
immediately and return their result. `k8s_grants` lists your active grants.

`k8s_exec`, `k8s_secret_reveal` and cluster-scoped objects (Namespaces, CRDs,
ClusterRoles) always need their own card, even under a grant.

### Secrets and exec

- `k8s_secret_reveal` returns the values in a message, so they end up in the
  transcript. Ask only for the keys you need, and never repeat the values back
  to the user, in files you commit, or anywhere else.
- `k8s_exec` runs one argv with no TTY or stdin, e.g.
  `["sh", "-c", "ls /data"]`. It's stopped after 120s and its output is capped
  at 64 KiB.
