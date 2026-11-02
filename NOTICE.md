# Third-party notices

Scooter is licensed under the [MIT License](./LICENSE). That license covers the
source code in **this** repository only. Scooter depends on, and (for some
components) redistributes in its container images, third-party software under
the licenses summarized below. The MIT license does **not** apply to those
components — each is governed by its own license.

This file is a good-faith summary from a dependency audit, not legal advice.
Licenses can change between versions; re-audit before a release. A full,
machine-generated inventory can be produced with the commands in
[Regenerating this inventory](#regenerating-this-inventory).

## Summary

The overwhelming majority of Scooter's dependencies — across npm, Go, Python
(PyPI), and the Nix/nixpkgs runtime closure baked into the images — are under
permissive, MIT-compatible licenses (MIT, ISC, BSD-2/3-Clause, 0BSD, Apache-2.0,
Python-2.0/PSF).

The container images also redistribute, **unmodified**, a number of GNU and
other copyleft system components (GPL-2.0, GPL-3.0, LGPL) as separate programs
and dynamically linked libraries. Scooter's own code is not derived from them
and they do not change Scooter's license, but their licenses carry obligations
when the images are distributed — see
[Copyleft components in the container images](#copyleft-components-in-the-container-images).
No AGPL, SSPL or EUPL code was found.

Two components are **proprietary**: Anthropic's Claude Agent SDK and the
`claude-code` CLI. Both are shipped in some published images — see
[Proprietary components](#proprietary-components).

## Notable bundled / redistributed components

| Component | Role | License |
|---|---|---|
| [Goose](https://github.com/aaif-goose/goose) (`goose-cli`) | The ACP agent Scooter runs (bundled in the agent-host image) | Apache-2.0 |
| [`@zed-industries/agent-client-protocol`](https://github.com/zed-industries/agent-client-protocol) | ACP client library (agent-host) | Apache-2.0 |
| [`@ag-ui/*`](https://github.com/ag-ui-protocol/ag-ui) | AG-UI protocol client/core/encoder (UI + agent-host) | MIT |
| [hydra-ahp](https://github.com/smagnuso/hydra-ahp) protocol core | **Vendored** into `contrib/code-server/ahp/src/vendor/hydra-ahp` (Agent Host Protocol server core; see its LICENSE and README there) | MIT |
| [denful/dag](https://github.com/denful/dag) | **Vendored** into `contrib/aws/lib/dag` (the DAG that orders AWS approval rules; see its LICENSE there) | MIT |
| [`@microsoft/agent-host-protocol`](https://github.com/microsoft/agent-host-protocol) | Agent Host Protocol types and reducers (vscode-ahp) | MIT |
| [code-server](https://github.com/coder/code-server) (prebuilt release, bundling VS Code OSS) | Browser VS Code, fetched into the sandbox on first use | MIT |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) (`@assistant-ui/*`) | Conversation UI framework | MIT |
| [React](https://github.com/facebook/react), Radix UI, lucide-react, zustand, rxjs, remark-gfm, clsx, tailwind-merge | UI runtime deps | MIT |
| [FastAPI](https://github.com/fastapi/fastapi), Starlette, Pydantic, Uvicorn, httpx, SQLAlchemy, asyncpg, PyJWT, boto3, kubernetes, openfga-sdk, croniter | Broker / webhooks / scheduler (Python) | MIT / BSD-3-Clause / Apache-2.0 |
| `cryptography` | Python TLS/crypto (transitive) | Apache-2.0 OR BSD-3-Clause |
| `certifi`, `nss-cacert` (the CA bundle in every image), `publicsuffix-list` | CA certificates / public suffix data | MPL-2.0 |
| [client-go](https://github.com/kubernetes/client-go), apimachinery, pgx, google/uuid | conversation-router (Go) | Apache-2.0 / MIT / BSD-3-Clause |
| [Atlas](https://github.com/ariga/atlas), PostgreSQL client | db-migrator image | Apache-2.0 / PostgreSQL |
| [nginx](https://nginx.org) | UI image web server | BSD-2-Clause |
| Node.js, CPython | Runtimes in the agent-host, byoc-controller, remote-agent and Python images | MIT / Python-2.0 |
| `lightningcss`, `caniuse-lite` | **Build-time only** (CSS transform / browser data; not shipped at runtime) | MPL-2.0 / CC-BY-4.0 |

### Apache-2.0 NOTICE files

Apache-2.0 §4(d) requires redistributions to carry the `NOTICE` file of any
work that has one. These ship in Scooter's images, and their `NOTICE` files ship
alongside them (in each package's `*.dist-info/licenses/` or `node_modules/`
directory):

| Component | Image(s) | NOTICE |
|---|---|---|
| boto3, botocore, s3transfer | broker (aws contrib) | "Copyright 2012–2022 Amazon.com, Inc. or its affiliates." botocore also notes vendored parts of `requests` |
| requests | broker, scheduler, conversation-controller, warm-store-controller | "Requests — Copyright 2019 Kenneth Reitz" |
| yarl, propcache | broker | "Copyright 2016–2021, Andrew Svetlov and aio-libs team" |
| bare-path | agent-host | "Copyright 2023 Holepunch Inc" |

## Copyleft components in the container images

Every image is built with Nix from the nixpkgs revision pinned in
[`flake.lock`](./flake.lock). The components below are **unmodified** nixpkgs
builds, included as separate programs or dynamically linked shared libraries.

| Component | License | Image(s) |
|---|---|---|
| GNU Bash, GNU Coreutils | GPL-3.0-or-later | agent-host, remote-agent, ui, db-migrator |
| GNU Readline, GNU gdbm | GPL-3.0-or-later | every image with CPython (linked by the interpreter) |
| Git | GPL-2.0-only | remote-agent |
| GNU grep | GPL-3.0-or-later | db-migrator |
| GNU gettext (`envsubst`) | GPL-2.0-or-later (runtime: LGPL) | ui |
| GNU C Library (glibc), libxcrypt, libcap-ng | LGPL-2.0-or-later / LGPL-2.1 | every image |
| GCC runtime (`libgcc_s`, `libstdc++`) | GPL-3.0-or-later with the GCC Runtime Library Exception | every image |
| xz / liblzma, util-linux libraries, systemd libraries | mixed GPL/LGPL (libraries LGPL or public domain) | various (transitive) |
| Berkeley DB (via linux-pam's `pam_userdb`, linked by PostgreSQL) | Sleepycat | db-migrator |
| psycopg | LGPL-3.0-or-later | conversation-controller |
| websocket-client | LGPL-2.1-or-later | broker, conversation-controller, warm-store-controller (via the `kubernetes` client) |

The agent-sandbox OS image (`sandbox-os-image`) is a NixOS system closure and
contains many more GPL/LGPL programs (the usual GNU userland, the Linux kernel
headers, and so on); the same terms apply to it.

**License texts and source.** Each component's license text is in its upstream
source distribution and in nixpkgs
(`nix eval --raw nixpkgs#<pkg>.meta.license.spdxId` names it). The complete
corresponding source for every Nix-built component is available from the pinned
nixpkgs revision. For example, to fetch Bash's exact source:

```bash
nix build --no-link --print-out-paths "github:NixOS/nixpkgs/$(jq -r .nodes.nixpkgs.locked.rev flake.lock)#bash.src"
```

Sources are also mirrored by `cache.nixos.org`. If you received a Scooter image
and cannot obtain the source this way, open an issue on
[chadac-me/scooter](https://github.com/chadac-me/scooter/issues) and the source will
be provided.

## Proprietary components

The following are **not** open source. They are proprietary to Anthropic and
are **not** covered by Scooter's MIT license. Redistributing them is subject to
Anthropic's terms (see <https://code.claude.com/docs/en/legal-and-compliance>),
not the MIT license.

| Component | Where it ships | Status |
|---|---|---|
| [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) (JavaScript package) | `services/claude-sdk-provider`, which is bundled into the **default** agent-host image and the remote-agent image. The SDK's platform-native binaries are stripped at build time | Proprietary — "© Anthropic PBC. All rights reserved. Use is subject to the Anthropic Legal Agreements" |
| `claude-code` CLI (Claude Code) | Baked into the **remote-agent** image (`scooter-remote-agent`) and the optional `agent-host-image-claude` variant (marked `unfree` in nixpkgs) | Proprietary — Anthropic terms |

Note: [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)
(the plain Anthropic API client) **is** MIT-licensed; only the Claude Agent SDK
and the `claude-code` CLI above are proprietary.

For a fully open-source deployment, build agent-host without the Claude SDK
provider (`claudeSdkProvider = null` in `services/agent-host`), use Goose
(Apache-2.0) as the agent, and do not deploy the remote-agent image or the
`agent-host-image-claude` variant.

## Regenerating this inventory

```bash
nix develop -c just eval-licenses   # writes result-licenses/
```

It reads every committed `package-lock.json`, the vendored modules of each Go
service, and the Nix closure behind each shipped component (which also covers
the Python dependencies, as nixpkgs pins them). It writes `licenses.json` and
a static `index.html` dashboard. The Nix side is an eval-time
approximation of the runtime closure, so it can list a few build-only inputs.
