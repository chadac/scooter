# Web Services Proxy — design + implementation

**Status:** IMPLEMENTED (marimo built-in; xterm/vscode are follow-ups). All tiers
green except the Tier-2 k3s e2e, which is written + typechecked and runs under
`just test-cluster` (gated `RUN_CLUSTER_TESTS=1`).

Built:
- Proxy core — `resolvePodTarget` (pod IP), `handleHttp` (stream pipe),
  `handleUpgrade` (raw WebSocket splice), 404/502/503 maps
  (`services/agent-host/src/proxy/webServiceProxy.ts`).
- `WebServiceRegistry` — reads `/run/scooter/web-services.json` via exec,
  `systemctl is-active`/`start` (`.../proxy/webServiceRegistry.ts`).
- Server wiring — `useProxy`, HTTP fallback + new `upgrade` listener
  (`agui/server.ts`); `CONVERSATION_ID` injected by the provisioner.
- `webServices.<name>` NixOS option (top-level) + `extraConfig` escape hatch +
  marimo built-in (`modules/sandbox-os/web-services{.nix,/marimo.nix}`); nixosTest
  `dev-env-web-services`.
- Management API — `GET/POST /conversations/:id/web-services[/:name/start]`.
- UI Services panel (`ui/src/ServicesPanel.tsx`) + client fns; nginx `/c/` forward
  with WebSocket upgrade (`pkgs/ui-image`).
- Skill `skills/scooter-web-services.md` (+ marimo-pair as an agent skill).
- Tests: proxy 7, registry 6, management 5, UI 4, nixosTest, Tier-2 k3s e2e.

Follow-ups (out of this cut): lazy start-on-first-request; xterm + vscode
built-ins; running the Tier-2 e2e in CI.

Original research spec follows.

---


Let a user open a web service running *inside* a conversation's sandbox pod —
a marimo notebook, web VS Code, an xterm terminal — from the conversation UI at:

```
https://scooter.example.com/c/<threadId>/<service>/...
```

The agent (or the user, from the UI) declares and starts the service inside the
sandbox; the platform reverse-proxies HTTP **and WebSocket** traffic to it.

---

## Decisions (locked in planning)

| Question | Decision |
|----------|----------|
| **Proxy tier** | **The agent-host.** UI nginx forwards `/c/<id>/*` straight to the agent-host, which resolves the conversation's pod and reverse-proxies to it (incl. WebSocket upgrade). |
| **Auth** | **Existing auth only.** The ingress already injects `x-auth-user`; conversation access is a *view filter*, not a boundary — any authenticated user may reach any conversation's services. No new per-conversation check in this cut. |
| **Service declaration** | **A declarative NixOS option** — `webServices.<name> = { port; … }`. The agent sets it via `modify_environment` (the existing `scooter-apply-module` path). Ship built-ins: `xterm`, `vscode`, `marimo`. |
| **Lifecycle** | **Explicit start** for this cut (agent/user starts the systemd unit; the proxy only routes). Lazy start-on-first-request is a follow-up. |
| **marimo** | Wire up [marimo-pair](https://github.com/marimo-team/marimo-pair) for the marimo built-in. |
| **First service proven** | **marimo (+ marimo-pair)** — build this one end-to-end first. |
| **Start control** | **UI Start button in this cut** — `POST /conversations/:id/web-services/:name/start` execs `systemctl start`; UI lists services with Start + Open. |
| **Packaging** | **Lazy-build** the built-ins (nix-stubs / lazy-tools — bake only the `.drv`); first enable pays the build, image stays small. |

Why the agent-host and not nginx: nginx cannot resolve `<id>` → pod IP on its
own. Pod IPs are dynamic, there is **no per-conversation Service**, and the
agent-host lacks RBAC to create one. The agent-host already resolves the pod
(`resolvePodName`, `exec/k8sExec.ts`) and knows the caller — so id→pod
resolution, the (existing) auth, and the WebSocket upgrade all live in one place.

---

## Request flow

```
Browser
  └─ GET/WS  https://scooter.example.com/c/<threadId>/marimo/...
       │  ingress injects x-auth-user (unchanged)
       ▼
  UI nginx (pkgs/ui-image)                      ← new: location /c/ → agent-host
       │  proxy_pass http://agent-host:8080; (HTTP + Upgrade/Connection headers)
       ▼
  agent-host (services/agent-host)              ← new: /c/<id>/<service>/* route
       │  1. resolve conversation by threadId (or shortId)
       │  2. resolve pod → { name, podIP }      ← new: resolvePodTarget()
       │  3. look up <service> → its in-pod port ← new: discovery (see below)
       │  4. reverse-proxy http://<podIP>:<port>/... incl. `upgrade`
       ▼
  sandbox pod (conv-<shortId>, podIP)
       └─ systemd service (marimo/vscode/xterm) listening on its port
```

Two transports must both work:
- **HTTP** — marimo's page loads, VS Code's static assets, xterm's page.
- **WebSocket** — marimo's kernel channel, VS Code's RPC, xterm's PTY stream.
  The agent-host `http.Server` does **not** handle `upgrade` today
  (`agui/server.ts:278`); this feature adds an `upgrade` listener.

---

## Component inventory (what's new vs. reused)

### 1. In-pod: `webServices` NixOS option + built-ins
New NixOS module (in `modules/sandbox-os/`), enabled in the base config and
extendable at runtime by the agent's module.

```nix
webServices.<name> = {
  enable      = mkEnableOption "the <name> web service";
  port        = mkOption { type = types.port; };          # in-pod listen port
  command     = mkOption { type = types.str; };            # ExecStart
  displayName = mkOption { type = types.str; default = <name>; };
  path        = mkOption { type = types.str; default = "/c/\${id}/<name>"; };
  # basePath handling: the service must serve under /c/<id>/<name> OR the proxy
  # strips the prefix. Marimo/VS Code/xterm each need base-URL config — captured
  # per built-in below.
};
```

The option renders, per enabled service, a `systemd.services.webservice-<name>`
unit (mirrors `pkgs/sandbox-os/sample-service.nix`) that is **NOT**
`wantedBy = multi-user.target` in the explicit-start model — it's started on
demand by `systemctl start` (agent tool / UI button). Registered services are
also written to a **discovery manifest** the agent-host can read (see §3).

Built-ins to ship (each its own `.nix` under `modules/sandbox-os/web-services/`):
- **`marimo`** — `marimo edit` (**proven first**). Sub-path serving is
  **confirmed**: `marimo edit --base-url /c/<id>/marimo --proxy <public-host> \
  --host 0.0.0.0 --port <p> --no-token --headless`. `--base-url` makes marimo
  emit prefixed hyperlinks/asset paths; `--proxy` makes it generate correct
  absolute URLs for the external host. (marimo CLI docs; nginx deploy guide.)
- **`xterm`** — a browser terminal (`ttyd`/`wetty`). Smallest; a good second to
  exercise the raw PTY-over-WebSocket path.
- **`vscode`** — web VS Code (`openvscode-server`/`code-server`). Needs
  `--server-base-path=/c/<id>/vscode`.

**marimo-pair is NOT a web service** — it's an *Agent Skills* plugin that lets the
agent drive a *running* marimo server (needs bash/curl/jq; connects to a marimo
started with `--no-token`). So it belongs on the **agent side as a skill**
(`skills/`), paired with the marimo web service: the `webServices.marimo` unit
runs `marimo edit … --no-token`, and the skill teaches the agent to attach to it
via marimo-pair. (github.com/marimo-team/marimo-pair.)

*Open item:* confirm `marimo` (+ ttyd, code-server) exist in the pinned nixpkgs;
delivered lazily (below).

### 2. agent-host: pod-target resolution
Extend `exec/k8sExec.ts` with a `resolvePodTarget(kc, ref): { name; podIP }`
sibling to `resolvePodName` (the `ready` pod object already carries
`status.podIP` — currently discarded). Same 90s ready-poll.

### 3. agent-host: service discovery (id + name → port)
The proxy must map `<service>` → its in-pod port. Options (decided in Design):
- **(a)** Read the in-pod discovery manifest via exec/download (a JSON the
  `webServices` option renders, e.g. `/run/scooter/web-services.json`).
- **(b)** Keep a small registry in the agent-host keyed by conversation.
Leaning **(a)** — the Nix option is the source of truth and survives
suspend/resume; the agent-host reads it lazily and caches per conversation.

### 4. agent-host: the reverse-proxy route + `upgrade` handler
- A catch-all HTTP route `GET|POST|… /c/:id/:service/*` in the router that pipes
  request→pod and pod→response (streaming; no buffering).
- An `upgrade` listener on the `http.Server` that matches the same path shape and
  proxies the raw socket to `http://<podIP>:<port>` with the `Upgrade`/
  `Connection` headers intact.
- Prefix handling: strip (or preserve) `/c/<id>/<service>` so the in-pod service
  sees the path it expects (tied to each service's base-URL config).

### 5. UI nginx: forward `/c/` to the agent-host
Add a `location /c/ { proxy_pass http://agent-host; }` with `Upgrade`/
`Connection` header passing and buffering off (mirrors the existing `/agui`
SSE block in `pkgs/ui-image/default.nix`).

### 6. UI: surface services
- A per-conversation "Services" affordance listing declared services (from a new
  agent-host endpoint, e.g. `GET /conversations/:id/web-services`) with
  start/stop + an "Open" link to `/c/<id>/<service>/`.
- *Open item:* start/stop = a management endpoint that `systemctl start/stop`s
  the unit via exec. In scope for this cut? (explicit-start implies yes — at
  least "start").

### 7. Skills
`skills/scooter-web-services.md` teaching the agent: what each service is for,
when to recommend it, how to enable it via `modify_environment`, and the
marimo-pair setup. (Loaded like the other skills — `skills/*.md`.)

---

## Areas of uncertainty (to resolve before/into Design)

1. **Base-path / sub-path serving.** Each service serves assets and opens
   WebSockets at absolute paths, so it must know its base URL under
   `/c/<id>/<service>/`. **marimo: RESOLVED** (`--base-url` + `--proxy`).
   VS Code: `--server-base-path` (well-supported). xterm/ttyd: base-path support
   to confirm in Design. A service that hardcodes `/` would break behind the
   prefix — verify each built-in's flag before shipping it.

   **Packaging (lazy).** Built-ins are delivered via the existing lazy-tool
   mechanism (`mkLazyTool`, `modules/sandbox-os/lazy-tools.nix`): the
   `webServices.<name>.command` points at a lazy-tool stub on PATH (e.g. a
   `marimo` stub → `nix build <pin>#marimo` on first `systemctl start`). The base
   image ships only the `.drv`, not the closure; first start pays the build. Keeps
   the ~1GB image from growing.
2. **WebSocket through two hops** (nginx → agent-host → pod). Both hops must pass
   `Upgrade`/`Connection` and not buffer. The agent-host has no `upgrade` handler
   today; this is new surface.
3. **Package availability** in nixpkgs (ttyd/wetty, code-server/openvscode-server,
   marimo, marimo-pair) and image-size impact (the sandbox image is already
   ~1GB). Lazy-tool/lazy-build these rather than baking? (see
   `nix-stubs`/lazy-tools).
4. **Suspend/resume + pod IP churn.** The pod IP changes across resume; the
   agent-host must re-resolve (don't cache the IP across a suspend). Discovery
   manifest read must tolerate a suspended pod (503 / "service asleep").
5. **NetworkPolicy.** `conversation.nix:138` flags a future default-deny. If added,
   agent-host→pod:port egress must be allowed. Not blocking now (no policy yet).
6. **Multi-user concurrency.** "Any authenticated user" means two users can hit
   the same conversation's marimo. marimo-pair is explicitly collaborative (good);
   xterm/VS Code sharing a single session is a UX note, not a blocker.
7. **Explicit-start UX.** If a user opens `/c/<id>/marimo` before the unit is
   started, they get a connection refused. Need a friendly "service not running —
   start it?" page rather than a raw 502. (Lazy-start would remove this; deferred.)
8. **Path collision.** `/c/<id>` as a proxy prefix vs. the UI's own deep-link
   (`/?thread=<id>`). `/c/` is currently unused by the UI — confirm no route clash.

---

## Explicitly out of scope (this cut)
- Lazy start-on-first-request (readiness-gating, spinner). Follow-up.
- Per-conversation access control beyond today's auth. (Any authed user.)
- Per-conversation Services / new RBAC. (Agent-host proxies to pod IP directly.)
- Sharing/allowlist/tokens.

---

## Test seams (previewing Stage 3)
- **Tier 1 (contract):** the proxy route + `upgrade` handler against a *fake pod
  target* (a local http/ws echo server) — asserts HTTP pipes through, headers
  forwarded, WebSocket upgrades and echoes, prefix stripped/preserved correctly,
  unknown service → 404, suspended/unreachable pod → 503. Discovery-manifest
  parse. This is the highest-value new test.
- **`check-manifests` / nixosTest:** the `webServices` option renders a
  `systemd.services.webservice-<name>` unit + the discovery manifest; a built-in
  (xterm) actually serves over the proxy inside a nixosTest VM.
- **Tier 2 (cluster):** end-to-end — declare + start a service, hit
  `/c/<id>/<service>/` through the agent-host against a real pod.
- **Tier 3 (e2e):** the UI "Services" panel starts a service and opens it.
