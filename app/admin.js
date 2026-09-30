/* ==========================================================================
   Domain Vault — admin panel
   Every action goes through the api function, which re-checks that the
   caller is an admin and writes an audit entry. Hiding this page would not
   be security; the server check is.
   ========================================================================== */
(function () {
  "use strict";

  const API = window.DomainVaultAPI;
  const PLANS = ["Personal", "Start-up", "Business", "Agency"];
  const PAGE_SIZE = 50;
  const $ = (id) => document.getElementById(id);

  const state = { admin: null, userOffset: 0, userTotal: 0, sales: [] };

  /* ------------------------------------------------------------- helpers */

  /** Escape anything that came from the database before it touches innerHTML. */
  function h(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function money(amount, currency) {
    if (amount === null || amount === undefined) return "—";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(amount);
    } catch (e) {
      return `${Number(amount).toFixed(2)} ${currency || ""}`;
    }
  }

  let toastTimer;
  function toast(message, isError) {
    const el = $("toast");
    el.textContent = message;
    el.className = "toast show" + (isError ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 3500);
  }

  function icons() { if (window.lucide) window.lucide.createIcons(); }

  /** Call the API; show the server's message and return null on failure. */
  async function call(action, payload) {
    try {
      const res = await API.call(action, payload || {});
      if (res && res.success === false) {
        if (/expired|not signed in/i.test(res.message || "")) return showLogin(res.message);
        toast(res.message || "Request failed.", true);
        return null;
      }
      return res;
    } catch (e) {
      toast("Cannot reach the server.", true);
      return null;
    }
  }

  /* ---------------------------------------------------------------- auth */

  function showLogin(message) {
    $("appView").hidden = true;
    $("signOutBtn").hidden = true;
    $("whoEmail").textContent = "";
    $("loginView").hidden = false;
    $("loginMsg").textContent = message || "";
    $("loginMsg").className = "msg" + (message ? " err" : "");
    return null;
  }

  async function enter(user) {
    // The server is the authority: adminOverview fails for non-admins.
    const overview = await API.call("adminOverview", {}).catch(() => null);
    if (!overview || overview.success === false) {
      return showLogin(overview && /admin/i.test(overview.message || "")
        ? "This account does not have admin rights."
        : (overview && overview.message) || "Cannot reach the server.");
    }
    state.admin = user;
    $("loginView").hidden = true;
    $("appView").hidden = false;
    $("signOutBtn").hidden = false;
    $("whoEmail").textContent = user.email;
    renderOverview(overview);
    loadPending();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginMsg").className = "msg";
    $("loginMsg").textContent = "Signing in…";
    const res = await API.call("loginUser", {
      email: $("loginEmail").value,
      password: $("loginPassword").value,
    }).catch(() => null);
    if (!res || !res.success) {
      return showLogin((res && res.message) || "Cannot reach the server.");
    }
    $("loginPassword").value = "";
    enter(res.user);
  });

  $("signOutBtn").addEventListener("click", () => {
    API.signOut();
    state.admin = null;
    showLogin();
  });

  /* ---------------------------------------------------------------- tabs */

  const loaders = {
    overview: async () => { const o = await call("adminOverview"); if (o) renderOverview(o); loadPending(); },
    users: () => loadUsers(),
    sales: () => loadSales(),
    prices: () => loadPrices(),
    audit: () => loadAudit(),
  };

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      loaders[tab.dataset.tab]();
    });
  });

  /* ------------------------------------------------------------ overview */

  function renderOverview(o) {
    const s = o.users.byStatus || {};
    const revenue = Object.entries(o.sales.revenue || {});
    const tiles = [
      ["Users", o.users.total],
      ["Pending", s.pending || 0, (s.pending || 0) > 0],
      ["Active", s.active || 0],
      ["Suspended", s.suspended || 0],
      ["Domains tracked", o.domains],
      ["Completed sales", o.sales.completed],
      ...revenue.map(([cur, amt]) => [`Revenue (${cur})`, money(amt, cur)]),
      ["Payments needing review", o.sales.needsAttention, o.sales.needsAttention > 0],
    ];
    $("overviewTiles").innerHTML = tiles.map(([label, value, alert]) =>
      `<div class="tile${alert ? " alert" : ""}"><div class="label">${h(label)}</div><div class="value">${h(value)}</div></div>`
    ).join("");

    const pending = s.pending || 0;
    $("pendingCount").hidden = pending === 0;
    $("pendingCount").textContent = pending;
    $("attentionCount").hidden = !o.sales.needsAttention;
    $("attentionCount").textContent = o.sales.needsAttention;
  }

  async function loadPending() {
    const res = await call("adminListUsers", { status: "pending", limit: 100 });
    if (!res) return;
    $("pendingRows").innerHTML = res.users.length
      ? res.users.map((u) => `<tr>
          <td>${h(u.email)}</td><td>${h(u.phone)}</td><td>${h(u.location)}</td><td>${h(when(u.created_at))}</td>
          <td><button class="btn sm good" data-act="activate" data-id="${h(u.id)}"><i data-lucide="check"></i> Activate</button></td>
        </tr>`).join("")
      : `<tr><td colspan="5" class="empty">Nobody is waiting.</td></tr>`;
    icons();
  }

  /* --------------------------------------------------------------- users */

  async function loadUsers() {
    const res = await call("adminListUsers", {
      status: $("userStatus").value,
      search: $("userSearch").value.trim(),
      limit: PAGE_SIZE,
      offset: state.userOffset,
    });
    if (!res) return;
    state.userTotal = res.total;

    $("userRows").innerHTML = res.users.length ? res.users.map(userRow).join("")
      : `<tr><td colspan="10" class="empty">No users match.</td></tr>`;

    const from = res.total ? state.userOffset + 1 : 0;
    const to = Math.min(state.userOffset + PAGE_SIZE, res.total);
    $("userPageInfo").textContent = `${from}–${to} of ${res.total}`;
    $("userPrev").disabled = state.userOffset === 0;
    $("userNext").disabled = to >= res.total;
    icons();
  }

  function userRow(u) {
    const self = state.admin && u.id === state.admin.id;
    const overrideOptions = [`<option value="">— purchased —</option>`]
      .concat(PLANS.map((p) => `<option value="${p}"${u.plan_override === p ? " selected" : ""}>${p}</option>`))
      .join("");

    let actions = "";
    if (u.status === "pending") {
      actions += `<button class="btn sm good" data-act="activate" data-id="${h(u.id)}">Activate</button>`;
    }
    if (u.status === "suspended") {
      actions += `<button class="btn sm good" data-act="activate" data-id="${h(u.id)}">Reactivate</button>`;
    }
    if (u.status !== "suspended" && !self) {
      actions += `<button class="btn sm bad" data-act="suspend" data-id="${h(u.id)}" data-email="${h(u.email)}">Suspend</button>`;
    }

    return `<tr>
      <td>${h(u.email)}</td>
      <td><span class="badge b-${h(u.status)}">${h(u.status)}</span></td>
      <td>${h(u.plan)}</td>
      <td><select data-act="override" data-id="${h(u.id)}" aria-label="Plan override for ${h(u.email)}">${overrideOptions}</select></td>
      <td class="num">${h(u.domain_count)}</td>
      <td>${h(u.phone)}</td>
      <td>${h(u.location)}</td>
      <td>${h(when(u.created_at))}</td>
      <td>${u.is_admin ? `<span class="badge b-admin">admin</span>` : ""}
          ${self ? "" : `<button class="btn sm" data-act="${u.is_admin ? "revoke" : "grant"}" data-id="${h(u.id)}" data-email="${h(u.email)}">${u.is_admin ? "Revoke" : "Make admin"}</button>`}</td>
      <td><div class="actions">${actions}</div></td>
    </tr>`;
  }

  let searchTimer;
  $("userSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.userOffset = 0; loadUsers(); }, 300);
  });
  $("userStatus").addEventListener("change", () => { state.userOffset = 0; loadUsers(); });
  $("userRefresh").addEventListener("click", loadUsers);
  $("userPrev").addEventListener("click", () => { state.userOffset = Math.max(0, state.userOffset - PAGE_SIZE); loadUsers(); });
  $("userNext").addEventListener("click", () => { state.userOffset += PAGE_SIZE; loadUsers(); });

  async function updateUser(payload, success) {
    const res = await call("adminUpdateUser", payload);
    if (!res) return false;
    toast(success);
    if (!$("appView").querySelector('[data-panel="users"]').hidden) loadUsers();
    loaders.overview();
    return true;
  }

  // One delegated handler for every action button on the page.
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.dataset.id;
    const email = btn.dataset.email || "this user";
    btn.disabled = true;
    try {
      switch (btn.dataset.act) {
        case "activate":
          await updateUser({ userId: id, status: "active" }, "Account activated. They have been emailed.");
          break;
        case "suspend":
          if (confirm(`Suspend ${email}? They will be locked out immediately.`)) {
            await updateUser({ userId: id, status: "suspended" }, "Account suspended.");
          }
          break;
        case "grant":
          if (confirm(`Give ${email} full admin rights? They will be able to manage every account and see all sales.`)) {
            await updateUser({ userId: id, isAdmin: true }, "Admin rights granted.");
          }
          break;
        case "revoke":
          if (confirm(`Remove admin rights from ${email}?`)) {
            await updateUser({ userId: id, isAdmin: false }, "Admin rights removed.");
          }
          break;
        case "save-price":
          await savePrice(btn.dataset.plan);
          break;
      }
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener("change", async (e) => {
    const sel = e.target.closest('select[data-act="override"]');
    if (!sel) return;
    const label = sel.value || "their purchases";
    if (!confirm(`Set this account's plan to ${label}?`)) return loadUsers();
    await updateUser({ userId: sel.dataset.id, planOverride: sel.value }, "Plan updated.");
  });

  /* --------------------------------------------------------------- sales */

  async function loadSales() {
    const res = await call("adminSales", {
      from: $("salesFrom").value,
      to: $("salesTo").value,
      status: $("salesStatus").value,
    });
    if (!res) return;
    state.sales = res.purchases;

    const totals = Object.entries(res.totals || {});
    $("salesTotals").innerHTML = totals.length ? totals.map(([cur, t]) => `
      <div class="tile"><div class="label">Sales (${h(cur)})</div><div class="value">${h(money(t.completed, cur))}</div>
      <div class="label" style="text-transform:none;margin-top:4px">${t.count} completed · ${h(money(t.refunded, cur))} refunded</div></div>`
    ).join("") : "";

    const attention = res.purchases.filter((p) => p.status === "rejected" || p.status === "unmatched").length;
    $("salesAttention").hidden = attention === 0;
    $("salesAttention").innerHTML = `<b>${attention} payment(s) need review.</b> "Rejected" means the amount or pack did not match
      the price list; "unmatched" means nobody has an account with that email. The customer was charged in both cases:
      refund them in PayPal, or grant the pack with a plan override in Users.`;

    $("salesRows").innerHTML = res.purchases.length ? res.purchases.map((p) => `<tr>
        <td>${h(when(p.created_at))}</td>
        <td><span class="badge b-${h(p.status)}">${h(p.status === "reversed" ? "chargeback" : p.status)}</span></td>
        <td>${h(p.plan || "—")}</td>
        <td class="num">${h(money(p.amount, p.currency))}</td>
        <td>${h(p.email)}</td>
        <td>${h(p.payer_email)}</td>
        <td class="mono">${h(p.txn_id)}</td>
        <td class="wrap">${h(p.reason)}</td>
      </tr>`).join("")
      : `<tr><td colspan="8" class="empty">No payments in this range.</td></tr>`;
  }

  $("salesRefresh").addEventListener("click", loadSales);

  $("salesCsv").addEventListener("click", () => {
    if (!state.sales.length) return toast("Nothing to export.", true);
    const cols = ["created_at", "status", "plan", "amount", "currency", "email", "payer_email", "txn_id", "reason"];
    const cell = (v) => {
      let s = String(v ?? "");
      // Neutralise spreadsheet formula injection.
      if (/^[=+\-@]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(",")].concat(state.sales.map((r) => cols.map((c) => cell(r[c])).join(","))).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), {
      href: url, download: `domain-vault-sales-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  /* -------------------------------------------------------------- prices */

  async function loadPrices() {
    const res = await call("adminGetPrices");
    if (!res) return;
    $("priceRows").innerHTML = res.prices.map((p) => `
      <div class="price-row">
        <b>${h(p.plan)}</b>
        <input type="number" min="0.01" step="0.01" id="price-${h(p.plan)}" value="${p.amount === null ? "" : h(p.amount)}"
               placeholder="Not for sale" aria-label="${h(p.plan)} price">
        <input type="text" maxlength="3" id="currency-${h(p.plan)}" value="${h(p.currency)}" aria-label="${h(p.plan)} currency">
        <button class="btn primary sm" data-act="save-price" data-plan="${h(p.plan)}">Save</button>
      </div>`).join("");
  }

  async function savePrice(plan) {
    const amount = $(`price-${plan}`).value.trim();
    const currency = $(`currency-${plan}`).value.trim().toUpperCase();
    const text = amount ? `${amount} ${currency}` : "not for sale";
    if (!confirm(`Set ${plan} to ${text}?\n\nThe PayPal button for ${plan} must charge exactly this amount.`)) return;
    const res = await call("adminSetPrice", { plan, amount: amount || null, currency });
    if (res) { toast(`${plan} price saved.`); loadPrices(); }
  }

  /* --------------------------------------------------------------- audit */

  function describe(entry) {
    const d = entry.details || {};
    if (d.before && d.after) {
      return Object.keys(d.after)
        .filter((k) => JSON.stringify(d.before[k]) !== JSON.stringify(d.after[k]))
        .map((k) => `${k}: ${d.before[k] ?? "—"} → ${d.after[k] ?? "—"}`)
        .join(", ") || "no change";
    }
    return JSON.stringify(d);
  }

  async function loadAudit() {
    const res = await call("adminAudit", { limit: 200 });
    if (!res) return;
    $("auditRows").innerHTML = res.entries.length ? res.entries.map((e) => `<tr>
        <td>${h(when(e.created_at))}</td><td>${h(e.admin_email)}</td><td>${h(e.action)}</td>
        <td>${h(e.target_email || (e.details && e.details.plan) || "")}</td><td class="wrap">${h(describe(e))}</td>
      </tr>`).join("")
      : `<tr><td colspan="5" class="empty">No admin actions yet.</td></tr>`;
  }

  /* ---------------------------------------------------------------- boot */

  icons();
  API.restore().then((user) => (user ? enter(user) : showLogin()));
})();
