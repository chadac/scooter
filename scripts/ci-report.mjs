#!/usr/bin/env node
// ci-report.mjs — ONE PR comment, written incrementally by every reporting job.
//
// A PR used to collect four separate sticky comments (image size, e2e fast, the
// e2e-full verdict, the flake verdicts) and a reader had to find them and hold
// the result in their head. This puts all of them in one comment, one
// collapsible section each, under a gate table derived from .github/ci-gates.yml.
//
// THE COMMENT IS THE STATE. Every write re-reads the posted body, replaces its
// own section, recomputes the gate table from ALL sections, and PATCHes. No
// coordinator job holds the result, so a section appears the moment its job
// finishes rather than at the end of the run — and a gate nobody has reported
// yet renders as pending instead of being silently absent.
//
// Zero runtime dependencies on purpose: the jobs that post are not all node
// jobs. `nix run nixpkgs#nodejs_22 -- scripts/ci-report.mjs …` is enough, so a
// nix-only job (image sizes, a nixosTest leg) needs no npm install.
//
// Usage:
//   ci-report.mjs post --section <id> --status <pass|fail|warn|skip> \
//     [--summary <text>] [--body <file>] [--gates <f>] [--labels a,b]
//   ci-report.mjs evaluate [--gates <f>] [--labels a,b]   # exit 1 if blocked
//     env: GH_TOKEN, GITHUB_REPOSITORY, PR
//
// `--summary` wraps the body in a <details> for you. Omit it when the job
// renders its own <details> (the e2e-full verdict does), and the body is placed
// verbatim — each job stays the author of its own presentation.

import { readFileSync } from "node:fs";

export const MARKER = "<!-- ci-report -->";
export const HEADING = "## CI";

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

/**
 * Parse .github/ci-gates.yml. A hand-rolled reader for the one shape this file
 * has — a `gates:` list of flat scalar keys — because the alternative is an npm
 * dependency in every job that posts, and the file is ours to keep simple. It
 * FAILS on anything it does not understand rather than guessing.
 */
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
  }
  return gates;
}

const coerce = (v) =>
  v === "true" ? true : v === "false" ? false : v === "" ? undefined : v;

/** The gates in play for this PR: a label-gated one only counts when labelled. */
export function activeGates(gates, labels = []) {
  return gates.filter(
    (g) =>
      (g.require ?? "always") !== "when_labelled" || labels.includes(g.label),
  );
}

/** Pull the posted sections out of a comment body, status included. */
export function parseSections(body) {
  const sections = new Map();
  if (!body) return sections;
  // Any id, not just the declared ones: a section from an older or newer commit
  // must survive a merge rather than be dropped by whoever writes next.
  const re =
    /<!-- ci:([a-z0-9-]+):start status=([a-z]+) -->\n?([\s\S]*?)\n?<!-- ci:\1:end -->/g;
  for (const m of body.matchAll(re))
    sections.set(m[1], { id: m[1], status: m[2], content: m[3].trim() });
  return sections;
}

/**
 * The gate table: what a reader sees before expanding anything.
 *
 * Derived, never stored — so whichever job writes last produces a table that
 * matches the sections around it, with no ownership and nothing to reconcile.
 */
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

/**
 * Is the PR mergeable on what has reported so far?
 *
 * `pending` counts as blocking for a gate that must answer: a gate nobody has
 * reported is not a passing gate, and treating absence as success is how an
 * opt-in suite ends up decorative.
 */
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

/**
 * Replace (or add) one section, leaving every other section untouched.
 *
 * Pure, so the retry in `post()` is trivial: re-read, re-apply, write.
 */
export function mergeSection(body, section, gates) {
  const sections = parseSections(body);
  const content =
    section.summary != null
      ? // The blank line after </summary> is load-bearing: without it GitHub
        // renders the markdown inside as literal text.
        `<details><summary>${ICON[section.status] ?? ""} <b>${section.summary}</b></summary>\n\n${section.body ?? ""}\n</details>`
      : (section.body ?? "");
  sections.set(section.id, {
    id: section.id,
    status: section.status,
    content: content.trim(),
  });
  return renderComment(sections, gates);
}

/** Did our section survive someone else's concurrent write? */
export function hasSection(body, section) {
  const s = parseSections(body).get(section.id);
  return !!s && s.status === section.status;
}

// ——— the impure half ———————————————————————————————————————————————

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

/**
 * Upsert one section on the PR, retrying if a job that finished at the same
 * moment clobbered us. Read-modify-write converges in one extra pass: two
 * writers, one section each, and re-applying ours cannot drop theirs.
 */
export async function post({ repo, pr, token, section, gates }) {
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

function main(argv) {
  const cmd = argv[0];
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : argv[i + 1];
  };
  const gates = parseGates(
    readFileSync(opt("gates", ".github/ci-gates.yml"), "utf8"),
  );
  const labels = (opt("labels", "") || "").split(",").filter(Boolean);
  const active = activeGates(gates, labels);
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR;
  const token = process.env.GH_TOKEN;

  if (cmd === "evaluate") {
    return findComment(repo, pr, token).then((c) => {
      const sections = parseSections(c?.body ?? "");
      const { blocking, pending, mergeable } = evaluateGates(sections, active);
      for (const id of blocking) console.log(`FAILING  ${id}`);
      for (const id of pending) console.log(`PENDING  ${id}`);
      console.log(mergeable ? "all gates satisfied" : "gates not satisfied");
      if (!mergeable) process.exitCode = 1;
    });
  }

  if (cmd !== "post") {
    console.error("usage: ci-report.mjs <post|evaluate> [options]");
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
  return post({
    repo,
    pr,
    token,
    gates: active,
    section: {
      id,
      status,
      summary: opt("summary"),
      body: bodyFile ? readFileSync(bodyFile, "utf8").trim() : "",
    },
  }).then((r) =>
    console.log(r.url ? `posted ${id} → ${r.url}` : `posted ${id}`),
  );
}

// Run only as a CLI, so the spec can import the pure functions above.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
  main(process.argv.slice(2));
