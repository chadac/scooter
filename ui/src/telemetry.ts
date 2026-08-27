/**
 * Browser telemetry (RUM) — OTLP traces from the UI.
 *
 * WHY THIS EXISTS. The failures that matter most in this UI happen entirely in the
 * browser and never reach a pod log: a render stream reconnecting to the wrong
 * conversation, a runtime remounting mid-run and dropping an in-flight run's state, a
 * request storm against an id the server never issued. Debugging those has meant driving a
 * real browser locally and inferring what happened; none of that is available for a
 * deployment.
 *
 * WHERE IT GOES. Spans are POSTed to `/telemetry/v1/traces` — SAME ORIGIN. The UI's nginx
 * forwards that to the cluster's collector. Three consequences, all deliberate:
 *
 *   - the browser holds no telemetry credential (nothing to leak, nothing to abuse),
 *   - the traffic stays behind the ingress auth, so spans are attributable,
 *   - switching vendor (Grafana Cloud, Datadog, ...) is a collector-side change; the UI
 *     does not know or care who receives this.
 *
 * With no collector configured the route returns 204 and discards, so this is safe to
 * leave compiled in — see `pkgs/ui-image/default.nix`.
 *
 * PRIVACY. Message content NEVER leaves the browser through this path. Attributes are ids,
 * counts, durations, and error classes. When adding a span, that rule is the constraint —
 * a conversation id is fine, its transcript is not.
 */

import { context, trace, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  WebTracerProvider,
} from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/** Where nginx proxies browser telemetry. Same-origin by construction. */
const ENDPOINT = "/telemetry/v1/traces";

/** Attribute names. Stable strings, because dashboards and queries key on them.
 *
 *  Note there are TWO conversation identifiers and both matter. A conversation exists in
 *  the UI before the server assigns its id, so the interesting window — creation, the
 *  first send, the stream opening — spans both. Recording only one breaks the trace at
 *  exactly the point the bugs live. */
export const ATTR = {
  /** Stable local key. Present for the conversation's whole life. */
  conversationKey: "scooter.conversation.key",
  /** The SERVER's id. Absent until the conversation has been created. */
  conversationId: "scooter.conversation.id",
  runId: "scooter.run.id",
  /** Why a stream closed / reopened — the field that would have named the restart bug. */
  reason: "scooter.reason",
} as const;

/** Matches a conversation id in a request URL. */
const CONV_URL_RE = /\/conversations\/([0-9a-f-]{36})/;

/** Bucket a request into a low-cardinality kind, so traces group by WHAT the request
 *  was rather than by conversation id. */
function classifyRoute(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
  if (path.endsWith("/messages")) return "send-message";
  if (path.includes("events.integrity")) return "stream";
  if (path.endsWith("/cancel")) return "cancel";
  if (path.endsWith("/ready")) return "ready";
  if (path.endsWith("/links")) return "links";
  if (path.endsWith("/history")) return "history";
  if (path === "/conversations") return "list-or-create";
  return "other";
}

let tracer: Tracer | undefined;

/**
 * Fetch the deployment's telemetry config and start if it is enabled.
 *
 * RUNTIME, not build time. The UI image is built once and deployed to clusters that may or
 * may not have a collector, so a VITE_* flag baked into the bundle cannot express that.
 * nginx serves /telemetry/config.json from its own environment.
 *
 * Never throws and never blocks startup: a missing or malformed config just leaves
 * telemetry off.
 */
export async function initTelemetryFromServer(): Promise<void> {
  // LOCAL DEBUGGING. With no collector — dev, or an e2e run — spans go to the browser
  // console instead, one line each. Playwright forwards those to the test output, so a
  // failing spec shows the same conversation lifecycle the deployed traces do, without
  // standing up Tempo. Grep is a perfectly good query language for one test's worth.
  //
  // VITE_TELEMETRY_CONSOLE=1 turns it on; it is never on by default, because a chat UI
  // emits enough spans to bury real console errors.
  if (import.meta.env.VITE_TELEMETRY_CONSOLE === "1") {
    initTelemetry({ enabled: true, exporter: "console" });
    return;
  }
  try {
    const res = await fetch("/telemetry/config.json", { cache: "no-store" });
    if (!res.ok) return;
    const cfg = (await res.json()) as { enabled?: boolean; sampleRatio?: number; version?: string };
    if (!cfg.enabled) return;
    initTelemetry({ enabled: true, sampleRatio: cfg.sampleRatio, version: cfg.version });
  } catch {
    /* no config, no telemetry — not an error */
  }
}

/**
 * Start telemetry. No-op unless enabled, and never throws — a telemetry failure must not
 * take down the app it is meant to observe.
 */
export function initTelemetry(opts: {
  enabled: boolean;
  sampleRatio?: number;
  version?: string;
  /** "console" prints each span as a line instead of exporting OTLP — for local runs
   *  where there is no collector. */
  exporter?: "otlp" | "console";
}): void {
  if (!opts.enabled || tracer) return;
  try {
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "scooter-ui",
        [ATTR_SERVICE_VERSION]: opts.version ?? "dev",
      }),
      // Head sampling: a chat UI with a live event stream can produce a lot of spans.
      sampler: new TraceIdRatioBasedSampler(opts.sampleRatio ?? 1),
      spanProcessors: opts.exporter === "console"
        ? [
            // ONE LINE per span, not OTel's multi-line dump: a failing test's output
            // should be greppable ("grep scooter.span" / "grep conversation.id_assigned")
            // rather than something to scroll. Simple, not batched — a span that never
            // flushes because the tab closed is exactly the one worth seeing.
            new SimpleSpanProcessor({
              export: (spans, cb) => {
                for (const sp of spans) {
                  const attrs = Object.entries(sp.attributes)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" ");
                  // eslint-disable-next-line no-console
                  console.log(`scooter.span ${sp.name}${attrs ? ` ${attrs}` : ""}`);
                }
                cb({ code: 0 });
              },
              shutdown: async () => {},
            }),
          ]
        : [
        new BatchSpanProcessor(new OTLPTraceExporter({ url: ENDPOINT }), {
          // Small batches, short delay: a browser tab can close at any moment, and an
          // unexported span is a lost span.
          scheduledDelayMillis: 5_000,
          maxExportBatchSize: 64,
        }),
      ],
    });
    provider.register();

    registerInstrumentations({
      instrumentations: [
        new FetchInstrumentation({
          // Do NOT trace the telemetry POST itself — it would generate a span per export,
          // which generates another export, and so on.
          ignoreUrls: [new RegExp(`${ENDPOINT}`)],
          // Propagate trace context to our own backend ONLY. Sending traceparent to a
          // third party would leak trace ids and trip their CORS preflight.
          propagateTraceHeaderCorsUrls: [new RegExp(`^${location.origin}`)],
          // Tag every request with its conversation and outcome, so a "my message went
          // nowhere" report is a query rather than a guess: the send POST, its status,
          // and the stream's own spans all carry the same conversation id.
          applyCustomAttributesOnSpan: (span, request, result) => {
            const url =
              typeof request === "string" ? request : ((request as Request).url ?? String(request));
            const conv = CONV_URL_RE.exec(url)?.[1];
            if (conv) span.setAttribute(ATTR.conversationId, conv);
            span.setAttribute("http.route_kind", classifyRoute(url));
            if (result instanceof Error) {
              span.setAttribute("http.failed", true);
              span.setAttribute(ATTR.reason, result.message.slice(0, 200));
            } else if (result && typeof (result as Response).status === "number") {
              const status = (result as Response).status;
              span.setAttribute("http.status_code", status);
              if (status >= 400) span.setAttribute("http.failed", true);
            }
          },
        }),
      ],
    });

    tracer = provider.getTracer("scooter-ui");
  } catch {
    // Telemetry is best-effort by definition. Leave `tracer` undefined so every
    // record()/startSpan() below becomes a no-op.
  }
}

/** Record a point-in-time event as a zero-duration span. Safe before init (no-op). */
export function record(name: string, attrs: Record<string, string | number | boolean> = {}): void {
  try {
    tracer?.startSpan(name, { attributes: attrs }).end();
  } catch {
    /* never let telemetry throw into a caller */
  }
}

/** Start a span the caller ends. Returns undefined when telemetry is off. */
export function startSpan(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
): Span | undefined {
  try {
    return tracer?.startSpan(name, { attributes: attrs });
  } catch {
    return undefined;
  }
}

/** Record a caught error against the active span, or as its own event. */
export function recordError(name: string, err: unknown, attrs: Record<string, string> = {}): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    const active = trace.getSpan(context.active());
    if (active) {
      active.recordException(err instanceof Error ? err : new Error(message));
      return;
    }
    record(name, { ...attrs, "error.message": message });
  } catch {
    /* never let telemetry throw into a caller */
  }
}

/** Catch what would otherwise only reach the browser console.
 *
 *  Deliberately NOT gated on `tracer` being ready: config is fetched asynchronously, so a
 *  guard here would install nothing (init has not finished when main calls this) — and an
 *  error thrown during startup is exactly the kind worth capturing. record() is a no-op
 *  while telemetry is off, so the listeners are free until it is on. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (e) => {
    record("browser.error", {
      "error.message": e.message,
      "error.source": `${e.filename}:${e.lineno}`,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r: unknown = e.reason;
    record("browser.unhandled_rejection", {
      "error.message": r instanceof Error ? r.message : String(r),
    });
  });
}
