# Local deployments

One command runs Scooter on a laptop or a single server, with nothing of your own to set
up first:

```bash
nix run github:chadac-me/scooter#local -- up
```

It creates a small Kubernetes cluster in Docker with [k3d](https://k3d.io/), installs the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller, deploys
Scooter from the published images, asks once which model provider to use, and prints the
address of the chat: `http://localhost:8080`. The first run pulls about 1.3 GB of images
and takes a few minutes; later runs take about a minute.

## What you need

- **Nix** with flakes enabled ([install](https://nixos.org/download/)).
- **Docker**: the daemon on Linux, or Docker Desktop, OrbStack or
  [colima](https://github.com/abiosoft/colima) on macOS. k3d runs the cluster as
  containers.
- **4 CPUs and 8 GB of memory** for Docker, more for several conversations at once. Each
  conversation runs in its own sandbox container with 1 CPU and 2 GB by default. On
  macOS that is the Docker VM's size, not the Mac's, and the defaults are smaller
  (colima's is 2 CPUs and 2 GiB). `up` warns when Docker has less; resize the VM first:
  `colima start --cpu 6 --memory 16`, or Settings → Resources in Docker Desktop and
  OrbStack. A sandbox reserves its whole size, and the platform takes about 2 CPUs, so
  a VM fits roughly one conversation per CPU beyond those two: 4 at 6 CPUs, 14 at 16.
- **A free port** for the UI, 8080 by default. Other development servers often hold it;
  `up` stops with a free one to use instead (see [Your port](#your-port)).
- **A model provider**, one of:
    - a **Claude subscription**: `claude setup-token` (from the Claude Code CLI) prints
      a long-lived token;
    - an **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/);
    - **[Ollama](https://ollama.com/)** on the same machine, with a model pulled. Nothing
      leaves your machine, but a model has to be good at tool use to drive a sandbox;
      try a coding model of 7B parameters or more;
    - a **GitHub Copilot seat**: a GitHub token of a user with Copilot (`gh auth token`
      prints the gh CLI's). See [GitHub Copilot](../../features/models.md#github-copilot)
      for what to expect.

## Commands

| Command | What it does |
|---|---|
| `scooter-local up` | Create or start the cluster and deploy. Asks for the provider and its credential the first time. Safe to re-run. |
| `scooter-local down` | Stop the cluster. Conversations, sandboxes and uploaded files are kept; `up` brings them back. |
| `scooter-local destroy` | Delete the cluster and everything in it. |
| `scooter-local status` | The cluster's state, its pods, the URL, and any stale [credential](#credentials-from-the-host). |
| `scooter-local sync` | Refresh the Secrets in [`scooter.local.credentials`](#credentials-from-the-host) from their sources. |
| `scooter-local logs [deploy]` | Follow a deployment's log: the agent-host's by default, or e.g. `agent-broker`. |
| `scooter-local config` | Choose the provider or credential again; the next `up` applies it. |
| `scooter-local kubeconfig` | The kubeconfig path, for `kubectl` against the cluster. |
| `scooter-local kubectl …` | `kubectl` against the cluster, in the `scooter` namespace: `scooter-local kubectl get pods`. |

`nix run github:chadac-me/scooter#local -- <command>` runs each; `nix profile install
github:chadac-me/scooter#scooter-local` puts `scooter-local` on your PATH.

The cluster is named `scooter`, and the state (the kubeconfig, the chosen provider, the
uploaded files) lives in `~/.local/state/scooter-local`. Credentials are stored only in
the cluster, as Secrets.

For a script or a CI job, the prompts can be answered from the environment:
`SCOOTER_LOCAL_PROVIDER=claude-code|anthropic|ollama|copilot`, and `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `OLLAMA_MODEL` or `GITHUB_COPILOT_TOKEN`. `SCOOTER_LOCAL_PORT` changes
the port, and `SCOOTER_LOCAL_USER` / `SCOOTER_LOCAL_EMAIL` the identity.

### Your port

k3d binds the port when it creates the cluster, so choose it before the first `up`
(or `destroy` and `up` again). An environment variable reaches only the shells that
set it, not an editor or app started from the dock, so a port of your own belongs in
the build: `scooter.lib.mkLocal { …; port = 8090; }`, or `services.scooter-local.port`
on NixOS. `SCOOTER_LOCAL_PORT` still wins when set.

### Your identity

There is no login, but Scooter still needs to know who you are: per-user features
(boards, personal access tokens, private conversations) refuse an `anonymous` caller.
The preset adds a Traefik middleware that stamps one user on every request, as the
`x-auth-user` and `x-auth-email` headers an auth proxy would set. `up` fills it in
with `SCOOTER_LOCAL_USER` (default: your login name) and `SCOOTER_LOCAL_EMAIL`
(default: `git config user.email`), and remembers both in the state directory. A
declared configuration sets `scooter.local.user` and `scooter.local.email` instead.
Conversations started before this identity existed have no owner and stay visible.

## What runs

The same platform a cluster deployment runs, configured by the `local` preset
([`local/preset.nix`](https://github.com/chadac-me/scooter/blob/main/local/preset.nix)):

- the agent-host, UI, broker and conversation controller, one replica each, and Postgres
  in the cluster;
- the stock Ingress, served by the Traefik that k3s ships, on the port k3d maps to
  `localhost`, with a middleware that sets your identity (see [Your identity](#your-identity));
- the uploads volume on a host directory (the single-node escape hatch described in
  [Getting started](../../getting-started.md#storage-on-single-node-clusters));
- Scooter's own agent skills, and the contribs that need no credentials: web search
  (DuckDuckGo), file attachments, personal skills, personalization, hand-off, shares,
  commits and [kanban boards](../../features/integrations.md#kanban-boards) (at `/boards`). [Setting up contribs](../contribs.md) adds the rest.

Each conversation still gets its own NixOS sandbox: a container inside the k3d node, with
its workspace on a volume that survives `down`.

## What a single machine does not do

**There is no login.** Scooter trusts whatever identity sits in front of it, and here
that is a fixed one: everyone who can reach the port is you. The port is bound to
`127.0.0.1`, so that is only your machine; do not forward it to a network. For other
people, make a real deployment ([Getting started](../../getting-started.md)).

**Sandboxes run privileged.** Without a cgroup-delegating runtime such as crun in the
cluster, the sandbox's systemd needs a privileged container, which here is a container
inside the k3d node's container. That is fine for your own machine and your own
conversations; it is one of the things a cluster deployment sets up differently
(`scooter.sandboxRuntimeClass`).

**Webhooks and the scheduler are off**, since nothing can reach the machine from
GitHub or Slack. Bring-your-own-Claude is off too: the model already runs on your
subscription.

**Everything is on one disk**: Postgres and the sandbox volumes live in the k3d node's
Docker volume, and the uploads in the state directory. `destroy` removes all of it.

**No GPU on macOS.** Sandboxes run in Docker's Linux VM, which cannot reach the Mac's
GPU, so a sandbox size with `gpu` set never schedules there. Ollama on the Mac itself uses
Metal.
To let code in a sandbox use that Ollama, open the port to the host (sandboxes can't
reach private addresses by default) and pass the address in.
`docker exec k3d-scooter-server-0 getent hosts host.k3d.internal` prints the host's IP.

```nix
scooter = {
  networkPolicy.extraEgress = [
    {
      to = [ { ipBlock.cidr = "192.168.5.2/32"; } ];
      ports = [ { protocol = "TCP"; port = 11434; } ];
    }
  ];
  deployTools.env.OLLAMA_HOST = "http://host.k3d.internal:11434";
};
```

## Declare it instead

`nix run …#local` takes no configuration. To pin the provider, pick models, turn on
contribs, or size the sandboxes, write the configuration down and build `scooter-local`
for it.

### From a flake

```bash
nix flake init -t github:chadac-me/scooter#local
```

writes a `flake.nix` and a `scooter.nix`:

```nix
# scooter.nix — on top of the preset; every setting there is a default, so yours win.
{
  scooter = {
    local.provider = "ollama";
    local.ollama.model = "qwen2.5-coder:7b";
    sandboxSizes.medium = { cpu = "4"; memory = "8Gi"; hint = "Builds."; default = true; };
  };
  contribs.github.enable = true;
}
```

```bash
nix run . -- up        # the same commands, with this configuration baked in
```

The flake calls `scooter.lib.mkLocal { system; module = ./scooter.nix; }`, which
renders the preset plus your module and bakes it into `scooter-local`. Since the module
names the provider, `up` asks for nothing but the credential (or reads it from the
environment). `nix build .#manifests` gives the same render as YAML for
`kubectl apply -f` on a cluster of your own.

### On NixOS

```nix
# configuration.nix (with Scooter as a flake input)
{
  imports = [ scooter.nixosModules.local ];
  services.scooter-local = {
    enable = true;
    settings.scooter.local = { provider = "anthropic"; };
    # ANTHROPIC_API_KEY=… / CLAUDE_CODE_OAUTH_TOKEN=… / OLLAMA_MODEL=… / GITHUB_COPILOT_TOKEN=…,
    # outside the store.
    environmentFile = "/run/secrets/scooter-local";
  };
}
```

This enables Docker, installs the `scooter-local` built for `settings`, and runs `up`
as `scooter-local.service` at boot (`down` when it stops); `port` and `stateDir`
(default `/var/lib/scooter-local`) are options too. The service has no terminal, so the
credential comes from `environmentFile`.

### Credentials from the host

Contribs read their tokens from Secrets. `scooter.local.credentials` fills them from
files or commands on your machine, so the values never enter the Nix store:

```nix
# scooter.nix
{
  scooter.local.credentials = {
    github-pat.token.file = "/run/secrets/github_token";
    databricks-tokens.dev = {
      command = "databricks auth token --profile dev -o json | jq -r .access_token";
      fix = "databricks auth login --profile dev";
    };
  };
}
```

`<secret>.<key>` is one key of a Secret, and the Secret holds just the keys listed.
`up` writes them before deploying, and `scooter-local sync` refreshes them:

- A file that's unreadable, or a command that fails or prints nothing, keeps that
  key's current value, so a working token is never blanked.
- A Secret that changed restarts the Deployments that read it as env. Pods that mount
  it, like the Databricks broker, see the new value without a restart.
- `scooter-local status` lists each key, and for a stale one the error and its `fix`.

To keep short-lived tokens fresh, run `sync` on a schedule. The NixOS module does this
with a timer (`services.scooter-local.credentials.refreshInterval`, default `5min`)
and whenever one of the files changes. On macOS, a launchd agent does the same:

```nix
# home-manager
launchd.agents.scooter-local-sync = {
  enable = true;
  config = {
    ProgramArguments = [ "${scooterLocal}/bin/scooter-local" "sync" ];
    StartInterval = 60;
    WatchPaths = [ "/Users/you/.databricks/token-cache.json" ];
  };
};
```

launchd and systemd give commands a minimal PATH, so name programs by absolute path.

### Images of your own

A branch that changes a service or adds a contrib has no published images for it. Set
`local.build` on those images in the module, and `up` builds them for your configuration
and imports them into the cluster:

```nix
scooter.images.agent-broker.local.build = true;
scooter.images.agent-webhooks.local.build = true;
```

Each gets the ref `scooter-local/<name>:<content hash>`; the other images still come
from ghcr. On Linux your own nix builds them. On macOS, which has no Linux builder, a
`nixos/nix` container in the Docker VM does, keeping its store in the `scooter-local-nix`
volume. The first build takes several minutes, later ones only what changed; `destroy`
removes the volume.

A change under `contrib/` or `services/` changes more tags than the images it touches
([#1411](https://github.com/chadac-me/scooter/issues/1411)), so if `up` reports images
missing, build them too, or point them at published tags:
`scooter.images.agent-sandbox-os.ref.tag = "…"`.

## From here to a deployment

The preset is an ordinary Scooter module (`scooter.kubenixModules.local`), so the same
`scooter.nix` can grow into a deployment of your own: [Getting started](../../getting-started.md)
and [Deploying Scooter](index.md) cover authentication, a hostname, and a
cluster.

!!! note "The Claude image tag"
    With the `claude-code` provider the agent-host runs the `agent-host-claude` image,
    whose tag Scooter cannot yet compute in the render
    ([#824](https://github.com/chadac-me/scooter/issues/824)). `scooter-local up` resolves
    it with one `nix eval` the first time, and caches it. A deployment of your own sets
    `scooter.local.agentHostClaudeTag` the way
    [Running on a Claude subscription](published-images.md#running-on-a-claude-subscription)
    describes. `SCOOTER_LOCAL_CLAUDE_TAG` overrides it for `scooter-local`.

## Troubleshooting

- **`docker is installed but the daemon is not reachable`**: start Docker (Desktop) and
  retry; on Linux make sure your user may use the socket.
- **`some images are not published for this revision`**: CI publishes the images of
  `main` and of every release, so run from one of those
  (`nix run github:chadac-me/scooter#local`, or `…/scooter/v1.5.0#local`) rather than
  from a branch or an unpublished commit.
- **`port 8080 on 127.0.0.1 is taken`**: another program holds it. Use the port the
  message suggests, or set one in the build (see [Your port](#your-port)).
- **`Docker has 2 CPUs and 2 GiB`**: the Docker VM is too small; resize it as the
  warning says, then `up` again.
- **`deploy/agent-host did not become ready`**, with `http2: client connection lost` or
  probes timing out, or new sandboxes `Pending` on `Insufficient cpu` / `Insufficient
  memory`: the Docker VM is out of room even if `up` did not warn. Give it more. colima
  applies a new size only on `colima stop` and `colima start`; when it is declared in
  home-manager (`services.colima.profiles.default`), restate `isService` and `isActive`,
  because setting the profile replaces the module's default one.
- **A pod stays `Pending` or `ImagePullBackOff`**: `scooter-local status` shows the
  pods; `scooter-local kubectl describe pod <name>` says why. Memory is the usual
  reason on a small machine.
- **`x509: certificate signed by unknown authority` pulling images**: a
  TLS-intercepting proxy re-signs traffic with a CA your machine trusts but the
  cluster's nodes don't. Point `SCOOTER_LOCAL_CA_BUNDLE` at a full bundle with that CA
  in it (with nix-darwin, `/etc/ssl/certs/ca-certificates.crt`), then
  `scooter-local destroy` and `up`: the nodes mount it only when the cluster is
  created. This covers image pulls; pods that make TLS calls of their own need the CA
  in their images.
- **Boards or settings answer 401**: the request reached Scooter without an identity.
  Check that `scooter-local kubectl get middleware local-identity -o yaml` names your
  user, and that `up` finished after upgrading.
- **A change does not show in an old conversation**: a conversation keeps the sandbox
  settings it was created with. Start a new one after changing contribs or the
  provider.
- **The agent answers nothing** with Ollama: `ollama serve` must be running and the
  model pulled; `scooter-local logs` shows goose's errors.
- **Start over**: `scooter-local destroy`, then `up`.
