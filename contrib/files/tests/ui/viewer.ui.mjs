// Drives the viewer's frontend (contrib/files/viewer-ui) in a real browser. The
// pytest suites and the nixosTest stop at HTTP, and every bug a reviewer has hit in
// this page lived above it: a comment button that did nothing, a submit that could
// be pressed twice into two comments, replies and deletes that did not exist.
//
// Self-contained: it starts server.py over a scratch workspace and a stub broker,
// so it needs nothing running and leaves nothing behind.
//
//   PW_CHROME=... node contrib/files/tests/ui/viewer.ui.mjs
//
// PW_CHROME is the pinned browser the dev shell exports. FILES_VIEWER_STATIC is the
// built frontend (default: viewer-ui/dist, so run `npm run build` there first, or
// point it at `nix build`'s output); FILES_VIEWER_PYTHON the interpreter for
// server.py (default: python3).

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const viewerDir = resolve(here, "../../viewer");
const staticDir = process.env.FILES_VIEWER_STATIC || resolve(here, "../../viewer-ui/dist");
const python = process.env.FILES_VIEWER_PYTHON || "python3";

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

// --- fixture: a workspace, a stub broker, the viewer ------------------------------

const root = realpathSync(mkdtempSync(join(tmpdir(), "files-ui-")));
const ws = join(root, "workspace");
mkdirSync(join(ws, "docs"), { recursive: true });
mkdirSync(join(ws, "src"), { recursive: true });

// A selection across a hard wrap and inline markup quotes all of it.
const DOC = `# Review me

The viewer renders a document from the sandbox so that a **reader** can select a
passage of it and leave a comment the agent will see on its next turn.

A second paragraph, so that two threads have somewhere different to live.

\`\`\`python
def greet(name):
    return f"hello {name}"
\`\`\`

<!-- scooter:question id=pick kind=single -->
Which renderer should ship first?
- [ ] markdown
- [ ] code
<!-- /scooter:question -->

${Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1}, so the next section starts below the fold.`).join("\n\n")}

## Later section

See [the sample](../src/sample.py), or go [back up](#review-me).

![a dot](dot.png)

${Array.from({ length: 40 }, (_, i) => `Trailing paragraph ${i + 1}, so the page can scroll the section to its top.`).join("\n\n")}
`;
writeFileSync(join(ws, "docs/review.md"), DOC);
const CODE = Array.from({ length: 12 }, (_, i) => `value_${i + 1} = ${i + 1}`).join("\n") + "\n";
writeFileSync(join(ws, "src/sample.py"), CODE);
writeFileSync(join(root, "token"), "test-token\n");
// A 1×1 PNG, so the document has an image to resolve through /api/raw.
writeFileSync(
  join(ws, "docs/dot.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

// The ways an agent shares an image in a document besides a relative ![](…).
writeFileSync(
  join(ws, "docs/images.md"),
  `# Images\n\n![by host path](${ws}/docs/dot.png)\n\n<p align="center"><img src="dot.png" width="40" alt="html dot"></p>\n\nInline <img src="./dot.png" alt="inline dot"> too.\n`,
);

// The broker's annotation store, reduced to a map. PUT is slowed so the in-flight
// state is long enough to press submit twice into.
const store = new Map();
const broker = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const path = new URL(req.url, "http://x").pathname.replace(/^\/files\/annotations/, "");
    const send = (o) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.method === "PUT") {
      await new Promise((r) => setTimeout(r, 400));
      const rec = JSON.parse(body);
      store.set(path.slice(1), rec);
      return send({ annotation: rec });
    }
    if (req.method === "DELETE") {
      store.delete(path.slice(1));
      return send({});
    }
    if (req.method === "GET") return send({ annotations: [...store.values()] });
    return send({}); // thread resolve
  });
});
await new Promise((r) => broker.listen(0, "127.0.0.1", r));

const port = 7890 + Math.floor(Math.random() * 100);
const base = "/c/ui-test/files";
const viewer = spawn(python, [join(viewerDir, "server.py")], {
  env: {
    ...process.env,
    SCOOTER_FILES_ROOT: ws,
    SCOOTER_FILES_BASE: base,
    SCOOTER_FILES_PORT: String(port),
    SCOOTER_FILES_STATIC: staticDir,
    SCOOTER_FILES_STATE: join(root, "annotations.json"),
    BROKER_URL: `http://127.0.0.1:${broker.address().port}`,
    BROKER_TOKEN_PATH: join(root, "token"),
    // The stub broker is the only sink, so test comments don't wake this conversation.
    SCOOTER_SELF_URL: "",
    SCOOTER_SELF_TOKEN_PATH: "",
    CONVERSATION_ID: "",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const url = `http://127.0.0.1:${port}${base}`;
for (let i = 0; ; i++) {
  try {
    const health = await (await fetch(`${url}/api/health`)).json();
    if (!health.frontend) throw new Error(`no built frontend at ${staticDir}`);
    break;
  } catch (err) {
    if (i > 50 || String(err).includes("frontend")) throw err;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// The viewer delivers to the broker from a background outbox, so what reaches the
// broker is polled for rather than slept on.
async function until(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const api = async (p) => (await fetch(`${url}/api/${p}`)).json();
const notes = async (path) => (await api(`annotations?path=${encodeURIComponent(path)}`)).annotations;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  // --- markdown: select, comment, reply, delete -----------------------------------

  await page.goto(`${url}/?path=docs/review.md`);
  await page.locator("article h1").waitFor();
  check("the document renders", (await page.locator("article h1").textContent()) === "Review me");
  check("the tab is titled by the document's heading", (await page.title()) === "Review me · Files", await page.title());
  check("the page has a favicon", (await page.locator('link[rel="icon"]').count()) === 1);
  // Shiki highlights after first paint.
  check("code fences are highlighted", await page.locator("article pre.shiki").waitFor({ timeout: 10_000 }).then(() => true, () => false));

  // Drag-select from `from` to `to`, across element boundaries.
  const select = async (index, from, to) => {
    const para = page.locator("article p").nth(index);
    await para.scrollIntoViewIfNeeded();
    await para.evaluate((p, [from, to]) => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let all = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push([n, all.length]), (all += n.data);
      const at = (i) => {
        const [n, start] = nodes.findLast(([, s]) => s <= i);
        return [n, i - start];
      };
      const a = all.indexOf(from);
      const b = all.indexOf(to, a) + to.length;
      const r = document.createRange();
      r.setStart(...at(a));
      r.setEnd(...at(b - 1));
      r.setEnd(r.endContainer, r.endOffset + 1);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, [from, to]);
  };

  await select(0, "so that a", "leave a comment");
  const offer = page.getByRole("button", { name: "Comment", exact: true }).first();
  await offer.waitFor();
  await offer.click();
  const composer = page.locator("[data-comments] textarea");
  check("selecting text opens a composer", (await composer.count()) === 1);
  await composer.fill("first thought");
  const submit = page.locator("[data-comments]").getByRole("button", { name: "Comment", exact: true });
  await submit.click();
  // The broker holds PUT for 400 ms; the button must not accept a second press.
  const locked = await submit.isDisabled().catch(() => true);
  await submit.click({ timeout: 300 }).catch(() => {});
  check("the submit button is locked while in flight", locked);
  await page.locator("[data-thread]").first().waitFor();
  await page.waitForTimeout(600);
  let mine = await notes("docs/review.md");
  check("a second press leaves one comment, not two", mine.length === 1, `${mine.length} written`);
  const first = mine[0];
  check(
    "the comment anchors to the paragraph's source line",
    first?.line === 3,
    JSON.stringify(first && { line: first.line }),
  );
  check(
    "the quote is the whole selection, as the source spells it",
    first?.quote === "so that a **reader** can select a\npassage of it and leave a comment",
    JSON.stringify(first?.quote),
  );
  check(
    "the quoted passage is painted, all of it",
    await page.evaluate(() => {
      const h = CSS.highlights.get("comment");
      if (h?.size !== 1) return false;
      const [r] = h;
      return r.toString().replace(/\s+/g, " ") === "so that a reader can select a passage of it and leave a comment";
    }),
  );

  // A reply lands inside its thread, and adds no second mark in the text.
  const card = page.locator(`[data-thread="${first.thread}"]`);
  await card.getByRole("button", { name: "Reply" }).click();
  await card.locator("textarea").fill("and a reply");
  await card.getByRole("button", { name: "Reply", exact: true }).last().click();
  await card.getByText("and a reply").waitFor();
  mine = await notes("docs/review.md");
  check(
    "a reply shares its parent's thread",
    mine.length === 2 && new Set(mine.map((a) => a.thread)).size === 1,
    JSON.stringify(mine.map((a) => a.thread)),
  );
  check("a reply is one card, not two", (await page.locator("[data-thread]").count()) === 1);
  check("a reply adds no second mark", await page.evaluate(() => CSS.highlights.get("comment")?.size === 1));

  // The broker acks; the "sending" badge must clear on its own.
  await page.waitForFunction(() => !document.body.innerText.includes("sending"), null, { timeout: 10_000 }).catch(() => {});
  check("the sending badge clears with no user action", !(await page.locator("body").innerText()).includes("sending"));
  check("the broker received both", await until(() => store.size === 2), `${store.size} at the broker`);

  // A second thread, to show a delete leaves it alone.
  const second = page.locator("article p").nth(1);
  // Step across the margin: the button must survive the trip.
  const pbox = await second.boundingBox();
  const gutter = page.getByRole("button", { name: "Comment on this paragraph" });
  // Entering from the side reaches the margin before any text.
  await page.mouse.move(5, pbox.y + pbox.height / 2);
  await page.mouse.move(pbox.x - 16, pbox.y + pbox.height / 2, { steps: 12 });
  const fromMargin = await gutter.boundingBox().catch(() => null);
  check(
    "the margin alone shows the paragraph's button",
    !!fromMargin && Math.abs(fromMargin.y - pbox.y) < 2,
    JSON.stringify({ button: fromMargin?.y, para: pbox.y }),
  );
  await page.mouse.move(pbox.x + 40, pbox.y + pbox.height / 2);
  await gutter.waitFor();
  const btn = await gutter.boundingBox();
  await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2, { steps: 12 });
  check("the margin button stays while the pointer travels to it", await gutter.isVisible());
  await page.mouse.down();
  await page.mouse.up();
  check("the margin button opens a composer", (await composer.count()) === 1);
  await composer.fill("second thread");
  await submit.click();
  await page.locator("[data-thread]").nth(1).waitFor();
  const para = (await notes("docs/review.md")).find((a) => a.text === "second thread");
  check(
    "a paragraph comment quotes the whole paragraph",
    para?.line === 6 && para.quote === "A second paragraph, so that two threads have somewhere different to live.",
    JSON.stringify(para && { line: para.line, quote: para.quote }),
  );
  check(
    "a paragraph comment is marked in the margin, not painted",
    (await page.locator("[data-mark]").count()) === 2 &&
      (await page.evaluate(() => CSS.highlights.get("comment")?.size === 1)),
    `${await page.locator("[data-mark]").count()} marks`,
  );
  const markTop = await page.locator("[data-mark]").nth(1).evaluate((m) => m.getBoundingClientRect().top);
  const paraTop = await second.evaluate((p) => p.getBoundingClientRect().top);
  check("the marker sits beside its paragraph", Math.abs(markTop - paraTop) < 4, `${markTop} vs ${paraTop}`);

  // The margin below the first screen keeps the button too.
  await page.setViewportSize({ width: 1440, height: 320 });
  const last = page.locator("article p").last();
  await last.scrollIntoViewIfNeeded();
  const lbox = await last.boundingBox();
  await page.mouse.move(lbox.x + 40, lbox.y + lbox.height / 2);
  await gutter.waitFor();
  const lbtn = await gutter.boundingBox();
  await page.mouse.move(lbtn.x + lbtn.width / 2, lbtn.y + lbtn.height / 2, { steps: 12 });
  check(
    "the margin button stays below the first screenful",
    (await gutter.isVisible()) && Math.abs((await gutter.boundingBox()).y - lbox.y) < 2,
    JSON.stringify({ scrolledBy: await page.locator("article").evaluate((a) => -a.getBoundingClientRect().top) }),
  );
  await page.mouse.move(5, 5);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("[data-mark]").nth(1).click();
  check(
    "the marker opens its thread",
    (await page.locator(`[data-thread="${para?.thread}"]`).getAttribute("class"))?.includes("border-brand"),
  );
  const cards = await page.locator("[data-thread]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  check("the cards do not overlap", cards.length === 2 && cards[0].bottom <= cards[1].top, JSON.stringify(cards));

  // Deleting a reply keeps the comment; deleting a thread's opener takes its replies.
  await card.locator("li").nth(1).hover();
  await card.getByRole("button", { name: "Delete reply" }).click();
  await card.getByText("and a reply").waitFor({ state: "detached" });
  check("deleting a reply leaves the comment", (await notes("docs/review.md")).length === 2);
  await card.locator("li").first().hover();
  await card.getByRole("button", { name: "Delete comment" }).click();
  await card.waitFor({ state: "detached" });
  const left = await notes("docs/review.md");
  check("deleting one thread leaves the other", left.length === 1 && left[0].text === "second thread", JSON.stringify(left.map((a) => a.text)));
  check("deletes reach the broker", await until(() => store.size === 1), `${store.size} at the broker`);

  const slot = page.locator(`[id="thread-${left[0].thread}"]`);
  const folded = slot.locator('button[aria-expanded="false"]');
  await slot.getByRole("button", { name: "Collapse thread" }).click();
  await folded.waitFor();
  check("an open thread collapses", (await slot.locator("[data-thread]").count()) === 0);
  await folded.click();
  await slot.locator("[data-thread]").waitFor();
  // Fresh load, so Resolve is the card's first click.
  await page.reload();
  await slot.getByRole("button", { name: "Resolve" }).waitFor();
  // Hold the request: the fold must not wait for the server.
  let release;
  const held = new Promise((r) => (release = r));
  const route = /\/annotations\/threads\/[^/]+\/resolve$/;
  await page.route(route, async (r) => { await held; await r.continue(); });
  await slot.getByRole("button", { name: "Resolve" }).click();
  check("resolving folds the thread before the server answers", await folded.waitFor({ timeout: 1000 }).then(() => true, () => false));
  check("a thread being resolved shows a spinner", (await folded.getByLabel("Saving").count()) === 1);
  release();
  await folded.getByLabel("Saving").waitFor({ state: "detached" });
  await page.unroute(route);
  const tick = await folded.locator("svg").first().evaluate((s) => s.getBoundingClientRect().width);
  check("a resolved thread folds, with its check mark showing", tick >= 12, `${tick}px`);
  await page.waitForTimeout(300);
  check("a resolved thread stays folded", (await slot.locator("[data-thread]").count()) === 0);
  check("the resolve reached the server", await until(async () => (await notes("docs/review.md"))[0]?.resolved === true));
  await folded.click();
  await slot.getByRole("button", { name: "Reopen" }).click();
  await slot.getByRole("button", { name: "Resolve" }).waitFor();
  check("reopening unfolds the thread", (await slot.locator("[data-thread]").count()) === 1);
  await slot.getByRole("button", { name: "Collapse thread" }).click();
  check("a reopened thread still collapses", await folded.waitFor({ timeout: 3000 }).then(() => true, () => false));
  await page.locator("[data-mark]").first().click();
  check("picking a folded thread in the document unfolds it", await slot.locator("[data-thread]").waitFor({ timeout: 3000 }).then(() => true, () => false));

  // --- questions ------------------------------------------------------------------

  const q = page.locator('[data-question="pick"]');
  await q.scrollIntoViewIfNeeded();
  await q.getByText("code", { exact: true }).click();
  await q.getByRole("button", { name: "Answer" }).click();
  await page.waitForTimeout(600);
  const asked = (await api("questions?path=docs/review.md")).questions;
  check("answering a question records it", asked[0]?.answered === true, JSON.stringify(asked[0]));

  // --- an agent edits the doc while the reader answers ----------------------------

  // The bug: lines shifted under a stale body, so every block fell back to raw text.
  const TWO = (pre) => `${pre}# Two questions

## First

<!-- scooter:question id=one kind=single -->
First?
- [ ] yes
- [ ] no
<!-- /scooter:question -->

## Second

<!-- scooter:question id=two kind=single -->
Second?
- [ ] left
- [ ] right
<!-- /scooter:question -->
`;
  writeFileSync(join(ws, "docs/two.md"), TWO(""));
  await page.goto(`${url}/?path=docs/two.md`);
  await page.locator('[data-question="two"]').waitFor();
  // The agent writes a decision in above both blocks, moving their lines.
  writeFileSync(join(ws, "docs/two.md"), TWO("Decided: ship it.\n\nMore context.\n\n"));
  const two = page.locator('[data-question="two"]');
  await two.getByText("right", { exact: true }).click();
  await two.getByRole("button", { name: "Answer" }).click();
  await page.waitForTimeout(800);
  check(
    "questions still render after the doc moves under them",
    (await page.locator("[data-question]").count()) === 2,
    `${await page.locator("[data-question]").count()} cards`,
  );
  check(
    "auto-refresh shows the agent's edit",
    await until(() => page.getByText("Decided: ship it.").isVisible(), 8000),
  );
  check("the answer survives the refresh", await until(() => two.getByText("Change", { exact: true }).isVisible(), 3000));

  // Pushed, not polled: both land well inside the old 3s poll interval.
  let t0 = Date.now();
  writeFileSync(join(ws, "docs/two.md"), TWO("Decided: ship it.\n\nPushed edit.\n\n"));
  check(
    "an edit on disk is pushed to the page",
    await until(() => page.getByText("Pushed edit.").isVisible(), 2500),
    `${Date.now() - t0}ms`,
  );
  t0 = Date.now();
  await fetch(`${url}/api/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "docs/two.md", line: 1, quote: "Decided", text: "From another tab." }),
  });
  check(
    "a comment saved elsewhere is pushed to the page",
    await until(() => page.getByText("From another tab.").isVisible(), 2500),
    `${Date.now() - t0}ms`,
  );

  // --- contents ------------------------------------------------------------------

  const toc = page.locator('nav[aria-label="Contents"]');
  check("a table of contents lists the headings", (await toc.getByRole("link").allTextContents()).join("|") === "Two questions|First|Second",
    (await toc.getByRole("link").allTextContents()).join("|"));
  await toc.getByRole("link", { name: "Second" }).click();
  check("a contents link addresses its section", new URL(page.url()).hash === "#second", page.url());
  check("narrow, the contents sit in the comment rail", (await page.locator('[data-comments] nav[aria-label="Contents"]').count()) === 1);
  await page.setViewportSize({ width: 1920, height: 900 });
  check(
    "wide, the contents get their own column",
    await until(async () => (await page.locator('[data-comments] nav[aria-label="Contents"]').count()) === 0 && (await toc.count()) === 1, 3000),
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  // --- links: the address format the scooter-files skill hands out ---------------

  await page.goto(`${url}/?path=docs/review.md#later-section`);
  const later = page.locator("article h2#later-section");
  check("a heading anchor in the address names its section", await later.waitFor({ timeout: 5000 }).then(() => true, () => false));
  check(
    "the section is scrolled to",
    await until(async () => {
      const box = await later.boundingBox();
      return box && box.y >= 0 && box.y < 300;
    }, 3000),
  );
  const img = page.locator("article img");
  check(
    "a document's image loads from the workspace",
    (await img.getAttribute("src"))?.includes("/api/raw?path=docs%2Fdot.png") &&
      (await until(() => img.evaluate((i) => i.complete && i.naturalWidth === 1), 3000)),
    await img.getAttribute("src"),
  );
  await page.getByRole("link", { name: "the sample" }).click();
  await page.locator('[data-column-number="1"]').waitFor();
  check(
    "a relative link opens the file in the viewer",
    new URL(page.url()).searchParams.get("path") === "src/sample.py",
    page.url(),
  );
  check("a non-document is titled by its filename", (await page.title()) === "sample.py · Files", await page.title());
  await page.goBack();
  await page.locator("article h1").waitFor();
  check("back returns to the document", new URL(page.url()).searchParams.get("path") === "docs/review.md", page.url());

  await page.goto(`${url}/#/docs/review.md`);
  await page.locator("article h1").waitFor();
  check(
    "an old #/<file> link still opens, and is rewritten",
    new URL(page.url()).searchParams.get("path") === "docs/review.md",
    page.url(),
  );

  // --- images: shared in a document, and opened on their own ---------------------

  await page.goto(`${url}/?path=docs/images.md`);
  await page.locator("article h1").waitFor();
  const loaded = (alt) =>
    until(() => page.locator(`article img[alt="${alt}"]`).evaluate((i) => i.complete && i.naturalWidth === 1), 3000).catch(() => false);
  check("an image by host path loads from the workspace", await loaded("by host path"));
  check("an HTML <img> in a document renders", await loaded("html dot"));
  check("its width attribute is kept", (await page.locator('article img[alt="html dot"]').getAttribute("width")) === "40");
  check("an inline HTML <img> renders", await loaded("inline dot"));
  check(
    "an image inside a sentence stays on its line",
    (await page.locator('article img[alt="inline dot"]').evaluate((i) => getComputedStyle(i).display)) === "inline",
  );

  await page.goto(`${url}/?path=docs/dot.png`);
  const opened = page.locator("main img");
  check(
    "an image file opened from the tree is shown, not called binary",
    await until(() => opened.evaluate((i) => i.complete && i.naturalWidth === 1), 3000).catch(() => false),
    await page.locator("main").innerText(),
  );
  check("its dimensions are shown", await until(async () => (await page.locator("main").innerText()).includes("1 × 1"), 3000));

  // --- html: rendered in a sandboxed frame ----------------------------------------

  // The probes write what the frame could reach into its own page.
  writeFileSync(
    join(ws, "docs/report.html"),
    `<!doctype html><title>Report</title><h1 id="h">static</h1><img src="dot.png" alt="dot"><pre id="probe"></pre>
<script>
document.getElementById("h").textContent = "scripted";
const out = [];
try { out.push("parent:" + parent.document.title); } catch { out.push("parent:blocked"); }
try { out.push("cookie:" + document.cookie); } catch { out.push("cookie:blocked"); }
fetch("${url}/api/list?path=").then(() => out.push("fetch:ok"), () => out.push("fetch:blocked"))
  .finally(() => (document.getElementById("probe").textContent = out.join(" ")));
</script>`,
  );
  await page.goto(`${url}/?path=docs/report.html`);
  const frame = page.frameLocator("main iframe");
  await frame.locator("#h").waitFor();
  check("an HTML file renders and its script runs", (await frame.locator("#h").textContent()) === "scripted");
  check("its tab is titled from <title>", await until(async () => (await page.title()) === "Report · Files", 3000));
  check(
    "a relative image in it loads",
    await until(() => frame.locator("img").evaluate((i) => i.complete && i.naturalWidth === 1), 3000).catch(() => false),
  );
  await until(async () => (await frame.locator("#probe").textContent()).includes("fetch:"), 5000);
  const probe = await frame.locator("#probe").textContent();
  check("its script cannot reach the viewer's page", probe.includes("parent:blocked"), probe);
  check("its script cannot read cookies", probe.includes("cookie:blocked"), probe);
  check("its script cannot call the viewer's API", probe.includes("fetch:blocked"), probe);
  await page.getByTitle("Source").click();
  check("Source shows the HTML as code", await until(() => page.getByText("parent.document.title").first().isVisible(), 5000));

  // --- code: a line-range comment -------------------------------------------------

  await page.goto(`${url}/?path=src/sample.py`);
  const num = (n) => page.locator(`[data-column-number="${n}"]`);
  // Pierre lays out its rows after mount; a box read before that is null.
  await num(3).waitFor({ state: "visible" });
  await num(5).waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const a = await num(3).boundingBox();
  const b = await num(5).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  const box = page.locator("textarea");
  await box.waitFor();
  await box.fill("about these lines");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.locator("[data-thread]").waitFor();
  const coded = (await notes("src/sample.py"))[0];
  check(
    "a range comment anchors to its first line and quotes the range",
    coded?.line === 3 && coded.quote.startsWith("value_3") && coded.quote.includes("value_5"),
    JSON.stringify(coded && { line: coded.line, quote: coded.quote }),
  );
  check("the thread renders inline under its lines", (await page.locator("[data-thread]").count()) === 1);

  // --- phone: tree drawer, tap to comment, comments in a bottom sheet -------------

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mob = await phone.newPage();
  mob.on("pageerror", (e) => errors.push(e.message));
  await mob.goto(`${url}/`);
  const drawer = mob.getByRole("navigation", { name: "File tree" });
  check("phone: with no file open the tree is shown", await drawer.isVisible());
  await mob.getByText("docs", { exact: true }).tap();
  await mob.getByText("two.md").tap();
  await mob.locator("article h1").waitFor();
  check("phone: opening a file closes the tree", !(await drawer.isVisible()));
  const sheet = mob.locator("[data-comments]");
  check("phone: comments start hidden behind a button", !(await sheet.isVisible()));
  const width = await mob.evaluate(() => document.documentElement.scrollWidth);
  check("phone: the page does not scroll sideways", width <= 390, `scrollWidth ${width}`);
  await mob.locator("article p").first().tap();
  await mob.getByLabel("Comment on this paragraph").tap();
  check("phone: a tapped paragraph opens the composer in the sheet", await sheet.locator("textarea").isVisible());
  await sheet.locator("textarea").fill("from a phone");
  await sheet.getByRole("button", { name: "Comment", exact: true }).tap();
  await sheet.locator("[data-thread]").first().waitFor();
  check("phone: the comment is stored", (await notes("docs/two.md")).some((a) => a.text === "from a phone"));
  await mob.getByLabel("Close comments").tap();
  check("phone: the sheet closes", !(await sheet.isVisible()));
  await phone.close();

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  check("the run finished", false, String(err).split("\n")[0]);
} finally {
  await browser.close();
  viewer.kill();
  broker.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
