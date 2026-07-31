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

The overwhelming majority of Scooter's dependencies — across npm, Python
(PyPI), and the Nix/nixpkgs runtime closure baked into the images — are under
permissive, MIT-compatible licenses (MIT, ISC, BSD-2/3-Clause, 0BSD, Apache-2.0,
Python-2.0/PSF). A few are file-level copyleft (MPL-2.0) used only as
dependencies (not modified), which is compatible. **No GPL / LGPL / AGPL / EUPL
or other reciprocal-copyleft code was found in the dependency tree.**

The one non-open-source exception is Anthropic's Claude Agent SDK and the
`claude-code` CLI, which are **proprietary** and used under Anthropic's own
terms — see [Proprietary components](#proprietary-components).

## Notable bundled / redistributed components

| Component | Role | License |
|---|---|---|
| [Goose](https://github.com/block/goose) (`goose-cli`) | The ACP agent Scooter runs (bundled in the agent-host image) | Apache-2.0 |
| [`@zed-industries/agent-client-protocol`](https://github.com/zed-industries/agent-client-protocol) | ACP client library (agent-host) | Apache-2.0 |
| [`@ag-ui/*`](https://github.com/ag-ui-protocol/ag-ui) | AG-UI protocol client/core/encoder (UI + agent-host) | MIT |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) (`@assistant-ui/*`) | Conversation UI framework | MIT |
| [React](https://github.com/facebook/react), Radix UI, lucide-react, zustand, rxjs, remark-gfm, clsx, tailwind-merge | UI runtime deps | MIT |
| [FastAPI](https://github.com/fastapi/fastapi), Starlette, Pydantic, Uvicorn, httpx, SQLAlchemy, asyncpg, PyJWT, boto3, kubernetes, openfga-sdk, croniter | Broker / webhooks / scheduler (Python) | MIT / BSD-3-Clause / Apache-2.0 |
| `cryptography`, `certifi` | Python TLS/crypto (transitive) | Apache-2.0 OR BSD-3-Clause; `certifi` MPL-2.0 |
| `lightningcss`, `caniuse-lite` | **Build-time only** (CSS transform / browser data; not shipped at runtime) | MPL-2.0 / CC-BY-4.0 |
| nixpkgs runtime closure (coreutils, Python interpreter, glibc, etc.) | Sandbox / service base images | Permissive (MIT / BSD / Apache-2.0) and, for a few system libraries, LGPL where dynamically linked |

## Proprietary components

The following are **not** open source. Scooter can use them (the agent-host can
drive Goose's `claude-code` provider, and the isolated Claude Agent SDK provider
wraps the SDK), but they are proprietary to Anthropic and are **not** covered by
Scooter's MIT license. Redistributing them (e.g. in a published image that bakes
the `claude` CLI) is subject to Anthropic's terms, not the MIT license.

| Component | Where used | Status |
|---|---|---|
| [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) | `services/claude-sdk-provider` | Proprietary — "© Anthropic PBC. All rights reserved. Use is subject to the Anthropic Legal Agreements" (see <https://code.claude.com/docs/en/legal-and-compliance>) |
| `claude-code` CLI (Claude Code) | Baked **only** into the optional `agent-host-image-claude` image variant (marked `unfree` in nixpkgs) | Proprietary — Anthropic terms |

Note: [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript)
(the plain Anthropic API client) **is** MIT-licensed; only the Claude Agent SDK
and the `claude-code` CLI above are proprietary.

If you need a fully open-source deployment, use the default agent-host image
(Goose / Apache-2.0) and avoid the `claude-code` provider and the
`agent-host-image-claude` variant.

## Regenerating this inventory

```bash
# npm (run at the repo root — workspaces hoist into ./node_modules):
npx license-checker-rseidelsohn --summary --excludePrivatePackages

# Python (per service venv):
pip-licenses --summary          # or read each *.dist-info/METADATA

# Nix component licenses:
nix eval --raw nixpkgs#goose-cli.meta.license.spdxId
nix eval nixpkgs#claude-code.meta.license --json
```
