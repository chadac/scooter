# Multimodal image support — design spec

**Status:** Research/Design (PoC stages 1–2). Tests + impl follow.

## Goal

Users send **images** to the agent from every entrypoint — UI upload, Slack image
posts, JIRA attachments (follow-up) — and goose actually *sees* them (vision).

## Research verdict

It's text-only end-to-end today, but **every layer is already content-array-shaped
and just never populated**, and — the key unblock — **ACP supports native image
content blocks**:

```
// @zed-industries/agent-client-protocol schema: a prompt ContentBlock
{ type: "image"; data: <base64>; mimeType: string; uri?: string }
```

So the target format all the way to goose is a base64 image ACP block. Bedrock
Claude is multimodal, so the path works end to end (goose + provider forward the
block — verified at the protocol layer; confirm live in the e2e).

## Decisions (from planning)

| Question | Choice |
|----------|--------|
| Wire format | **Base64 content parts** — `messages[].content` becomes `string \| ContentPart[]`, an image part is `{ type: "image"; data/base64; mimeType }`. Mapped to the ACP `image` block at the bridge. |
| First entrypoints | **UI upload + Slack** end-to-end (goose sees the image). JIRA is a follow-up on the same pipe. |
| Persistence | **Configurable `AssetStore`, blob-by-default** — an assets store (per-conversation blob dir on a PVC by default; S3 an optional backend later, since not every deploy has S3). The event log stores only a small **reference** (id + mimeType + a fetch URL), never the bytes. |
| Size cap | **~5MB/image, configurable** — client-side downscale on upload + a hard server-side reject over the cap. |
| Scope | Core pipe + UI + Slack in **one PR**; JIRA a follow-up. |

## The shared pipe (what every entrypoint feeds)

```
entrypoint (UI / Slack / JIRA)
   └─ image bytes + mimeType
        │  save to AssetStore -> assetId  (bytes on the PVC/S3, once)
        ▼
   POST /agui  messages:[{ role, content: [ {type:text,text}, {type:image, assetId, mimeType} ] }]
        │  (or content:string for a text-only message — back-compat)
        ▼
   agui/server -> promptHandler -> sessions.promptByThread(threadId, parts)
        ▼
   bridge.prompt(parts)  ── for each image part: AssetStore.read(assetId) -> base64
        ▼
   ACP prompt: [ {type:"text",text}, {type:"image", data:<base64>, mimeType} ]  -> goose
        │
   persist: an IMAGE ref event in events.jsonl (assetId + mimeType + url), NOT the bytes
        ▼
   replay/refresh: UI renders the image via GET /conversations/:id/assets/:assetId
```

## Components

### 1. `AssetStore` seam (new — `session/assetStore.ts`)
Configurable, pluggable. Stores image bytes once per conversation; the rest of the
system passes an `assetId`.

```
interface AssetStore {
  put(conversationId, { data: Buffer, mimeType }): Promise<{ assetId, url }>
  read(conversationId, assetId): Promise<{ data: Buffer, mimeType } | null>
  // url = /conversations/:id/assets/:assetId (served by the management API)
}
```
- **PVC backend (default):** bytes under `{statePath}/{conversationId}/assets/{assetId}`
  (alongside events.jsonl). No new infra.
- **S3 backend (optional, later):** same interface, bytes in a bucket.
- Config: `ASSET_STORE=pvc|s3`, `ASSET_MAX_BYTES` (default ~5MB).

### 2. Content parts through the protocol
- **UI/client:** `messages[].content: string | ContentPart[]` where an image part is
  `{ type: "image"; assetId?; data?; mimeType }` (the browser sends `data` base64;
  the agent-host stores it and rewrites to `assetId`).
- **`/agui` (`agui/server.ts`):** stop assuming `content` is a string — normalize a
  message's content into `{ text, images: [{assetId, mimeType}] }`. Text-only stays
  a plain string (back-compat). Oversize image → 413 / a run-error the UI shows.
- **`promptByThread` / bridge `PromptInput`:** carry `images` alongside `text`.
- **`acp/client.ts` `ContentBlock`:** add the `image` variant; `bridge` maps each
  image part → read bytes from the AssetStore → base64 → ACP image block.

### 3. Persistence + replay
- A new AG-UI event (or a field on the user message) records the image **reference**
  (assetId + mimeType + url) — small, checksum-stable. NEVER the base64 bytes in
  events.jsonl.
- `loadHistory` (UI) folds image refs into the message so a refresh re-renders the
  image via its URL. `GET /conversations/:id/assets/:assetId` streams the bytes
  (from the AssetStore) with the right content-type.

### 4. UI upload (entrypoint 1 — end-to-end)
- assistant-ui's composer attachments are ALREADY wired (render-only). Serialize an
  attached image → base64, **downscale client-side** if over the cap, include it as
  an image content part in `send()` (`integrityAgent.ts` + `RuntimeProvider.ts`,
  which currently drop everything but `content: string`).
- Render the user's own image in the thread (assistant-ui attachment view) + on
  replay.

### 5. Slack images (entrypoint 2 — end-to-end)
- `slack.py`: read the event's `files` array (ignored today). For each image file,
  download `url_private_download` with the bot token (`settings.slack_bot_token`,
  Bearer — the download path is new; the auth exists). Enforce the size cap.
- `agent_host_client.py`: POST `messages[].content` as parts (text + image data),
  so the agent-host stores them in the AssetStore like a UI upload. (Same /agui
  contract — the entrypoint is just another producer of content parts.)

### 6. JIRA (follow-up, not this PR)
ADF media nodes + the attachment API via Atlassian OAuth. Same pipe (produce image
parts). Documented so the pipe is built toward it.

## Areas of uncertainty (resolve into design/impl)

1. **Does goose forward an ACP image block to the Bedrock model?** Protocol-verified;
   must confirm live (the real-goose e2e). If goose drops it, fallback: write the
   image into the sandbox + a resource_link + a note (degraded, no vision).
2. **Event/replay shape** — a dedicated `IMAGE`/attachment AG-UI event vs. carrying
   refs on the user TEXT message. Must keep the integrity checksum stable and the
   ag-ui applier happy (the RUN_ERROR-dropped-by-base-applier lesson).
3. **AssetStore lifecycle** — assets deleted with the conversation (destroy); GC of
   orphaned uploads; sharding (any shard reads the assetId — PVC is per-shard, so an
   S3/shared backend is the sharding-clean option later).
4. **Size cap enforcement** on 3 sides — client downscale, server hard reject
   (413), and Slack-download cap — plus a friendly UI error.
5. **Security** — the assets route must enforce the same conversation visibility as
   the rest; don't let an arbitrary assetId leak across conversations.
6. **MIME allow-list** — images only (png/jpeg/gif/webp); reject other types for now.

## Out of scope (this PR)
- JIRA + GitHub/GitLab markdown image inference (follow-ups on the pipe).
- Audio/video (ACP has audio blocks; not now).
- Agent-PRODUCED images (only inbound user→agent here).
- S3 asset backend (interface ready; PVC backend ships first).

## Test seams
- **Tier 1 (contract):**
  - `AssetStore` (PVC): put→read round-trip, size-cap reject, per-conversation
    isolation, mime allow-list.
  - `/agui` content normalization: a message with text+image parts → `{text, images}`;
    a plain string stays text (back-compat); oversize → error.
  - bridge: image parts → ACP image blocks (read AssetStore → base64) alongside text;
    a text-only prompt is unchanged.
  - persistence/replay: an image message stores a REF (not bytes); loadHistory folds
    it back; the assets route streams bytes with the right content-type + conversation
    scoping.
  - Slack: the `files` array → downloaded bytes → image parts (fake Slack file API +
    bot token; size-cap enforced).
- **check-manifests:** `ASSET_STORE` / `ASSET_MAX_BYTES` render; the assets PVC/dir.
- **Tier 3 (e2e):** UI — attach an image, send, see it in the thread + on refresh;
  the fake agent echoes "saw an image". One real-goose e2e confirms vision (gated).
