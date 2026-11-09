// A local stand-in for the platform around the review services: one origin that
// routes /review/ and /review-app/ to their ports (as the agent-host proxy does,
// path unchanged, WebSockets included), and a conversation that records the
// messages the review service posts.
//
//   startStack({ bin, vendorDir, stateDir }) -> { origin, messages, appDir, stop() }

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = resolve(here, "../../example");

const listen = (server) => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
const freePort = async () => {
  const s = createServer();
  const port = await listen(s);
  await new Promise((ok) => s.close(ok));
  return port;
};

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out waiting for " + url);
}

export async function startStack({ bin, vendorDir, stateDir, python = "python3", devPort }) {
  const procs = [];
  const messages = [];

  // The conversation: POST /conversations/<id>/messages.
  const conv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      messages.push({ path: req.url, auth: req.headers.authorization, ...JSON.parse(body || "{}") });
      res.writeHead(202, { "content-type": "application/json" }).end("{}");
    });
  });
  const convPort = await listen(conv);
  mkdirSync(stateDir, { recursive: true });
  const tokenPath = join(stateDir, "..", "token");
  writeFileSync(tokenPath, "test-token\n");

  const shellPort = await freePort(), appPort = await freePort();
  devPort ||= await freePort();

  // One origin in front of both services.
  const front = createServer((req, res) => {
    const port = req.url.startsWith("/review-app") ? appPort : req.url.startsWith("/review") ? shellPort : 0;
    if (!port) return res.writeHead(404).end("not a review path");
    const up = request({ host: "127.0.0.1", port, path: req.url, method: req.method,
      headers: { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": "http" } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  front.on("upgrade", (req, socket, head) => {
    const port = req.url.startsWith("/review-app") ? appPort : shellPort;
    const up = connect(port, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + `\r\nx-forwarded-host: ${req.headers.host}\r\n\r\n`);
      up.write(head);
      up.pipe(socket).pipe(up);
    });
    up.on("error", () => socket.destroy());
  });
  const frontPort = await listen(front);
  const origin = `http://127.0.0.1:${frontPort}`;

  const env = {
    ...process.env,
    SCOOTER_SERVICE_PREFIX: "",
    REVIEW_SHELL_PORT: String(shellPort),
    REVIEW_APP_PORT: String(appPort),
    REVIEW_STATE_DIR: stateDir,
    REVIEW_VENDOR_DIR: vendorDir,
    CONVERSATION_ID: "conv-review",
    CONVERSATION_URL: `${origin}/c/conv-review`,
    SCOOTER_SERVICES_ORIGIN: origin,
    SCOOTER_SELF_URL: `http://127.0.0.1:${convPort}`,
    SCOOTER_SELF_TOKEN_PATH: tokenPath,
    SCOOTER_CHAT_URL: "about:blank",
  };
  const run = (cmd, args, extra = {}) => {
    const p = spawn(cmd, args, { env: { ...env, ...extra }, stdio: ["ignore", "inherit", "inherit"] });
    procs.push(p);
    return p;
  };
  // A copy, so tests can edit the app's files.
  const appDir = join(dirname(stateDir), "app");
  cpSync(exampleDir, appDir, { recursive: true });
  run(python, [join(appDir, "serve.py"), "--port", String(devPort), "--base", "/review-app/"]);
  run(bin, ["proxy"]);
  run(bin, ["shell"]);
  await waitFor(`http://127.0.0.1:${devPort}/review-app/`);
  await waitFor(`http://127.0.0.1:${appPort}/__review/notes`);
  await waitFor(`http://127.0.0.1:${shellPort}/review/`);

  const cli = (...args) => new Promise((ok, fail) => {
    const p = spawn(bin, ["cli", ...args], { env });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(err || out))));
  });

  return {
    origin, messages, appDir, devPort, appPort, shellPort, env, cli,
    async stop() {
      for (const p of procs) p.kill("SIGTERM");
      await Promise.all([conv, front].map((s) => new Promise((ok) => { s.closeAllConnections?.(); s.close(ok); })));
    },
  };
}
