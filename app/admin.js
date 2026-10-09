/* ==========================================================================
   Domain Vault — admin panel
   Every action goes through the api function, which re-checks that the
   caller is an admin and writes an audit entry. Hiding this page would not
   be security; the server check is.
   ========================================================================== */
(function () {
  "use strict";

  const API = window.DomainVaultAPI;
  const PLANS = ["Free", "Personal", "Start-up", "Business", "Agency"];
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

  /** "2027-10-06" from an ISO date or timestamp; "" when there is none. */
  function day(iso) {
    return iso ? String(iso).slice(0, 10) : "";
  }

  function money(amount, currency) {
    if (amount === null || amount === undefined) return "—";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(amount);
    } catch (e) {
      return `${Number(amount).toFixed(2)} ${currency || ""}`;
    }
  }

  function badgeClass(status) {
    switch (status) {
      case "active": case "completed": return "badge-success";
      case "pending": return "badge-warning";
      case "suspended": case "rejected": case "reversed": case "failed": return "badge-danger";
      case "refunded": case "unmatched": return "badge-info";
      default: return "bg-slate-500/10 text-slate-400";
    }
  }

  /** One stat tile (overview and sales totals). */
  function tile(label, value, alert, note) {
    return `<div class="tile bg-surface-card border ${alert ? "border-red-500/30" : "border-surface-border"} rounded-[7px] p-4 flex flex-col justify-center">
        <span class="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1">${h(label)}</span>
        <span class="text-2xl font-bold font-mono ${alert ? "text-red-500" : "text-white"}">${h(value)}</span>
        ${note ? `<span class="text-xs text-slate-400 mt-1">${h(note)}</span>` : ""}
      </div>`;
  }

  function emptyRow(cols, text) {
    return `<tr><td colspan="${cols}" class="text-center py-8 text-slate-500">${h(text)}</td></tr>`;
  }

  let toastTimer;
  function toast(message, isError) {
    const el = $("toast");
    $("toastTitle").textContent = isError ? "Error" : "Success";
    $("toastMsg").textContent = message;
    $("toastIcon").innerHTML = isError
      ? `<i data-lucide="alert-circle" class="w-5 h-5 text-red-500"></i>`
      : `<i data-lucide="check-circle" class="w-5 h-5 text-emerald-500"></i>`;
    icons();
    el.classList.toggle("err", !!isError);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.classList.remove("show"); }, 3500);
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
    $("whoEmail").hidden = true;
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
    $("whoEmail").hidden = false;
    selectTab("overview");
    renderOverview(overview);
    loadPending();
    loadSupportWidget();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = $("loginForm").querySelector('button[type="submit"]');
    $("loginMsg").className = "msg";
    $("loginMsg").textContent = "Signing in…";
    submit.disabled = true;
    try {
      const res = await API.call("loginUser", {
        email: $("loginEmail").value,
        password: $("loginPassword").value,
      }).catch(() => null);
      if (!res || !res.success) {
        return showLogin((res && res.message) || "Cannot reach the server.");
      }
      $("loginPassword").value = "";
      await enter(res.user);
    } finally {
      submit.disabled = false;
    }
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
    tools: () => loadCatalog(),
    support: () => loadSupport(),
    audit: () => loadAudit(),
  };

  function selectTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      selectTab(tab.dataset.tab);
      loaders[tab.dataset.tab]();
    });
  });

  /* ------------------------------------------------------------ overview */

  function renderOverview(o) {
    const users = o.users || {};
    const s = users.byStatus || {};
    const sales = o.sales || {};
    const subs = o.subscriptions ?? null;
    const pending = s.pending || 0;
    const attention = sales.needsAttention || 0;
    $("overviewTiles").innerHTML = [
      tile("Users", users.total ?? 0),
      tile("Pending", pending, pending > 0),
      tile("Active", s.active || 0),
      tile("Suspended", s.suspended || 0),
      tile("Domains tracked", o.domains ?? 0),
      tile("Active subscriptions", subs?.active ?? "—"),
      tile("Cancelled subscriptions", subs?.cancelled ?? "—"),
      tile("Completed sales", sales.completed ?? 0),
      ...Object.entries(sales.revenue || {}).map(([cur, amt]) => tile(`Revenue (${cur})`, money(amt, cur))),
      tile("Payments needing review", attention, attention > 0),
    ].join("");

    $("pendingCount").hidden = pending === 0;
    $("pendingCount").textContent = pending;
    $("attentionCount").hidden = attention === 0;
    $("attentionCount").textContent = attention;
  }

  async function loadPending() {
    const res = await call("adminListUsers", { status: "pending", limit: 100 });
    if (!res) return;
    const users = res.users || [];
    $("pendingRows").innerHTML = users.length
      ? users.map((u) => `<tr>
          <td class="font-medium text-white">${h(u.email)}</td>
          <td class="font-mono text-xs text-slate-400">${h(u.phone)}</td>
          <td>${h(u.location)}</td>
          <td>${h(when(u.created_at))}</td>
          <td class="text-right">
            <button class="btn-base btn-primary !h-8 text-xs" data-act="activate" data-id="${h(u.id)}">
              <i data-lucide="check" class="w-3.5 h-3.5"></i> Activate User
            </button>
          </td>
        </tr>`).join("")
      : emptyRow(5, "Nobody is waiting.");
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
    const users = res.users || [];
    const total = res.total ?? users.length;
    state.userTotal = total;

    $("userRows").innerHTML = users.length ? users.map(userRow).join("") : emptyRow(10, "No users match.");

    const from = total ? state.userOffset + 1 : 0;
    const to = Math.min(state.userOffset + PAGE_SIZE, total);
    $("userPageInfo").textContent = `Showing ${from}–${to} of ${total} users`;
    $("userPrev").disabled = state.userOffset === 0;
    $("userNext").disabled = to >= total;
    icons();
  }

  /** "Business · renews 2027-10-06", "Business · cancelled · until 2027-10-06", or "". */
  function subscriptionText(sub) {
    if (!sub) return "";
    const until = day(sub.paid_until ?? null);
    const parts = sub.plan ? [sub.plan] : [];
    if (sub.status === "active") {
      parts.push(until ? `renews ${until}` : "active");
    } else {
      parts.push(sub.status || "inactive");
      if (until) parts.push(`until ${until}`);
    }
    return parts.join(" · ");
  }

  const SMALL_BTN = "btn-base !h-8 !px-3 text-xs";
  const GOOD_BTN = `${SMALL_BTN} bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20`;
  const BAD_BTN = `${SMALL_BTN} bg-red-500/10 text-red-500 hover:bg-red-500/20`;

  function userRow(u) {
    const self = state.admin && u.id === state.admin.id;
    const overrideOptions = [`<option value="">No override</option>`]
      .concat(PLANS.map((p) => `<option value="${h(p)}"${u.plan_override === p ? " selected" : ""}>${h(p)}</option>`))
      .join("");
    const sub = subscriptionText(u.subscription ?? null);

    let actions = "";
    if (u.status === "pending") {
      actions += `<button class="${GOOD_BTN}" data-act="activate" data-id="${h(u.id)}"><i data-lucide="check" class="w-3.5 h-3.5"></i> Activate</button>`;
    }
    if (u.status === "suspended") {
      actions += `<button class="${GOOD_BTN}" data-act="activate" data-id="${h(u.id)}"><i data-lucide="shield-check" class="w-3.5 h-3.5"></i> Reactivate</button>`;
    }
    if (u.status !== "suspended" && !self) {
      actions += `<button class="${BAD_BTN}" data-act="suspend" data-id="${h(u.id)}" data-email="${h(u.email)}"><i data-lucide="slash" class="w-3.5 h-3.5"></i> Suspend</button>`;
    }

    // Team accounts: people in this user's vault, and teams they belong to.
    const team = [
      u.team_members ? `${u.team_members} team member${u.team_members === 1 ? "" : "s"}` : "",
      u.member_of ? `in ${u.member_of} other team${u.member_of === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" · ");

    return `<tr>
      <td class="font-medium text-white">${h(u.email)}${team ? `<div class="text-[11px] text-slate-400 mt-0.5 font-normal">${h(team)}</div>` : ""}</td>
      <td><span class="badge ${badgeClass(u.status)}">${h(u.status)}</span></td>
      <td>${h(u.plan)}${sub ? `<div class="text-[11px] text-slate-400 mt-0.5">${h(sub)}</div>` : ""}</td>
      <td><select data-act="override" data-id="${h(u.id)}" class="input-base !h-8 !w-36 text-xs" aria-label="Plan override for ${h(u.email)}">${overrideOptions}</select></td>
      <td class="text-right font-mono text-slate-300">${h(u.domain_count)}</td>
      <td class="font-mono text-xs text-slate-400">${h(u.phone)}</td>
      <td>${h(u.location)}</td>
      <td class="text-xs text-slate-400">${h(when(u.created_at))}</td>
      <td><div class="flex items-center gap-2">${u.is_admin ? `<span class="badge badge-primary">admin</span>` : ""}
          ${self ? "" : `<button class="${SMALL_BTN} btn-secondary" data-act="${u.is_admin ? "revoke" : "grant"}" data-id="${h(u.id)}" data-email="${h(u.email)}">${u.is_admin ? "Revoke" : "Make admin"}</button>`}</div></td>
      <td class="text-right"><div class="flex items-center justify-end gap-2">${actions}</div></td>
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
        case "edit-tool":
          editCatalogItem(id);
          break;
        case "delete-tool": {
          const item = state.catalog.find((i) => i.id === id);
          if (item && confirm(`Delete "${item.name}"? Users will no longer see it.`)) {
            const res = await call("adminDeleteCatalogItem", { id });
            if (res) { renderCatalog(res.items || []); resetCatalogForm(); toast("Tool deleted."); }
          }
          break;
        }
      }
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener("change", async (e) => {
    const sel = e.target.closest('select[data-act="override"]');
    if (!sel) return;
    const label = sel.value || "what they paid for (no override)";
    if (!confirm(`Set this account's plan to ${label}?`)) return loadUsers();
    await updateUser({ userId: sel.dataset.id, planOverride: sel.value }, "Plan updated.");
  });

  /* --------------------------------------------------------------- sales */

  function kindCell(p) {
    const kind = p.kind ?? null;
    if (!kind) return `<span class="text-slate-500">—</span>`;
    const label = kind === "subscription" ? "Subscription" : kind === "lifetime" ? "Lifetime" : kind;
    const until = kind === "subscription" && p.paid_until
      ? `<div class="text-[11px] text-slate-400 mt-0.5">until ${h(day(p.paid_until))}</div>` : "";
    return `<span class="badge ${kind === "lifetime" ? "badge-primary" : "badge-info"}">${h(label)}</span>${until}`;
  }

  async function loadSales() {
    const res = await call("adminSales", {
      from: $("salesFrom").value,
      to: $("salesTo").value,
      status: $("salesStatus").value,
    });
    if (!res) return;
    const purchases = res.purchases || [];
    state.sales = purchases;

    $("salesTotals").innerHTML = Object.entries(res.totals || {}).map(([cur, t]) =>
      tile(`Sales (${cur})`, money(t.completed, cur), false, `${t.count} completed · ${money(t.refunded, cur)} refunded`)
    ).join("");

    const attention = purchases.filter((p) => p.status === "rejected" || p.status === "unmatched").length;
    $("salesAttention").hidden = attention === 0;
    $("salesAttention").innerHTML = `<i data-lucide="alert-triangle" class="w-5 h-5 text-brand shrink-0 mt-0.5"></i>
      <p><b class="text-white">${attention} payment(s) need review.</b> "Rejected" means the amount or plan did not match
      the price list; "unmatched" means nobody has an account with that email. The customer was charged in both cases:
      refund them in PayPal, or grant the plan with a plan override in Users.</p>`;

    $("salesRows").innerHTML = purchases.length ? purchases.map((p) => `<tr>
        <td class="text-xs text-slate-400">${h(when(p.created_at))}</td>
        <td><span class="badge ${badgeClass(p.status)}">${h(p.status === "reversed" ? "chargeback" : p.status)}</span></td>
        <td class="font-medium text-slate-300">${h(p.plan || "—")}</td>
        <td>${kindCell(p)}</td>
        <td class="text-right font-mono text-white font-medium">${h(money(p.amount, p.currency))}</td>
        <td>${h(p.email)}</td>
        <td class="text-xs text-slate-400">${h(p.payer_email)}</td>
        <td class="font-mono text-[10px] text-slate-500">${h(p.txn_id)}</td>
        <td class="text-slate-400 whitespace-normal min-w-[220px] text-xs">${h(p.reason)}</td>
      </tr>`).join("")
      : emptyRow(9, "No payments in this range.");
    icons();
  }

  $("salesRefresh").addEventListener("click", loadSales);

  $("salesCsv").addEventListener("click", () => {
    if (!state.sales.length) return toast("Nothing to export.", true);
    const cols = ["created_at", "status", "plan", "kind", "amount", "currency", "email", "payer_email",
      "txn_id", "subscr_id", "paid_until", "reason"];
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

  function priceInput(id, label, value) {
    return `<label class="flex flex-col gap-1.5 text-xs text-slate-400 font-medium">${h(label)}
        <input type="number" min="0.01" step="0.01" id="${h(id)}" class="input-base font-mono"
               value="${value === null || value === undefined ? "" : h(value)}" placeholder="Not for sale">
      </label>`;
  }

  function renderPrices(prices) {
    // Cheapest plan first; anything unknown goes last.
    const rank = (plan) => (PLANS.includes(plan) ? PLANS.indexOf(plan) : PLANS.length);
    $("priceRows").innerHTML = prices.slice().sort((a, b) => rank(a.plan) - rank(b.plan)).map((p) => `
      <div class="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_8.5rem_8.5rem_5.5rem_auto] gap-3 items-end bg-surface-bg border border-surface-border p-3 rounded-lg">
        <div class="col-span-2 sm:col-span-1 self-center">
          <p class="font-medium text-white">${h(p.plan)}</p>
          <p class="text-[11px] text-slate-500 mt-0.5">Must match the ${h(p.plan)} PayPal buttons exactly. Empty = not for sale.</p>
        </div>
        ${priceInput(`price-${p.plan}`, "Yearly subscription", p.amount ?? null)}
        ${priceInput(`lifetime-${p.plan}`, "Lifetime deal", p.lifetimeAmount ?? null)}
        <label class="flex flex-col gap-1.5 text-xs text-slate-400 font-medium">Currency
          <input type="text" maxlength="3" id="currency-${h(p.plan)}" class="input-base text-center uppercase font-mono"
                 value="${h(p.currency || "USD")}" aria-label="${h(p.plan)} currency">
        </label>
        <button class="btn-base btn-primary" data-act="save-price" data-plan="${h(p.plan)}">
          <i data-lucide="save" class="w-4 h-4"></i> Save
        </button>
      </div>`).join("") || `<p class="text-sm text-slate-500">No plans are priced on this server.</p>`;
    icons();
  }

  /** Show the plan settings; disabled when the server does not report them. */
  function renderBillingConfig(config) {
    const known = !!config;
    ["unpaidPlan", "requireApproval", "saveBillingConfig"].forEach((id) => { $(id).disabled = !known; });
    if (!known) return;
    $("unpaidPlan").value = config.unpaidPlan === "Free" ? "Free" : "Personal";
    $("requireApproval").checked = !!config.requireApproval;
  }

  async function loadPrices() {
    const res = await call("adminGetPrices");
    if (!res) return;
    renderPrices(res.prices || []);
    renderBillingConfig(res.config ?? null);
  }

  async function savePrice(plan) {
    const read = (id) => {
      const v = $(id).value.trim();
      return v === "" ? null : Number(v);
    };
    const amount = read(`price-${plan}`);
    const lifetimeAmount = read(`lifetime-${plan}`);
    const currency = $(`currency-${plan}`).value.trim().toUpperCase();
    const show = (v, suffix) => (v === null ? "not for sale" : `${v} ${currency}${suffix}`);
    if (!confirm(`Set ${plan} prices?\n\nYearly subscription: ${show(amount, " per year")}\n` +
      `Lifetime deal: ${show(lifetimeAmount, " once")}\n\n` +
      `The PayPal buttons for ${plan} must charge exactly these amounts.`)) return;
    const res = await call("adminSetPrice", { plan, amount, lifetimeAmount, currency });
    if (!res) return;
    toast(`${plan} price saved.`);
    // Refresh only this plan's row, so unsaved edits in the others survive.
    const saved = (res.prices || []).find((p) => p.plan === plan);
    if (saved) {
      $(`price-${plan}`).value = saved.amount ?? "";
      $(`lifetime-${plan}`).value = saved.lifetimeAmount ?? "";
      $(`currency-${plan}`).value = saved.currency || currency;
    }
  }

  $("saveBillingConfig").addEventListener("click", async () => {
    const btn = $("saveBillingConfig");
    const unpaidPlan = $("unpaidPlan").value;
    const requireApproval = $("requireApproval").checked;
    if (!confirm(`Save plan settings?\n\nAccounts without a paid plan get: ${$("unpaidPlan").selectedOptions[0].textContent}\n` +
      `New sign-ups need approval: ${requireApproval ? "yes" : "no"}`)) return;
    btn.disabled = true;
    try {
      const res = await call("adminSetBillingConfig", { unpaidPlan, requireApproval });
      if (!res) return;
      toast("Plan settings saved.");
      if (res.config) renderBillingConfig(res.config);
    } finally {
      btn.disabled = false;
    }
  });

  /* --------------------------------------------------------------- audit */

  function describe(entry) {
    const d = entry.details || {};
    if (d.after && typeof d.after === "object") {
      const before = d.before || {};
      return Object.keys(d.after)
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(d.after[k]))
        .map((k) => `${k}: ${before[k] ?? "—"} → ${d.after[k] ?? "—"}`)
        .join(", ") || "no change";
    }
    return JSON.stringify(d);
  }

  async function loadAudit() {
    const res = await call("adminAudit", { limit: 200 });
    if (!res) return;
    const entries = res.entries || [];
    $("auditRows").innerHTML = entries.length ? entries.map((e) => `<tr>
        <td class="text-xs text-slate-400">${h(when(e.created_at))}</td>
        <td class="font-medium text-brand text-xs">${h(e.admin_email)}</td>
        <td><span class="badge badge-info">${h(e.action)}</span></td>
        <td class="font-mono text-slate-300 text-xs">${h(e.target_email || (e.details && e.details.plan) || "")}</td>
        <td class="text-slate-400 whitespace-normal min-w-[200px] text-xs">${h(describe(e))}</td>
      </tr>`).join("")
      : emptyRow(5, "No admin actions yet.");
  }

  /* --------------------------------------------------------------- tools */

  state.catalog = [];

  async function loadCatalog() {
    const res = await call("adminListCatalog");
    if (res) renderCatalog(res.items || []);
  }

  function renderCatalog(items) {
    state.catalog = items;
    $("catalogRows").innerHTML = items.length ? items.map((i) => `<tr>
        <td><div class="flex items-center gap-2"><i data-lucide="${/^[a-z0-9-]+$/.test(i.icon || "") ? i.icon : "globe"}" class="w-4 h-4 text-brand shrink-0"></i>
          <div><div class="font-medium text-white">${h(i.name)}</div>
          <a href="${/^https?:\/\//.test(i.url || "") ? h(i.url) : "#"}" target="_blank" rel="noopener" class="text-xs text-slate-400 hover:text-brand break-all">${h(i.url)}</a></div></div></td>
        <td class="text-xs">${i.kind === "provider" ? "Recommended provider" : "Tool"}</td>
        <td class="text-xs text-slate-300">${h((i.tags || []).join(", "))}</td>
        <td class="text-xs">${h(Number(i.rating).toFixed(1))}</td>
        <td class="text-xs">${h(i.sort)}</td>
        <td>${i.active ? '<span class="badge badge-success">Visible</span>' : '<span class="badge badge-info">Hidden</span>'}</td>
        <td><div class="flex gap-2">
          <button class="${SMALL_BTN} btn-secondary" data-act="edit-tool" data-id="${h(i.id)}">Edit</button>
          <button class="${BAD_BTN}" data-act="delete-tool" data-id="${h(i.id)}">Delete</button>
        </div></td>
      </tr>`).join("")
      : emptyRow(7, "No tools yet. Add the first one with the form.");
    icons();
  }

  function resetCatalogForm() {
    $("catalogForm").reset();
    $("catalogId").value = "";
    $("catalogActive").checked = true;
    $("catalogFormTitle").textContent = "Add a tool";
  }

  function editCatalogItem(id) {
    const i = state.catalog.find((x) => x.id === id);
    if (!i) return;
    $("catalogId").value = i.id;
    $("catalogName").value = i.name;
    $("catalogUrl").value = i.url;
    $("catalogDesc").value = i.description || "";
    $("catalogKind").value = i.kind;
    $("catalogIcon").value = i.icon || "";
    $("catalogRating").value = i.rating;
    $("catalogTags").value = (i.tags || []).join(", ");
    $("catalogSort").value = i.sort;
    $("catalogActive").checked = i.active;
    $("catalogFormTitle").textContent = `Edit "${i.name}"`;
    $("catalogName").focus();
  }

  $("catalogReset").addEventListener("click", resetCatalogForm);
  $("catalogForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const item = {
      id: $("catalogId").value || undefined,
      name: $("catalogName").value,
      url: $("catalogUrl").value.trim(),
      description: $("catalogDesc").value,
      kind: $("catalogKind").value,
      icon: $("catalogIcon").value.trim() || "globe",
      rating: $("catalogRating").value,
      tags: $("catalogTags").value,
      sort: $("catalogSort").value,
      active: $("catalogActive").checked,
    };
    $("catalogSave").disabled = true;
    try {
      const res = await call("adminSaveCatalogItem", { item });
      if (res) {
        renderCatalog(res.items || []);
        toast(item.id ? `"${item.name}" updated.` : `"${item.name}" added.`);
        resetCatalogForm();
      }
    } finally {
      $("catalogSave").disabled = false;
    }
  });

  /* ------------------------------------------------------------- support */

  // The helpdesk's operator widget. Its key comes from the server, after the
  // admin check, so it never sits in this public page.
  let supportLoaded = false;

  async function loadSupportWidget() {
    if (supportLoaded) return true;
    const res = await API.call("adminSupportWidget", {}).catch(() => null);
    if (!res || !res.success || !res.configured || !/^[0-9a-f-]{36}$/i.test(res.widgetID || "")) return false;
    window.anw = {
      mainButton: true,
      widgetID: res.widgetID,
      apiKey: res.apiKey,
      showNewMessagePopup: true,
      moduleConfigUrl: res.moduleConfigUrl,
    };
    const js = document.createElement("script");
    js.id = "contactus-jssdk";
    js.src = `https://api.helpdesk.icu/widget/${res.widgetID}/admin-livechat-js?r=${encodeURIComponent(location.href)}`;
    document.head.appendChild(js);
    supportLoaded = true;
    return true;
  }

  async function loadSupport() {
    const ready = await loadSupportWidget();
    $("supportStatus").textContent = ready
      ? "Connected. New messages pop up here; the chat button sits at the bottom right of every tab."
      : "Not connected yet: the chat's widget ID and operator key need to be added to the backend settings (HELPDESK_WIDGET_ID, HELPDESK_ADMIN_API_KEY).";
    $("supportOpen").disabled = !ready;
  }

  $("supportOpen").addEventListener("click", () => {
    // The widget exposes no documented "open" call; clicking its button is the reliable way.
    const button = document.querySelector('[id*="contactus"] button, [class*="contactus"] button, [id*="anw"] button');
    if (button) button.click();
    else toast("Use the chat button at the bottom right.");
  });

  /* ---------------------------------------------------------------- boot */

  icons();
  if (!API) {
    showLogin("The admin panel could not load its API client. Reload the page.");
    return;
  }
  API.restore()
    .then((user) => (user ? enter(user) : showLogin()))
    .catch(() => showLogin("Cannot reach the server."));
})();
