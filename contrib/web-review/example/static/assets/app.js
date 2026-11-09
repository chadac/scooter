// Acme Ops: a tiny History API router over a JSON API, resolved against <base href>.

const base = new URL(document.baseURI).pathname; // e.g. "/review-app/"
const view = document.getElementById("view");
const money = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The route inside the app: "/orders/42" for base + "orders/42". */
function route() {
  const p = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : "";
  return "/" + p.replace(/\/$/, "");
}

const api = (path) => fetch(new URL("api/" + path, document.baseURI)).then((r) => r.json());
const badge = (status) => `<span class="badge" data-status="${esc(status)}">${esc(status)}</span>`;

const pages = [
  [/^\/$/, async () => {
    const s = await api("stats");
    view.innerHTML = `
      <h1>Dashboard</h1>
      <section class="kpis">
        <div class="kpi" data-testid="kpi-revenue"><span>Revenue (30d)</span><strong>${money(s.revenue)}</strong></div>
        <div class="kpi" data-testid="kpi-orders"><span>Orders</span><strong>${s.orders}</strong></div>
        <div class="kpi warn" data-testid="kpi-late"><span>Late</span><strong>${s.late}</strong></div>
      </section>
      <section class="card">
        <h2>Orders per day</h2>
        <canvas id="trend" width="560" height="120" aria-label="Orders per day"></canvas>
      </section>
      <p><a href="orders" data-link>See all orders →</a></p>`;
    drawTrend(document.getElementById("trend"), s.trend);
  }],
  [/^\/orders$/, async () => {
    const orders = await api("orders");
    const q = new URLSearchParams(location.search).get("status");
    const shown = q ? orders.filter((o) => o.status === q) : orders;
    view.innerHTML = `
      <h1>Orders</h1>
      <p class="filters">${["", "late", "processing", "shipped", "delivered"].map((s) =>
        `<a href="orders${s ? "?status=" + s : ""}" data-link class="${(q || "") === s ? "on" : ""}">${s || "all"}</a>`).join("")}</p>
      <table class="orders">
        <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th></tr></thead>
        <tbody>${shown.map((o) => `
          <tr><td><a href="orders/${o.id}" data-link>#${o.id}</a></td><td>${esc(o.customer)}</td>
          <td>${o.items}</td><td class="num">${money(o.total)}</td><td>${badge(o.status)}</td></tr>`).join("")}
        </tbody>
      </table>`;
  }],
  [/^\/orders\/(\d+)$/, async (id) => {
    const o = await api("orders/" + id);
    if (o.error) return notFound();
    view.innerHTML = `
      <p><a href="orders" data-link>← Orders</a></p>
      <h1>Order #${o.id}</h1>
      <section class="summary card">
        <div><span>Customer</span><strong>${esc(o.customer)}</strong></div>
        <div><span>Items</span><strong>${o.items}</strong></div>
        <div class="total"><span>Order total</span><strong>${money(o.total)}</strong></div>
        <div><span>Status</span>${badge(o.status)}</div>
      </section>`;
  }],
  [/^\/customers$/, async () => {
    const cs = await api("customers");
    view.innerHTML = `<h1>Customers</h1><ul class="customers">${cs.map((c) =>
      `<li class="card"><strong>${esc(c.name)}</strong><span>${c.orders} orders · since ${c.since}</span></li>`).join("")}</ul>`;
  }],
  [/^\/settings$/, async () => {
    view.innerHTML = `
      <h1>Settings</h1>
      <form class="card settings" onsubmit="return false">
        <label>Company name <input name="company" value="Acme Corp"></label>
        <label>Timezone <select name="tz"><option>UTC</option><option>US/Eastern</option></select></label>
        <label><input type="checkbox" checked> Email me about late orders</label>
        <button type="submit">Save</button>
      </form>`;
  }],
];

function notFound() {
  view.innerHTML = `<h1>Not found</h1><p>No page at <code>${esc(route())}</code>. <a href="./" data-link>Dashboard</a></p>`;
}

async function render() {
  const r = route();
  const hit = pages.map(([re, page]) => [re.exec(r), page]).find(([m]) => m);
  if (hit) await hit[1](...hit[0].slice(1));
  else notFound();
  for (const a of document.querySelectorAll("[data-nav]")) {
    const nav = a.dataset.nav;
    a.classList.toggle("active", nav === "/" ? r === "/" : r.startsWith(nav));
  }
  document.title = `${view.querySelector("h1")?.textContent ?? "Acme Ops"} · Acme Ops`;
}

function drawTrend(canvas, data) {
  const ctx = canvas.getContext("2d");
  const max = Math.max(...data);
  const step = canvas.width / (data.length - 1);
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#4f46e5";
  ctx.lineWidth = 3;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i * step, y = canvas.height - 8 - (v / max) * (canvas.height - 16);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

// Same-origin links under the base are client-side navigations.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  history.pushState(null, "", a.href);
  render();
});
addEventListener("popstate", render);
render();
