/* ==========================================================================
   Domain Vault — domain search (shared by /tools/domain-lookup,
   /es/recursos/buscador-de-dominio and /tools/domain-lookup-app)

   Asks our domain-search function whether a name is free (the registry's own
   RDAP answer) and what it costs to own at each registrar: first year,
   renewal, and 5 years (first year + 4 renewals). Prices and the registrars'
   buy links are managed in Admin → Domain search.

   Needs /config.js loaded first (functionsUrl). The page keeps its own markup;
   this script only needs the element ids the pages share.
   ========================================================================== */
(function () {
  "use strict";

  if (window.lucide) window.lucide.createIcons();

  var CONFIG = window.DOMAIN_VAULT_CONFIG || {};
  var ENDPOINT = (CONFIG.functionsUrl || "") + "/domain-search";
  var LANG = (document.documentElement.lang || "en").slice(0, 2) === "es" ? "es" : "en";
  // Inside the app (an iframe), a taken name the user owns can be added to their vault.
  var EMBEDDED = window.parent !== window;

  var T = {
    en: {
      invalid: "Please enter a valid domain name, like mystartup.com.",
      checking: "Asking the registry…",
      available: "Available!",
      availableMsg: "Not registered. Here is what it costs to own:",
      likely: "Likely available.",
      likelyMsg: "This extension's registry offers no live lookup, and the name has no DNS. Confirm at checkout.",
      taken: "Unavailable.",
      takenMsg: "This domain is already registered.",
      registrar: "Registrar", expires: "Expires", created: "Registered", daysLeft: "{n} days left",
      unknown: "Could not check.",
      unknownMsg: "The registry did not answer. Try again in a moment.",
      error: "Lookup error.",
      noPrices: "We have no prices for .{tld} yet.",
      alternatives: "Free under other extensions:",
      from: "5 yrs from",
      getIt: "Get It",
      perYear: "/yr",
      footnote: "List prices in USD, checked {date}. Premium names and taxes may change the price at checkout. Some links are affiliate links: they cost you nothing and support Domain Vault.",
      addToVault: "Add to my vault",
      tooMany: "Too many searches. Wait a few minutes and try again."
    },
    es: {
      invalid: "Escribe un dominio válido, por ejemplo miempresa.com.",
      checking: "Consultando el registro…",
      available: "¡Disponible!",
      availableMsg: "No está registrado. Esto cuesta tenerlo:",
      likely: "Probablemente disponible.",
      likelyMsg: "El registro de esta extensión no ofrece consulta en vivo y el nombre no tiene DNS. Confírmalo al comprar.",
      taken: "No disponible.",
      takenMsg: "Este dominio ya está registrado.",
      registrar: "Registrador", expires: "Vence", created: "Registrado", daysLeft: "quedan {n} días",
      unknown: "No se pudo comprobar.",
      unknownMsg: "El registro no respondió. Inténtalo de nuevo en un momento.",
      error: "Error en la consulta.",
      noPrices: "Aún no tenemos precios para .{tld}.",
      alternatives: "Libre en otras extensiones:",
      from: "5 años desde",
      getIt: "Comprar",
      perYear: "/año",
      footnote: "Precios de lista en USD, revisados el {date}. Los nombres premium y los impuestos pueden cambiar el precio al pagar. Algunos enlaces son de afiliado: no te cuestan nada y apoyan a Domain Vault.",
      addToVault: "Añadir a mi bóveda",
      tooMany: "Demasiadas búsquedas. Espera unos minutos y vuelve a intentarlo."
    }
  }[LANG];

  var $ = function (id) { return document.getElementById(id); };
  var form = $("search-form"), input = $("domain-input"), searchBtn = $("search-btn"), errorMsg = $("error-message");
  var statusContainer = $("status-container"), statusCard = $("status-card"), statusIconWrapper = $("status-icon-wrapper");
  var statusIcon = $("status-icon"), statusDomainName = $("status-domain-name"), statusMessage = $("status-message");
  var resultsContainer = $("results-container"), tableBody = $("table-body");
  if (!form || !tableBody) return;

  var searchBtnHtml = searchBtn.innerHTML;
  var results = [];
  var currentSort = { column: "total", direction: "asc" };
  var busy = false;

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) { return "$" + Number(n).toFixed(2); }
  function safeUrl(u) { return /^https:\/\//i.test(u || "") ? u : "#"; }

  // Extra blocks under the status card: registration details, other
  // extensions, and the price footnote. Created once, in the page's style.
  var details = document.createElement("div");
  details.className = "mt-3 text-sm text-brand-muted font-code hidden";
  statusCard.parentNode.appendChild(details);
  var alternatives = document.createElement("div");
  alternatives.className = "mt-4 hidden";
  statusCard.parentNode.appendChild(alternatives);
  var footnote = document.createElement("p");
  footnote.className = "text-xs text-brand-muted/70 px-6 py-4 border-t border-brand-border/30";
  resultsContainer.appendChild(footnote);

  function setStatus(kind, title, message) {
    var styles = {
      loading: ["bg-brand-card border-brand-border", "bg-brand-bgDarker text-brand-textMain", "fa-solid fa-spinner fa-spin"],
      available: ["bg-[#0a1a0f] border-brand-success/50", "bg-brand-success/20 text-brand-success", "fa-solid fa-circle-check"],
      likely: ["bg-[#0a1a0f] border-brand-success/30", "bg-brand-success/10 text-brand-success", "fa-solid fa-circle-check"],
      taken: ["bg-[#1a0a0a] border-brand-danger/50", "bg-brand-danger/20 text-brand-danger", "fa-solid fa-circle-xmark"],
      warning: ["bg-[#1a1a0a] border-brand-warning/40", "bg-brand-warning/20 text-brand-warning", "fa-solid fa-triangle-exclamation"]
    }[kind];
    statusCard.className = "rounded-xl p-6 border flex items-center justify-between " + styles[0];
    statusIconWrapper.className = "w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0 " + styles[1];
    statusIcon.className = styles[2];
    var color = kind === "taken" ? "text-brand-danger" : kind === "warning" ? "text-brand-warning" : "text-brand-success";
    statusMessage.innerHTML = title ? '<span class="' + color + ' font-medium">' + esc(title) + "</span> " + esc(message || "") : esc(message || "");
  }

  function boolIcon(value) {
    var v = String(value || "").toLowerCase();
    var icon = v.indexOf("free") !== -1 || v.indexOf("gratis") !== -1
      ? '<i class="fa-solid fa-circle-check text-brand-success text-lg drop-shadow-[0_0_8px_rgba(81,207,102,0.4)]"></i>'
      : v.indexOf("basic") !== -1
        ? '<i class="fa-solid fa-shield-halved text-brand-warning text-lg"></i>'
        : '<i class="fa-solid fa-circle-xmark text-brand-muted/40 text-lg"></i>';
    return value ? '<div class="tooltip-container">' + icon + '<span class="tooltip-text">' + esc(value) + "</span></div>" : icon;
  }

  function skeleton(count) {
    var row = '<tr class="border-b border-brand-border/30">' +
      '<td class="py-4 px-6"><div class="flex items-center gap-2"><div class="w-6 h-6 skeleton rounded-full"></div><div class="h-4 w-24 skeleton"></div></div></td>' +
      '<td class="py-4 px-6"><div class="h-4 w-16 skeleton"></div></td><td class="py-4 px-6"><div class="h-4 w-16 skeleton"></div></td>' +
      '<td class="py-4 px-6"><div class="h-5 w-20 skeleton"></div></td>' +
      '<td class="py-4 px-6 text-center"><div class="h-5 w-5 mx-auto skeleton rounded-full"></div></td>' +
      '<td class="py-4 px-6 text-center"><div class="h-5 w-5 mx-auto skeleton rounded-full"></div></td>' +
      '<td class="py-4 px-6 text-right"><div class="h-8 w-24 ml-auto skeleton rounded-md"></div></td></tr>';
    tableBody.innerHTML = new Array(count + 1).join(row);
  }

  function rowHtml(r) {
    var url = esc(safeUrl(r.url));
    return '<td class="py-4 px-6 h-[72px] align-middle"><div class="flex flex-col justify-center">' +
        '<div class="flex items-center"><span class="font-medium text-brand-textMain font-tech uppercase tracking-wider text-sm">' + esc(r.name) + "</span>" +
        (r.notes ? '<div class="tooltip-container ml-2"><i class="fa-solid fa-circle-info text-brand-primary text-sm"></i><span class="tooltip-text w-48">' + esc(r.notes) + "</span></div>" : "") +
        "</div>" +
        '<a href="' + url + '" target="_blank" rel="sponsored noopener" class="text-xs text-brand-muted hover:text-brand-primary transition-colors font-code mt-0.5 inline-flex items-center gap-1 w-max">' +
        esc(r.website) + ' <i class="fa-solid fa-up-right-from-square text-[9px]"></i></a></div></td>' +
      '<td class="py-4 px-6 font-code text-brand-textMain">' + money(r.register) + "</td>" +
      '<td class="py-4 px-6 font-code text-brand-muted/70">' + money(r.renew) + T.perYear + "</td>" +
      '<td class="py-4 px-6 font-code font-bold text-brand-primary text-lg">' + money(r.total5) + "</td>" +
      '<td class="py-4 px-6 text-center">' + boolIcon(r.whois) + "</td>" +
      '<td class="py-4 px-6 text-center">' + boolIcon(r.ssl) + "</td>" +
      '<td class="py-4 px-6 text-right"><a href="' + url + '" target="_blank" rel="sponsored noopener" class="whitespace-nowrap inline-flex items-center gap-2 bg-transparent border border-brand-primary text-brand-primary hover:bg-brand-primary hover:text-white hover:shadow-glow text-sm font-code font-medium py-2 px-4 rounded transition-all">' +
        esc(T.getIt) + ' <i class="fa-solid fa-arrow-right-long text-xs"></i></a></td>';
  }

  function sorted() {
    var key = currentSort.column === "purchasing" ? "register" : "total5";
    var dir = currentSort.direction === "asc" ? 1 : -1;
    return results.slice().sort(function (a, b) { return (a[key] - b[key]) * dir || a.total5 - b.total5; });
  }

  function renderRows(animate) {
    tableBody.innerHTML = "";
    sorted().forEach(function (r, i) {
      var tr = document.createElement("tr");
      tr.className = "hover:bg-brand-hover transition-colors border-b border-brand-border/30" + (animate ? " row-enter" : "");
      if (animate) tr.style.animationDelay = (i * 60) + "ms";
      tr.innerHTML = rowHtml(r);
      tableBody.appendChild(tr);
    });
  }

  function updateSortIcons() {
    ["purchasing", "total"].forEach(function (c) {
      var el = $("sort-icon-" + c);
      if (!el) return;
      el.className = c === currentSort.column
        ? "fa-solid fa-sort-" + (currentSort.direction === "asc" ? "up" : "down") + " text-brand-primary"
        : "fa-solid fa-sort text-brand-muted/50";
    });
  }

  // The pages call handleSort('purchasing' | 'total') from their headers.
  window.handleSort = function (column) {
    if (!results.length) return;
    currentSort = currentSort.column === column
      ? { column: column, direction: currentSort.direction === "asc" ? "desc" : "asc" }
      : { column: column, direction: "asc" };
    updateSortIcons();
    renderRows(false);
  };

  function daysLeft(dateStr) {
    var ms = new Date(dateStr + "T00:00:00Z") - Date.now();
    return Math.ceil(ms / 86400000);
  }

  function showRegistration(data) {
    var reg = data.registration;
    if (!reg || !(reg.registrar || reg.expires || reg.created)) { details.classList.add("hidden"); return; }
    var parts = [];
    if (reg.registrar) parts.push(esc(T.registrar) + ': <span class="text-brand-textMain">' + esc(reg.registrar) + "</span>");
    if (reg.created) parts.push(esc(T.created) + ': <span class="text-brand-textMain">' + esc(reg.created) + "</span>");
    if (reg.expires) {
      var n = daysLeft(reg.expires);
      parts.push(esc(T.expires) + ': <span class="text-brand-textMain">' + esc(reg.expires) + "</span>" +
        (n >= 0 ? " (" + esc(T.daysLeft.replace("{n}", n)) + ")" : ""));
    }
    details.innerHTML = '<div class="flex flex-wrap gap-x-6 gap-y-1 items-center">' + parts.map(function (p) { return "<span>" + p + "</span>"; }).join("") +
      (EMBEDDED ? '<button type="button" id="ds-track" class="ml-auto inline-flex items-center gap-2 border border-brand-primary text-brand-primary hover:bg-brand-primary hover:text-white text-sm font-medium py-1.5 px-3 rounded transition-all"><i class="fa-solid fa-plus text-xs"></i> ' + esc(T.addToVault) + "</button>" : "") +
      "</div>";
    details.classList.remove("hidden");
    var track = $("ds-track");
    if (track) {
      track.addEventListener("click", function () {
        // The app checks the message comes from this frame.
        window.parent.postMessage({ type: "dv:track-domain", domain: data.domain, created: reg.created, expires: reg.expires, registrar: reg.registrar }, "*");
      });
    }
  }

  function showAlternatives(list) {
    if (!list || !list.length) { alternatives.classList.add("hidden"); return; }
    alternatives.innerHTML = '<p class="text-sm text-brand-muted mb-2">' + esc(T.alternatives) + '</p><div class="flex flex-wrap gap-2">' +
      list.map(function (a) {
        return '<button type="button" data-domain="' + esc(a.domain) + '" class="ds-alt inline-flex items-center gap-2 bg-brand-card border border-brand-border hover:border-brand-primary rounded-lg px-3 py-2 text-sm font-code transition-colors">' +
          '<i class="fa-solid fa-circle-check text-brand-success text-xs"></i><span class="text-brand-textMain">' + esc(a.domain) + "</span>" +
          (a.cheapest ? '<span class="text-brand-muted text-xs">' + esc(T.from) + " " + money(a.cheapest.total5) + "</span>" : "") + "</button>";
      }).join("") + "</div>";
    alternatives.classList.remove("hidden");
    alternatives.querySelectorAll(".ds-alt").forEach(function (b) {
      b.addEventListener("click", function () { input.value = b.dataset.domain; run(); });
    });
  }

  function done() {
    busy = false;
    searchBtn.innerHTML = searchBtnHtml;
    searchBtn.classList.remove("opacity-80", "cursor-not-allowed");
  }

  function run() {
    if (busy) return;
    var domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    input.value = domain;
    if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      errorMsg.textContent = T.invalid;
      errorMsg.classList.remove("hidden");
      form.classList.add("ring-1", "ring-brand-danger", "border-brand-danger");
      return;
    }
    errorMsg.classList.add("hidden");
    form.classList.remove("ring-1", "ring-brand-danger", "border-brand-danger");
    busy = true;
    results = [];
    searchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    searchBtn.classList.add("opacity-80", "cursor-not-allowed");
    statusContainer.classList.remove("hidden");
    resultsContainer.classList.add("hidden");
    details.classList.add("hidden");
    alternatives.classList.add("hidden");
    statusDomainName.textContent = domain;
    setStatus("loading", "", T.checking);
    skeleton(6);

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CONFIG.anonKey || "" },
      body: JSON.stringify({ action: "search", domain: domain })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (r) {
        var data = r.body;
        if (r.status === 429) return setStatus("warning", T.error, T.tooMany);
        if (!data || data.success === false) return setStatus("warning", T.error, (data && data.message) || T.unknownMsg);

        if (data.status === "registered") {
          setStatus("taken", T.taken, T.takenMsg);
          showRegistration(data);
          showAlternatives(data.alternatives);
          return;
        }
        if (data.status === "unknown") return setStatus("warning", T.unknown, T.unknownMsg);

        setStatus(data.status === "available" ? "available" : "likely",
          data.status === "available" ? T.available : T.likely,
          data.status === "available" ? T.availableMsg : T.likelyMsg);
        results = data.prices || [];
        if (!results.length) {
          statusMessage.innerHTML += " " + esc(T.noPrices.replace("{tld}", data.tld));
          return;
        }
        var newest = results.map(function (p) { return p.updatedAt || ""; }).sort().pop();
        footnote.textContent = T.footnote.replace("{date}", newest ? new Date(newest).toLocaleDateString(LANG) : "—");
        currentSort = { column: "total", direction: "asc" };
        updateSortIcons();
        resultsContainer.classList.remove("hidden");
        renderRows(true);
      })
      .catch(function () { setStatus("warning", T.error, T.unknownMsg); })
      .then(done);
  }

  form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
  input.addEventListener("input", function (e) {
    e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9.\-]/g, "");
  });

  // ?q=name.com searches straight away (links from the app and elsewhere).
  var q = new URLSearchParams(location.search).get("q");
  if (q) { input.value = q; run(); }
})();
