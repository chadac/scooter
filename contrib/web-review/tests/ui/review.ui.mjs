// Drives the web review shell, overlay and proxy in a real browser against the
// Acme Ops sample app (contrib/web-review/example). Self-contained: it starts the
// services, the sample app and a stand-in for the platform (stack.mjs).
//
//   PW_CHROME=... node contrib/web-review/tests/ui/review.ui.mjs
//
// REVIEW_BIN is the scooter-review binary (default: `go build` output at
// /tmp/scooter-review); REVIEW_VENDOR_DIR holds modern-screenshot.js.
// SHOTS_DIR, if set, receives screenshots of each step.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startStack } from "./stack.mjs";

const bin = process.env.REVIEW_BIN || "/tmp/scooter-review";
const vendorDir = process.env.REVIEW_VENDOR_DIR;
const shots = process.env.SHOTS_DIR;
if (!vendorDir) throw new Error("set REVIEW_VENDOR_DIR to a directory holding modern-screenshot.js");

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(100);
  }
}

const root = mkdtempSync(join(tmpdir(), "review-ui-"));
const stateDir = join(root, "state");
const stack = await startStack({ bin, vendorDir, stateDir });
writeFileSync(join(stateDir, "config.json"), JSON.stringify({ port: stack.devPort, cwd: "/workspace/acme-ops" }));

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME });
const scheme = process.env.COLOR_SCHEME || "light";
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const app = () => page.frameLocator("#frame");
const appFrame = () => page.frame({ url: /\/review-app\// });
const snap = async (name) => shots && page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
// Modes reach the frame by postMessage; wait before pointing.
const armed = () => app().locator(".catcher:not([hidden])").waitFor();
const shellPath = () => new URL(page.url()).pathname + new URL(page.url()).search;
const waitPath = (p) => until(async () => shellPath() === p);

try {
  // --- routing --------------------------------------------------------------------
  await page.goto(`${stack.origin}/review/orders?status=late`);
  await app().locator("h1", { hasText: "Orders" }).waitFor();
  check("a deep link with a query opens the app at that route", (await app().locator("tbody tr").count()) === 1);

  await app().locator("nav a", { hasText: "Customers" }).click();
  await app().locator("h1", { hasText: "Customers" }).waitFor();
  check("navigating in the app updates the address bar", await waitPath("/review/customers"), shellPath());
  check("the toolbar shows the route", (await page.locator("#route").textContent()) === "/customers");
  check("the page title follows the app", await until(async () => (await page.title()).startsWith("Customers")));

  await page.goBack();
  await app().locator("h1", { hasText: "Orders" }).waitFor();
  check("Back returns to the previous route", await waitPath("/review/orders?status=late"), shellPath());
  await page.goForward();
  check("Forward goes to the next one", await waitPath("/review/customers"), shellPath());

  await page.goto(`${stack.origin}/review/orders/1042`);
  await app().locator("h1", { hasText: "Order #1042" }).waitFor();
  await page.reload();
  await app().locator("h1", { hasText: "Order #1042" }).waitFor();
  check("reloading a deep link lands on it", shellPath() === "/review/orders/1042");
  await snap("01-order");

  // --- a point note ---------------------------------------------------------------
  await page.keyboard.press("c");
  check("C turns on point mode", (await page.locator("#point").getAttribute("aria-pressed")) === "true");
  await armed();
  const total = app().locator(".summary .total strong");
  const box = await total.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.move(box.x + 10, box.y + 8);
  await app().locator(".hl .tag").waitFor();
  await snap("02-point-hover");
  await page.mouse.down();
  await page.mouse.up();
  const composer = app().locator(".pop textarea");
  await composer.waitFor();
  check("clicking an element opens the note box", true);
  check("point mode ends once the note box is open", await until(async () => (await page.locator("#point").getAttribute("aria-pressed")) === "false"));
  await app().locator(".pop .shot img").waitFor({ timeout: 15000 });
  check("the note box shows a screenshot before saving", true);
  await composer.fill("The total is cramped; give it more room.");
  await snap("03-point-compose");
  await app().locator(".pop .save").click();
  const first = await until(async () => stack.messages[0]);
  check("saving a note wakes the conversation", !!first);
  check("…tagged with the contrib's source", first?.source === "web-review", first?.source);
  check("…naming the route, element and comment",
    /Review note #1 \[[0-9a-f-]{36}\] \(point\) on \/orders\/1042, viewport \d+×\d+ \(\w+\):/.test(first?.text) &&
      first.text.includes("at `") && first.text.includes("$1,204.50") && first.text.includes("> The total is cramped"), first?.text);
  const id1 = /\[([0-9a-f-]{36})\]/.exec(first?.text ?? "")?.[1];
  check("…with the source directory and the commands", first?.text.includes("Source: /workspace/acme-ops") && first.text.includes("`review reply " + id1), first?.text);
  const shotPath = /Screenshot: (\S+)/.exec(first?.text ?? "")?.[1];
  check("…and a screenshot path", !!shotPath && shotPath.startsWith(stateDir), first?.text);
  check("the screenshot exists and isn't blank", shotPath && existsSync(shotPath) && statSync(shotPath).size > 3000, shotPath && existsSync(shotPath) ? statSync(shotPath).size : "missing");
  await app().locator(`.pin.point[data-id="${id1}"]`).waitFor();
  check("a pin marks the element", true);
  check("the Notes count goes up", (await page.locator("#open-n").textContent()) === "1");

  // --- an area note ---------------------------------------------------------------
  await page.keyboard.press("r");
  await armed();
  const summary = await app().locator(".summary").boundingBox();
  await page.mouse.move(summary.x + 20, summary.y + 10);
  await page.mouse.down();
  await page.mouse.move(summary.x + summary.width / 2, summary.y + summary.height - 10, { steps: 5 });
  await page.mouse.up();
  await composer.waitFor();
  await composer.fill("These numbers feel crowded.");
  await app().locator(".pop .save").click();
  const second = await until(async () => stack.messages[1]);
  check("an area note names its container and overlaps",
    /\(area\)/.test(second?.text) && /area \d+,\d+ → \d+,\d+ inside `[^`]*summary/.test(second?.text) && second.text.includes("overlaps:"), second?.text);
  const id2 = /\[([0-9a-f-]{36})\]/.exec(second?.text ?? "")?.[1];
  check("each note gets its own id", !!id2 && id2 !== id1, [id1, id2]);
  await app().locator(`.pin.area[data-id="${id2}"]`).waitFor();
  await snap("04-pins");

  // --- the agent answers ----------------------------------------------------------
  check("the label alone is refused", await stack.cli("resolve", "1").then(() => false, (e) => String(e).includes(id1)));
  await stack.cli("reply", id1, "Widened the summary column.");
  await stack.cli("resolve", id1);
  await until(async () => (await app().locator(`.pin.resolved[data-id="${id1}"]`).count()) === 1);
  check("`review resolve` turns the pin green", (await app().locator(`.pin.resolved[data-id="${id1}"]`).count()) === 1);
  await app().locator(`.pin[data-id="${id1}"]`).click();
  await app().locator(".pop .msg.agent").waitFor();
  check("`review reply` shows on the pin's thread", (await app().locator(".pop .msg.agent").textContent()).includes("Widened"));
  await snap("05-thread");
  await app().locator(".pop textarea").fill("Still tight on mobile.");
  await app().locator(".pop .reply").click();
  const third = await until(async () => stack.messages[2]);
  check("a reply from the user wakes the agent again", third?.text.startsWith(`Reply on review note #1 [${id1}]`) && third.text.includes("> Still tight"), third?.text);
  check("…and reopens the note", await until(async () => (await app().locator(`.pin.resolved[data-id="${id1}"]`).count()) === 0));
  await page.keyboard.press("Escape");

  // --- hold and send all ----------------------------------------------------------
  await page.locator("#hold").click();
  await until(async () => (await page.locator("#hold").getAttribute("aria-pressed")) === "true");
  await app().locator("nav a", { hasText: "Dashboard" }).click();
  await app().locator('[data-testid="kpi-late"]').waitFor();
  check("pins belong to their route", (await app().locator(".pin").count()) === 0);
  for (const [sel, text] of [['[data-testid="kpi-late"]', "Late should link to the filtered list."], ["canvas#trend", "Label the axes."]]) {
    await page.keyboard.press("c");
    await armed();
    const b = await app().locator(sel).boundingBox();
    await page.mouse.move(b.x + 10, b.y + 10);
    await page.mouse.move(b.x + 12, b.y + 12);
    await page.mouse.down();
    await page.mouse.up();
    await composer.waitFor();
    await composer.fill(text);
    await app().locator(".pop .save").click();
    await composer.waitFor({ state: "detached" });
  }
  await sleep(500);
  check("held notes don't wake the agent", stack.messages.length === 3, String(stack.messages.length));
  check("held pins are drawn dashed", (await app().locator(".pin.held").count()) === 2);
  check("Send all shows the held count", (await page.locator("#send").textContent()) === "Send all (2)");
  await snap("06-held");
  await page.locator("#send").click();
  const batch = await until(async () => stack.messages[3]);
  check("Send all wakes the agent once with every held note", batch?.text.startsWith("Review: 2 notes.") &&
    batch.text.includes("Review note #3") && batch.text.includes("Review note #4"), batch?.text);
  check("…and clears the held state", await until(async () => (await app().locator(".pin.held").count()) === 0));
  await page.locator("#hold").click();

  // --- the notes list ---------------------------------------------------------------
  await page.locator("#notes").click();
  await page.locator("#list li", { hasText: "#2" }).click();
  check("a note on another route navigates there", await waitPath("/review/orders/1042"), shellPath());
  await app().locator(".pop .msg").waitFor();
  check("…and opens its thread", (await app().locator(".pop .msg").first().textContent()).includes("crowded"));
  await page.keyboard.press("Escape");

  // --- hide pins ------------------------------------------------------------------
  await page.locator("#hide").click();
  check("Hide pins hides them", await until(async () => (await app().locator(".pin").count()) === 0));
  await page.locator("#hide").click();

  // --- hot reload -------------------------------------------------------------------
  const assets = join(stack.appDir, "static", "assets");
  await app().locator("h1").evaluate(() => { window.__sameDocument = true; });
  writeFileSync(join(assets, "styles.css"), readFileSync(join(assets, "styles.css"), "utf8") + "\nh1 { letter-spacing: 3px; }\n");
  check("a CSS edit restyles the page in place", await until(async () =>
    (await app().locator("h1").evaluate((h) => getComputedStyle(h).letterSpacing === "3px" && window.__sameDocument === true))));
  writeFileSync(join(assets, "app.js"), readFileSync(join(assets, "app.js"), "utf8") + "\n");
  check("any other edit reloads the page", await until(async () =>
    (await app().locator("h1").evaluate(() => window.__sameDocument !== true).catch(() => false))));
  check("…on the same route", await until(async () => (await page.locator("#route").textContent()) === "/orders/1042"), await page.locator("#route").textContent());

  // --- review snap ----------------------------------------------------------------
  const out = (await stack.cli("snap")).trim();
  check("`review snap` captures the open page", out.endsWith(".png") && existsSync(out) && statSync(out).size > 5000, out);
  if (shots && existsSync(out)) writeFileSync(join(shots, `07-snap-${scheme}.png`), readFileSync(out));

  // --- the dev server goes away ---------------------------------------------------
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({ port: 1 }));
  const down = await fetch(`${stack.origin}/review-app/`, { headers: { "sec-fetch-dest": "iframe" } });
  check("a dead dev server gets a retrying page, not a connection error", down.status === 502 && (await down.text()).includes("Waiting for the dev server"));

  check("no page errors", errors.length === 0, errors.join("; "));
} catch (err) {
  failures++;
  console.log("FAIL", err.stack || err);
  await snap("zz-failure").catch(() => {});
} finally {
  await browser.close();
  await stack.stop();
  rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
