#!/usr/bin/env node
// ci-report.mjs — one PR comment, written incrementally by every reporting job:
// one collapsible section per job under a gate table derived from
// .github/ci-gates.yml. The comment is the state: every write re-reads the posted
// body, replaces its own section, recomputes the gate table from all sections and
// PATCHes, so a gate nobody has reported yet renders as pending. Zero runtime
// dependencies, so a nix-only job can run it with the runner's node.
//
// `post` also saves its section to <sections-dir>/<id>.json, which the job uploads
// as artifact `ci-section-<id>`. `evaluate` reads only those, never the comment: the
// comment outlives a push, so its sections may describe another commit.
//
// A run's tier decides which gates are in play: `pr` (the default for a PR) runs the
// fast checks, `full` (the merge queue, main, the nightly, or a PR labelled
// `full-ci`) runs everything. A change to only RELEASE_FILES gets `skip` on the PR,
// which runs nothing, and `release` in the merge queue, which runs the full tier
// plus every gate marked `release: true`, each made required.
//
// Usage:
//   ci-report.mjs post --section <id> --status <pass|fail|warn|skip> \
//     [--summary <text>] [--body <file>] [--gates <f>] [--labels a,b] [--sections-dir <d>]
//   ci-report.mjs evaluate [--gates <f>] [--labels a,b] [--sections-dir <d>]   # exit 1 if blocked
//   ci-report.mjs tier [--labels a,b]   # writes full=, release=, skip=<true|false> to $GITHUB_OUTPUT
//     env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, PR (unset outside a PR),
//     BASE_SHA + HEAD_SHA (the compared range; unset, no run is a release);
//     <sections-dir> defaults to $RUNNER_TEMP/ci-sections
//
// `--summary` wraps the body in a <details>; omit it when the job renders its own
// and the body is placed verbatim.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MARKER = "<!-- ci-report -->";
export const HEADING = "## CI";

/** The PR label that runs the merge-queue suite on the PR itself. */
export const FULL_TIER_LABEL = "full-ci";

/** The files a release PR may touch; anything else needs real CI. */
export const RELEASE_FILES = ["VERSION", "CHANGELOG.md"];

/** Whether a change set is a release bump and nothing else. */
export const isReleaseOnly = (files) =>
  files.length > 0 && files.every((f) => RELEASE_FILES.includes(f));

/** For a release-only change, `skip` on the PR and `release` in the queue; else `pr` for an unlabelled PR, else `full`. */
export function tierFor(event, labels = [], files = []) {
  if (isReleaseOnly(files)) {
    if (event === "pull_request") return "skip";
    if (event === "merge_group") return "release";
  }
  return event !== "pull_request" || labels.includes(FULL_TIER_LABEL)
    ? "full"
    : "pr";
}

/** Terminal states a section can report, plus the implicit `pending`. */
export const STATUSES = ["pass", "fail", "warn", "skip", "pending"];

const ICON = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  skip: "⏭️",
  pending: "⏳",
};

const startTag = (id, status) => `<!-- ci:${id}:start status=${status} -->`;
const endTag = (id) => `<!-- ci:${id}:end -->`;

/** Parse .github/ci-gates.yml, a `gates:` list of flat scalar keys, failing on anything else rather than guessing. */
export function parseGates(text) {
  const gates = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\s+$/, "");
    if (!line || /^\s*#/.test(line) || /^gates:\s*$/.test(line)) continue;
    const item = line.match(/^ {2}- (\w[\w-]*):\s*(.*)$/);
    if (item) {
      cur = { [item[1]]: coerce(item[2]) };
      gates.push(cur);
      continue;
    }
    const kv = line.match(/^ {4}(\w[\w-]*):\s*(.*)$/);
    if (kv && cur) {
      cur[kv[1]] = coerce(kv[2]);
      continue;
    }
    throw new Error(`ci-gates.yml: cannot parse line: ${raw}`);
  }
  for (const g of gates) {
    if (!g.id) throw new Error("ci-gates.yml: a gate has no id");
    if (!["always", "when_labelled", "never"].includes(g.require ?? "always"))
      throw new Error(`ci-gates.yml: ${g.id}: bad require: ${g.require}`);
    if (g.require === "when_labelled" && !g.label)
      throw new Error(`ci-gates.yml: ${g.id}: when_labelled needs a label`);
    if (!["pr", "full"].includes(g.tier ?? "pr"))
      throw new Error(`ci-gates.yml: ${g.id}: bad tier: ${g.tier}`);
  }
  return gates;
}

const coerce = (v) =>
  v === "true" ? true : v === "false" ? false : v === "" ? undefined : v;

/** The gates in play: a label-gated one needs its label, a `full` one the full tier. */
export function activeGates(gates, labels = [], tier = "full") {
  if (tier === "skip") return [];
  if (tier === "release") {
    const full = activeGates(gates, labels, "full");
    return gates
      .filter((g) => g.release || full.includes(g))
      .map((g) =>
        g.release
          ? {
              ...g,
              require: "always",
              advisory: false,
              block_while_pending: true,
            }
          : g,
      );
  }
  return gates.filter(
    (g) =>
      ((g.require ?? "always") !== "when_labelled" ||
        labels.includes(g.label)) &&
      (tier === "full" || (g.tier ?? "pr") === "pr"),
  );
}

/** Pull the posted sections out of a comment body, status included. */
export function parseSections(body) {
  const sections = new Map();
  if (!body) return sections;
  // Any id, not just the declared ones, so a section from another commit survives a merge.
  const re =
    /<!-- ci:([a-z0-9-]+):start status=([a-z]+) -->\n?([\s\S]*?)\n?<!-- ci:\1:end -->/g;
  for (const m of body.matchAll(re))
    sections.set(m[1], { id: m[1], status: m[2], content: m[3].trim() });
  return sections;
}

/** The gate table a reader sees before expanding anything; derived from the sections, never stored. */
export function gateTable(sections, gates) {
  const rows = gates.map((g) => {
    const s = sections.get(g.id);
    const status = s?.status ?? "pending";
    const policy = g.advisory
      ? "advisory"
      : (g.require ?? "always") === "when_labelled"
        ? `required · \`${g.label}\``
        : "required";
    return `| ${g.name} | ${policy} | ${ICON[status] ?? "·"} ${status} |`;
  });
  return ["| gate | policy | |", "|---|---|---|", ...rows].join("\n");
}

/** Whether the PR is mergeable on what has reported so far; `pending` blocks for a gate that must answer, since an unreported gate is not a passing gate. */
export function evaluateGates(sections, gates) {
  const blocking = [];
  const pending = [];
  for (const g of gates) {
    const status = sections.get(g.id)?.status ?? "pending";
    if (status === "pending") {
      if (g.block_while_pending !== false) pending.push(g.id);
      continue;
    }
    if (g.advisory || status === "pass" || status === "skip") continue;
    blocking.push(g.id);
  }
  return { blocking, pending, mergeable: !blocking.length && !pending.length };
}

/** The whole comment: marker, gate table, then one section per gate in file order. */
export function renderComment(sections, gates) {
  const ids = [
    ...gates.map((g) => g.id).filter((id) => sections.has(id)),
    // Unknown ids last, so a stale section is visible rather than lost.
    ...[...sections.keys()].filter((id) => !gates.some((g) => g.id === id)),
  ];
  const blocks = ids.map((id) => {
    const s = sections.get(id);
    return `${startTag(id, s.status)}\n${s.content}\n${endTag(id)}`;
  });
  const { blocking, pending } = evaluateGates(sections, gates);
  const verdict = blocking.length
    ? `❌ ${blocking.length} gate${blocking.length === 1 ? "" : "s"} failing`
    : pending.length
      ? `⏳ ${pending.length} gate${pending.length === 1 ? "" : "s"} still to report`
      : "✅ all gates satisfied";
  return [
    MARKER,
    "",
    `${HEADING} — ${verdict}`,
    "",
    gateTable(sections, gates),
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
}

/** Replace or add one section, leaving every other untouched; pure, so `post()` can retry by re-reading and re-applying. */
export function mergeSection(body, section, gates) {
  const sections = parseSections(body);
  sections.set(section.id, renderSection(section));
  return renderComment(sections, gates);
}

/** A posted section as stored: id, status and its rendered markdown. */
export function renderSection(section) {
  const content =
    section.summary != null
      ? // The blank line after </summary> is required or GitHub renders the
        // markdown inside as literal text.
        `<details><summary>${ICON[section.status] ?? ""} <b>${section.summary}</b></summary>\n\n${section.body ?? ""}\n</details>`
      : (section.body ?? "");
  return { id: section.id, status: section.status, content: content.trim() };
}

/** Save a section as `<dir>/<id>.json`, which the job uploads as artifact `ci-section-<id>`. */
export function saveSection(dir, section) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${section.id}.json`),
    JSON.stringify(renderSection(section)),
  );
}

/** Read the sections saved by `saveSection`; a missing dir means none. */
export function readSavedSections(dir) {
  const sections = new Map();
  if (!existsSync(dir)) return sections;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const s = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (s.id && STATUSES.includes(s.status)) sections.set(s.id, s);
  }
  return sections;
}

/** Did our section survive someone else's concurrent write? */
export function hasSection(body, section) {
  const s = parseSections(body).get(section.id);
  return !!s && s.status === section.status;
}

// ——— the impure half ———————————————————————————————————————————————

/** Files changed between BASE_SHA and HEAD_SHA; empty when either is unset. */
async function changedFiles(repo, token) {
  const { BASE_SHA: base, HEAD_SHA: head } = process.env;
  if (!base || !head) return [];
  // Capped at 300 files, far past any release-only change.
  const cmp = await api(`repos/${repo}/compare/${base}...${head}`, token);
  return (cmp.files ?? []).map((f) => f.filename);
}

const api = async (path, token, init = {}) => {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok)
    throw new Error(
      `GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`,
    );
  return res.status === 204 ? null : res.json();
};

async function findComment(repo, pr, token) {
  for (let page = 1; page <= 10; page++) {
    const batch = await api(
      `repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`,
      token,
    );
    const hit = batch.find((c) => c.body?.includes(MARKER));
    if (hit) return hit;
    if (batch.length < 100) return null;
  }
  return null;
}

/** Upsert one section on the PR, retrying if a concurrent writer clobbered it; re-applying ours cannot drop theirs. */
export async function post({ repo, pr, token, section, gates }) {
  // The merge queue, main and the nightly have no PR to comment on.
  if (!pr) return { url: null, attempt: 0 };
  try {
    return await upsert({ repo, pr, token, section, gates });
  } catch (e) {
    // Fork PR tokens are read-only; evaluate reads saved sections.
    console.warn(`::warning::could not write the CI comment: ${e.message}`);
    return { url: null, attempt: 0 };
  }
}

async function upsert({ repo, pr, token, section, gates }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const existing = await findComment(repo, pr, token);
    const merged = mergeSection(existing?.body ?? "", section, gates);
    if (existing)
      await api(`repos/${repo}/issues/comments/${existing.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ body: merged }),
      });
    else
      await api(`repos/${repo}/issues/${pr}/comments`, token, {
        method: "POST",
        body: JSON.stringify({ body: merged }),
      });
    const check = await findComment(repo, pr, token);
    if (check && hasSection(check.body, section))
      return { url: check.html_url, attempt };
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  // Never fail a job over a comment: the section's own check still stands.
  console.warn(
    `::warning::could not confirm section '${section.id}' after 3 attempts`,
  );
  return { url: null, attempt: 3 };
}

async function main(argv) {
  const cmd = argv[0];
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : argv[i + 1];
  };
  const gates = parseGates(
    readFileSync(opt("gates", ".github/ci-gates.yml"), "utf8"),
  );
  const labels = (opt("labels", "") || "").split(",").filter(Boolean);
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR;
  const token = process.env.GH_TOKEN;
  const files = await changedFiles(repo, token);
  const tier = tierFor(process.env.GITHUB_EVENT_NAME, labels, files);
  const active = activeGates(gates, labels, tier);
  const dir = opt(
    "sections-dir",
    join(process.env.RUNNER_TEMP ?? ".", "ci-sections"),
  );

  if (cmd === "evaluate") {
    const sections = readSavedSections(dir);
    console.log(`tier: ${tier}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        renderComment(sections, active),
      );
    const { blocking, pending, mergeable } = evaluateGates(sections, active);
    for (const id of blocking) console.log(`FAILING  ${id}`);
    for (const id of pending) console.log(`PENDING  ${id}`);
    console.log(mergeable ? "all gates satisfied" : "gates not satisfied");
    if (!mergeable) process.exitCode = 1;
    return;
  }

  if (cmd === "tier") {
    const full = tier === "full" || tier === "release";
    const line = `full=${full}\nrelease=${tier === "release"}\nskip=${tier === "skip"}\n`;
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, line);
    process.stdout.write(line);
    return;
  }

  if (cmd !== "post") {
    console.error("usage: ci-report.mjs <post|evaluate|tier> [options]");
    process.exitCode = 2;
    return;
  }
  const id = opt("section");
  const status = opt("status");
  if (!id || !STATUSES.includes(status)) {
    console.error(
      `--section <id> and --status <${STATUSES.join("|")}> are required`,
    );
    process.exitCode = 2;
    return;
  }
  const bodyFile = opt("body");
  const section = {
    id,
    status,
    summary: opt("summary"),
    body: bodyFile ? readFileSync(bodyFile, "utf8").trim() : "",
  };
  saveSection(dir, section);
  return post({ repo, pr, token, gates: active, section }).then((r) =>
    console.log(r.url ? `posted ${id} → ${r.url}` : `saved ${id} to ${dir}`),
  );
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
