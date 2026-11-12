# scooter-local: run Scooter on this machine, in a k3d cluster, from the published
# images. Built into `nix run .#local` by local/default.nix, which fills in the
# @placeholders@. Docs: docs/tutorial/local.md.

VERSION="@version@"
# This flake's source, for the one eval `up` runs itself (the claude image tag).
FLAKE="@flake@"
# Set by scooter.lib.mkLocal: the one provider the baked configuration names.
FIXED_PROVIDER="@fixedProvider@"
MANIFESTS_CLAUDE_CODE="@manifestsClaudeCode@"
MANIFESTS_ANTHROPIC="@manifestsAnthropic@"
MANIFESTS_OLLAMA="@manifestsOllama@"
# The agent-sandbox release the platform targets (same as test/support/cluster-up.sh).
AGENT_SANDBOX_VERSION="@agentSandboxVersion@"

CLUSTER="${SCOOTER_LOCAL_CLUSTER:-scooter}"
NAMESPACE="scooter"
PORT="${SCOOTER_LOCAL_PORT:-8080}"
API_PORT="${SCOOTER_LOCAL_API_PORT:-6445}"
STATE="${SCOOTER_LOCAL_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/scooter-local}"
URL="http://localhost:${PORT}"
# Ollama as seen from inside the cluster: k3d's alias for the host.
OLLAMA_CLUSTER_HOST="${SCOOTER_LOCAL_OLLAMA_HOST:-http://host.k3d.internal:11434}"

KUBECONFIG="$STATE/kubeconfig"
export KUBECONFIG

log() { printf '[scooter-local] %s\n' "$*"; }
die() { printf '[scooter-local] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
scooter-local ${VERSION} — Scooter on this machine (k3d + the published images)${FIXED_PROVIDER:+, provider: $FIXED_PROVIDER}

  scooter-local up         create or start the cluster and deploy; asks for a provider the first time
  scooter-local down       stop the cluster; conversations, sandboxes and files are kept
  scooter-local destroy    delete the cluster and everything in it
  scooter-local status     cluster, pods and the URL
  scooter-local logs       follow the agent-host's log
  scooter-local config     choose the provider or credential again (then \`up\` applies it)
  scooter-local kubeconfig print the kubeconfig path, for kubectl

Environment:
  SCOOTER_LOCAL_PORT       the UI port on localhost (default 8080)
  SCOOTER_LOCAL_STATE      state dir (default \$XDG_STATE_HOME/scooter-local)
  SCOOTER_LOCAL_PROVIDER   claude-code | anthropic | ollama, to skip the prompt
  CLAUDE_CODE_OAUTH_TOKEN  the \`claude setup-token\` token, to skip the prompt
  ANTHROPIC_API_KEY        the API key, to skip the prompt
  OLLAMA_MODEL             the Ollama model, to skip the prompt
  SCOOTER_LOCAL_CLAUDE_TAG the agent-host-claude image tag, instead of resolving it
  SCOOTER_LOCAL_K3D_ARGS   extra arguments for \`k3d cluster create\` (e.g. --agents 1)
EOF
}

# --- preflight ---------------------------------------------------------------

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not on PATH; k3d runs the cluster in Docker (Docker Desktop, OrbStack, or the docker daemon)."
  docker info >/dev/null 2>&1 || die "docker is installed but the daemon is not reachable; start it and retry."
}

# --- cluster -----------------------------------------------------------------

cluster_exists() { k3d cluster list -o json | jq -e --arg c "$CLUSTER" 'any(.[]; .name == $c)' >/dev/null; }
cluster_running() {
  k3d cluster list -o json \
    | jq -e --arg c "$CLUSTER" 'any(.[]; .name == $c and .serversRunning == .serversCount and .serversRunning > 0)' >/dev/null
}

cluster_up() {
  mkdir -p "$STATE/assets"
  if cluster_exists; then
    if cluster_running; then
      log "cluster '$CLUSTER' is running"
    else
      log "starting cluster '$CLUSTER'..."
      k3d cluster start "$CLUSTER"
    fi
  else
    log "creating cluster '$CLUSTER' (http://localhost:${PORT} -> the cluster's ingress)..."
    # SCOOTER_LOCAL_K3D_ARGS is word-split on purpose: it is a list of arguments.
    # shellcheck disable=SC2086
    k3d cluster create "$CLUSTER" \
      --api-port "127.0.0.1:${API_PORT}" \
      -p "127.0.0.1:${PORT}:80@loadbalancer" \
      -v "$STATE/assets:/var/lib/scooter/assets@server:0" \
      --wait --timeout 300s \
      ${SCOOTER_LOCAL_K3D_ARGS:-}
  fi
  k3d kubeconfig get "$CLUSTER" > "$KUBECONFIG"
  chmod 600 "$KUBECONFIG"
  wait_for_node
}

wait_for_node() {
  log "waiting for the node..."
  for _ in $(seq 1 90); do
    if kubectl get nodes 2>/dev/null | grep -q ' Ready '; then return; fi
    sleep 2
  done
  die "the cluster's node did not become Ready; \`k3d cluster list\` and \`docker ps\` show its state."
}

install_controller() {
  if kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1; then
    log "agent-sandbox controller is installed"
    return
  fi
  log "installing the agent-sandbox controller ${AGENT_SANDBOX_VERSION}..."
  local base="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}"
  kubectl apply -f "${base}/sandbox.yaml"
  kubectl apply -f "${base}/extensions.yaml"
  kubectl wait --for=condition=Available deploy --all -n agent-sandbox-system --timeout=300s
}

# --- provider ----------------------------------------------------------------

provider_file="$STATE/provider"

current_provider() {
  if [ -n "$FIXED_PROVIDER" ]; then
    echo "$FIXED_PROVIDER"
  elif [ -n "${SCOOTER_LOCAL_PROVIDER:-}" ]; then
    echo "$SCOOTER_LOCAL_PROVIDER"
  elif [ -s "$provider_file" ]; then
    cat "$provider_file"
  fi
}

# Prompt on the terminal; refuses to guess when there is none.
ask() {
  local prompt="$1" var="$2" silent="${3:-}"
  [ -t 0 ] || die "$prompt — no terminal to ask on; set the environment variable instead (see \`scooter-local help\`)."
  if [ -n "$silent" ]; then
    read -r -s -p "$prompt" "${var?}" </dev/tty; echo
  else
    read -r -p "$prompt" "${var?}" </dev/tty
  fi
}

choose_provider() {
  local choice
  if [ -n "$FIXED_PROVIDER" ]; then
    choice="$FIXED_PROVIDER"
  elif [ -n "${SCOOTER_LOCAL_PROVIDER:-}" ]; then
    choice="$SCOOTER_LOCAL_PROVIDER"
  else
    cat <<EOF

Which model provider should the agent use?

  1) Claude subscription (claude-code)   needs a token from \`claude setup-token\`
  2) Anthropic API key                   needs a key from console.anthropic.com
  3) Ollama on this machine              needs \`ollama serve\` with a model pulled

EOF
    ask "Provider [1/2/3]: " choice
    case "$choice" in
      1|claude-code) choice=claude-code ;;
      2|anthropic) choice=anthropic ;;
      3|ollama) choice=ollama ;;
      *) die "unknown choice '$choice'" ;;
    esac
  fi
  case "$choice" in claude-code|anthropic|ollama) ;; *) die "unknown provider '$choice' (claude-code, anthropic or ollama)" ;; esac
  mkdir -p "$STATE"
  echo "$choice" > "$provider_file"
  log "provider: $choice"
}

secret_exists() { kubectl -n "$NAMESPACE" get secret "$1" >/dev/null 2>&1; }

# The baked render for a provider.
render_source() {
  case "$1" in
    claude-code) echo "$MANIFESTS_CLAUDE_CODE" ;;
    anthropic) echo "$MANIFESTS_ANTHROPIC" ;;
    ollama) echo "$MANIFESTS_OLLAMA" ;;
  esac
}
# Whether the render still carries a placeholder; a configuration that set the value
# itself (scooter.local.ollama.model, scooter.local.agentHostClaudeTag) has none.
render_has() { grep -q -- "$2" "$(render_source "$1")"; }

# `kubectl create secret` from a literal, replacing an existing one.
put_secret() {
  local name="$1" key="$2" value="$3"
  kubectl -n "$NAMESPACE" create secret generic "$name" --from-literal="$key=$value" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}

# The provider's credential: asked once, kept only in the cluster. `force` re-asks.
ensure_provider_secret() {
  local provider="$1" force="${2:-}" value
  case "$provider" in
    claude-code)
      if [ -z "$force" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && secret_exists agent-claude-code-token; then return; fi
      value="${CLAUDE_CODE_OAUTH_TOKEN:-}"
      if [ -z "$value" ]; then
        echo
        echo "Run \`claude setup-token\` in another terminal and paste the sk-ant-oat01-... token it prints."
        ask "Token: " value silent
      fi
      case "$value" in sk-ant-oat01-*) ;; *) die "that does not look like a \`claude setup-token\` token (sk-ant-oat01-...)" ;; esac
      put_secret agent-claude-code-token token "$value"
      ;;
    anthropic)
      if [ -z "$force" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && secret_exists agent-anthropic-key; then return; fi
      value="${ANTHROPIC_API_KEY:-}"
      [ -n "$value" ] || ask "Anthropic API key: " value silent
      [ -n "$value" ] || die "no API key given"
      put_secret agent-anthropic-key api-key "$value"
      ;;
    ollama)
      render_has ollama '@OLLAMA_MODEL@' || return 0
      if [ -z "$force" ] && [ -z "${OLLAMA_MODEL:-}" ] && [ -s "$STATE/ollama-model" ]; then return; fi
      value="${OLLAMA_MODEL:-}"
      if [ -z "$value" ]; then
        echo
        if curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
          echo "Models on the local Ollama:"
          curl -fsS http://localhost:11434/api/tags | jq -r '.models[].name' | sed 's/^/  /'
        else
          echo "Ollama is not answering on localhost:11434; the agent needs it running (\`ollama serve\`) when it works."
        fi
        ask "Model (e.g. qwen2.5-coder:7b): " value
      fi
      [[ "$value" =~ ^[A-Za-z0-9._:/-]+$ ]] || die "model id '$value' has characters outside [A-Za-z0-9._:/-]"
      echo "$value" > "$STATE/ollama-model"
      ;;
  esac
}

# --- render ------------------------------------------------------------------

# The agent-host-claude image is unfree, so its content tag is not in the render;
# resolve it as the deploy docs do (#824), once per flake revision.
claude_tag() {
  if [ -n "${SCOOTER_LOCAL_CLAUDE_TAG:-}" ]; then echo "$SCOOTER_LOCAL_CLAUDE_TAG"; return; fi
  local cache
  cache="$STATE/claude-tag.$(basename "$FLAKE" | cut -c1-12)"
  if [ -s "$cache" ]; then cat "$cache"; return; fi
  command -v nix >/dev/null 2>&1 || die "nix is not on PATH, and resolving the agent-host-claude tag needs it; or set SCOOTER_LOCAL_CLAUDE_TAG."
  log "resolving the agent-host-claude image tag (a one-time nix eval; a minute or two)..." >&2
  local out tag
  out=$(NIXPKGS_ALLOW_UNFREE=1 nix eval --impure --raw \
    "path:${FLAKE}#packages.x86_64-linux.agent-host-image-claude.outPath") \
    || die "could not evaluate the agent-host-claude image; set SCOOTER_LOCAL_CLAUDE_TAG to a published tag (e.g. latest)."
  tag=$(basename "$out" | cut -c1-12)
  echo "$tag" > "$cache"
  echo "$tag"
}

# Substitutes the placeholders; a value may not contain the sed delimiter.
subst() {
  local value="$2"
  case "$value" in *'|'*) die "value for $1 contains '|'" ;; esac
  sed "s|$1|$value|g"
}

render() {
  local provider="$1" out="$STATE/rendered.yaml"
  case "$provider" in
    claude-code)
      if render_has claude-code '@AGENT_HOST_CLAUDE_TAG@'; then
        local tag; tag=$(claude_tag)
        subst '@AGENT_HOST_CLAUDE_TAG@' "$tag" < "$MANIFESTS_CLAUDE_CODE" > "$out"
      else
        cp "$MANIFESTS_CLAUDE_CODE" "$out"
      fi
      ;;
    anthropic)
      cp "$MANIFESTS_ANTHROPIC" "$out"
      ;;
    ollama)
      local model=""
      if render_has ollama '@OLLAMA_MODEL@'; then model="${OLLAMA_MODEL:-$(cat "$STATE/ollama-model")}"; fi
      subst '@OLLAMA_HOST@' "$OLLAMA_CLUSTER_HOST" < "$MANIFESTS_OLLAMA" \
        | subst '@OLLAMA_MODEL@' "$model" > "$out"
      ;;
  esac
  chmod 644 "$out"
  echo "$out"
}

# Every ghcr image the render names must be published, or pods would sit in
# ImagePullBackOff; checked before apply, the way the deploy docs do. `value:`
# too: the sandbox image reaches the agent-host as SANDBOX_IMAGE, not as a container.
check_images() {
  local manifests="$1" missing=0 ref repo tag token
  while read -r ref; do
    repo="${ref#ghcr.io/}"; repo="${repo%%:*}"
    tag="${ref##*:}"
    token=$(curl -fsS --max-time 20 "https://ghcr.io/token?scope=repository:${repo}:pull" | jq -r .token) || token=""
    if [ -z "$token" ]; then
      log "WARN: could not reach ghcr.io to check ${ref}; applying anyway"
      continue
    fi
    if ! curl -fsSI --max-time 20 -o /dev/null -H "Authorization: Bearer $token" \
        -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
        "https://ghcr.io/v2/${repo}/manifests/${tag}"; then
      log "MISSING: ${ref}"
      missing=1
    fi
  done < <(grep -oE "(image|value): *['\"]?ghcr\.io/[^'\" ]+" "$manifests" | sed -E "s/^(image|value): *['\"]?//" | sort -u)
  if [ "$missing" = 1 ]; then
    die "some images are not published for this revision (a commit CI has not published, e.g. a branch). Run scooter-local from main or a release (nix run github:chadac-me/scooter#local), or set SCOOTER_LOCAL_CLAUDE_TAG for the claude image alone."
  fi
}

# --- deploy ------------------------------------------------------------------

ensure_namespace() {
  kubectl get ns "$NAMESPACE" >/dev/null 2>&1 || kubectl create ns "$NAMESPACE" >/dev/null
}

# The conversation-token signing key: made once, never rotated by `up` (a new key
# would invalidate every live conversation token).
ensure_conv_token() {
  secret_exists agent-conv-token-secret && return
  put_secret agent-conv-token-secret secret "$(openssl rand -hex 32)"
}

apply() {
  local manifests="$1"
  log "applying the platform..."
  kubectl apply -f "$manifests" >/dev/null
}

wait_ready() {
  log "waiting for the platform (the first run pulls about 1.3 GB of images)..."
  local d
  for d in $(kubectl -n "$NAMESPACE" get deploy -o name); do
    kubectl -n "$NAMESPACE" rollout status "$d" --timeout=900s >/dev/null \
      || die "$d did not become ready; \`scooter-local status\` shows the pods, \`scooter-local logs\` the agent-host."
  done
  # The UI answers through the ingress once Traefik has picked the Ingress up.
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 -o /dev/null "$URL/"; then return; fi
    sleep 2
  done
  log "WARN: $URL is not answering yet; give Traefik a moment, then open it."
}

cmd_up() {
  need_docker
  mkdir -p "$STATE"
  cluster_up
  install_controller
  local provider; provider=$(current_provider)
  if [ -z "$provider" ]; then choose_provider; provider=$(current_provider); fi
  # Remembered, so `status` and a later `up` without the variable agree.
  echo "$provider" > "$provider_file"
  ensure_namespace
  ensure_conv_token
  ensure_provider_secret "$provider"
  local manifests; manifests=$(render "$provider")
  check_images "$manifests"
  apply "$manifests"
  wait_ready
  cat <<EOF

  Scooter is up: ${URL}

  provider:   ${provider}
  kubeconfig: ${KUBECONFIG}
  stop:       scooter-local down     (keeps everything)
  remove:     scooter-local destroy

EOF
}

cmd_down() {
  cluster_exists || { log "no cluster '$CLUSTER'"; return; }
  log "stopping cluster '$CLUSTER' (conversations, sandboxes and files are kept)..."
  k3d cluster stop "$CLUSTER"
}

cmd_destroy() {
  if cluster_exists; then
    if [ -t 0 ] && [ -z "${SCOOTER_LOCAL_YES:-}" ]; then
      local answer
      ask "Delete cluster '$CLUSTER' and every conversation, sandbox and uploaded file in it? [y/N] " answer
      case "$answer" in y|Y|yes) ;; *) log "kept"; return ;; esac
    fi
    k3d cluster delete "$CLUSTER"
  else
    log "no cluster '$CLUSTER'"
  fi
  rm -rf "$STATE"
  log "removed $STATE"
}

cmd_status() {
  if ! cluster_exists; then
    echo "cluster '$CLUSTER': not created (run \`scooter-local up\`)"
    return
  fi
  if ! cluster_running; then
    echo "cluster '$CLUSTER': stopped (run \`scooter-local up\`)"
    return
  fi
  echo "cluster '$CLUSTER': running — ${URL}"
  echo "provider: $(current_provider | grep . || echo '?')"
  echo
  kubectl -n "$NAMESPACE" get pods 2>/dev/null || echo "(platform not deployed)"
}

cmd_logs() {
  cluster_running || die "the cluster is not running"
  kubectl -n "$NAMESPACE" logs deploy/agent-host -f --tail=200
}

cmd_config() {
  mkdir -p "$STATE"
  if [ -n "$FIXED_PROVIDER" ]; then
    log "provider: $FIXED_PROVIDER (set by this build's configuration)"
    echo "$FIXED_PROVIDER" > "$provider_file"
  else
    choose_provider
  fi
  if cluster_running; then
    ensure_namespace
    ensure_provider_secret "$(current_provider)" force
    log "saved; run \`scooter-local up\` to apply"
  else
    log "saved; the credential is asked for at \`scooter-local up\`"
  fi
}

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    up) cmd_up ;;
    down|stop) cmd_down ;;
    destroy|delete) cmd_destroy ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    config|configure) cmd_config ;;
    kubeconfig) echo "$KUBECONFIG" ;;
    version) echo "$VERSION" ;;
    help|-h|--help) usage ;;
    *) usage >&2; exit 2 ;;
  esac
}

main "$@"
