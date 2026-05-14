const DEFAULT_SETTINGS = {
  tenant: "mojodojo",
  page: "projects",
  alternatePage: "credentials",
};

const SETTINGS_KEY = "simpleSearchSettings";
const CACHE_KEY = "simpleSearchOrgsCache";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const $ = (id) => document.getElementById(id);
const searchInput = $("search");
const resultsEl = $("results");
const statusEl = $("status");
const settingsBtn = $("settings-btn");
const settingsOverlay = $("settings-overlay");
const settingsClose = $("settings-close");
const settingsCancel = $("settings-cancel");
const settingsSave = $("settings-save");
const settingTenant = $("setting-tenant");
const settingPage = $("setting-page");
const settingAlternatePage = $("setting-alt-page");

let settings = { ...DEFAULT_SETTINGS };
let allOrgs = []; // { id, name }
let currentMatches = [];
let activeIdx = 0;

// ──────────────────────────────────────────────────────────
// Storage helpers
// ──────────────────────────────────────────────────────────
const hasChromeStorage = typeof chrome !== "undefined" && chrome.storage?.local;

async function loadSettings() {
  if (!hasChromeStorage) {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  }
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] || {}) };
}

async function saveSettings(value) {
  if (!hasChromeStorage) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
    return;
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: value });
}

async function loadCache() {
  if (!hasChromeStorage) {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  }
  const r = await chrome.storage.local.get(CACHE_KEY);
  return r[CACHE_KEY] || null;
}

async function saveCache(cache) {
  if (!hasChromeStorage) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    return;
  }
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

// ──────────────────────────────────────────────────────────
// CRM fetch
// ──────────────────────────────────────────────────────────
function gqlUrl() {
  const tenant = (settings.tenant || "").trim();
  if (!tenant) throw new Error("Set the tenant in Settings first.");
  return `https://new.simpleonboarding.com.au/${tenant}/graphql`;
}

async function fetchOrganizations() {
  const r = await fetch(gqlUrl(), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "*/*" },
    body: JSON.stringify({
      operationName: "GetOrganizationsForDashboard",
      variables: { view: "active" },
      query: `query GetOrganizationsForDashboard($view: String!) {
        organizations(view: $view) {
          id
          name
          accountManager
        }
      }`,
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.message || "GraphQL error");
  return (j.data?.organizations || [])
    .map((o) => ({
      id: o.id,
      name: (o.name || "").trim(),
      accountManager: (o.accountManager || "").trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function orgUrl(orgId, useAlternate = false) {
  const tenant = (settings.tenant || DEFAULT_SETTINGS.tenant).trim();
  const raw = useAlternate
    ? settings.alternatePage || DEFAULT_SETTINGS.alternatePage
    : settings.page || DEFAULT_SETTINGS.page;
  const page = raw.trim().replace(/^\/+|\/+$/g, "");
  const suffix = page ? `/${page}` : "";
  return `https://new.simpleonboarding.com.au/${tenant}/client/${orgId}${suffix}`;
}

// ──────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────
function setStatus(text, kind = "") {
  if (!text) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.className = "status";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function initialsOf(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_PALETTE = [
  { bg: "#4F46E5", fg: "#fff" }, // indigo
  { bg: "#059669", fg: "#fff" }, // emerald
  { bg: "#E11D48", fg: "#fff" }, // rose
  { bg: "#D97706", fg: "#fff" }, // amber
  { bg: "#0284C7", fg: "#fff" }, // sky
  { bg: "#7C3AED", fg: "#fff" }, // violet
  { bg: "#65A30D", fg: "#fff" }, // lime
  { bg: "#A21CAF", fg: "#fff" }, // fuchsia
];

function avatarColorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function makeAvatar(name, role) {
  const el = document.createElement("div");
  el.className = "result-avatar";
  const { bg, fg } = avatarColorFor(name);
  el.style.background = bg;
  el.style.color = fg;
  el.textContent = initialsOf(name);
  el.title = role ? `${role}: ${name}` : name;
  return el;
}

function highlight(name, tokens) {
  if (!tokens.length) return escapeHtml(name);
  const lower = name.toLowerCase();
  const ranges = [];
  for (const t of tokens) {
    if (!t) continue;
    let start = 0;
    while (start < lower.length) {
      const i = lower.indexOf(t, start);
      if (i < 0) break;
      ranges.push([i, i + t.length]);
      start = i + t.length;
    }
  }
  if (!ranges.length) return escapeHtml(name);
  ranges.sort((a, b) => a[0] - b[0]);
  // merge overlaps
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }
  let out = "";
  let cursor = 0;
  for (const [s, e] of merged) {
    out += escapeHtml(name.slice(cursor, s));
    out += "<mark>" + escapeHtml(name.slice(s, e)) + "</mark>";
    cursor = e;
  }
  out += escapeHtml(name.slice(cursor));
  return out;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderResults() {
  const q = searchInput.value.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);

  currentMatches = tokens.length
    ? allOrgs.filter((o) =>
        tokens.every((t) => o.name.toLowerCase().includes(t))
      )
    : allOrgs.slice();

  resultsEl.innerHTML = "";
  activeIdx = Math.min(activeIdx, Math.max(0, currentMatches.length - 1));

  if (currentMatches.length === 0) {
    setStatus(allOrgs.length ? "— no matches —" : "— no organisations loaded —");
    return;
  }
  setStatus("");

  currentMatches.forEach((o, i) => {
    const item = document.createElement("div");
    item.className = "result" + (i === activeIdx ? " active" : "");
    item.setAttribute("role", "option");
    item.dataset.idx = String(i);

    const name = document.createElement("div");
    name.className = "name";
    name.innerHTML = highlight(o.name, tokens);
    item.appendChild(name);

    if (o.accountManager || o.contentManager) {
      const group = document.createElement("div");
      group.className = "result-avatars";
      if (o.accountManager) {
        group.appendChild(makeAvatar(o.accountManager, "Account manager"));
      }
      item.appendChild(group);
    }

    item.addEventListener("mouseenter", () => setActive(i));
    item.addEventListener("click", (ev) => openOrg(i, ev.shiftKey));
    resultsEl.appendChild(item);
  });

  ensureActiveVisible();
}

function setActive(idx) {
  if (idx < 0 || idx >= currentMatches.length) return;
  activeIdx = idx;
  const items = resultsEl.querySelectorAll(".result");
  items.forEach((el, i) => el.classList.toggle("active", i === idx));
  ensureActiveVisible();
}

function ensureActiveVisible() {
  const el = resultsEl.querySelector(".result.active");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function openOrg(idx, useAlternate = false) {
  const org = currentMatches[idx];
  if (!org) return;
  try {
    const url = orgUrl(org.id, useAlternate);
    chrome.tabs.create({ url });
    window.close();
  } catch (e) {
    setStatus(`Couldn't open: ${e.message}`, "err");
  }
}

// ──────────────────────────────────────────────────────────
// Load orgs (cache-first, refresh in background)
// ──────────────────────────────────────────────────────────
async function loadOrgs() {
  const cache = await loadCache();
  const now = Date.now();
  const fresh = cache && cache.tenant === settings.tenant && now - cache.at < CACHE_TTL_MS;

  if (cache && cache.tenant === settings.tenant) {
    allOrgs = cache.orgs || [];
    renderResults();
  } else {
    setStatus("Loading organisations…");
  }

  if (fresh) return;

  try {
    const list = await fetchOrganizations();
    allOrgs = list;
    await saveCache({ tenant: settings.tenant, orgs: list, at: Date.now() });
    renderResults();
  } catch (e) {
    if (allOrgs.length === 0) {
      setStatus(
        `Couldn't load: ${e.message}. Make sure you're logged in to SimpleOnboarding.`,
        "err"
      );
    }
  }
}

// ──────────────────────────────────────────────────────────
// Settings panel
// ──────────────────────────────────────────────────────────
function openSettings() {
  settingTenant.value = settings.tenant || "";
  settingPage.value = settings.page || "";
  settingAlternatePage.value = settings.alternatePage || "";
  settingsOverlay.hidden = false;
  settingTenant.focus();
}

function closeSettings() {
  settingsOverlay.hidden = true;
  searchInput.focus();
}

async function saveSettingsFromForm() {
  const tenant = settingTenant.value.trim() || DEFAULT_SETTINGS.tenant;
  const page = settingPage.value.trim();
  const alternatePage = settingAlternatePage.value.trim();
  const prevTenant = settings.tenant;
  settings = {
    tenant,
    page: page || DEFAULT_SETTINGS.page,
    alternatePage: alternatePage || DEFAULT_SETTINGS.alternatePage,
  };
  await saveSettings(settings);
  closeSettings();
  if (prevTenant !== settings.tenant) {
    allOrgs = [];
    await loadOrgs();
  }
}

settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsCancel.addEventListener("click", closeSettings);
settingsSave.addEventListener("click", saveSettingsFromForm);

// ──────────────────────────────────────────────────────────
// Input + keyboard
// ──────────────────────────────────────────────────────────
searchInput.addEventListener("input", () => {
  activeIdx = 0;
  renderResults();
});

searchInput.addEventListener("keydown", (e) => {
  if (!settingsOverlay.hidden) return; // settings open — let inputs handle
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (currentMatches.length) setActive((activeIdx + 1) % currentMatches.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (currentMatches.length)
      setActive(
        (activeIdx - 1 + currentMatches.length) % currentMatches.length
      );
  } else if (e.key === "Enter") {
    e.preventDefault();
    openOrg(activeIdx, e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    window.close();
  }
});

document.addEventListener("keydown", (e) => {
  if (!settingsOverlay.hidden && e.key === "Escape") {
    e.preventDefault();
    closeSettings();
  }
});

settingTenant.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveSettingsFromForm();
  }
});
settingPage.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveSettingsFromForm();
  }
});
settingAlternatePage.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveSettingsFromForm();
  }
});

// ──────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────
(async function init() {
  settings = await loadSettings();
  searchInput.focus();
  await loadOrgs();
})();
