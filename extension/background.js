// =============================================================================
// PixVerse Auto-Register - Background Service Worker
// =============================================================================
// Verantwortlich fuer:
//   - mail.tm API Calls (Account anlegen, Token holen, Inbox pollen)
//   - Persistenter Zustand via chrome.storage.local
//   - Message-Routing zwischen Popup und Content-Script
//   - Periodisches Polling der Inbox waehrend ein Run laeuft
// =============================================================================

const MAIL_TM_BASE = "https://api.mail.tm";

// -----------------------------------------------------------------------------
// State helpers
// -----------------------------------------------------------------------------
const STATE_KEYS = {
  STATUS: "pv_status",
  ACCOUNT: "pv_account",  // { username, email, password, mailPassword }
  MAIL_TOKEN: "pv_mail_token",
  LAST_LOG: "pv_log",
  RUN_ACTIVE: "pv_run_active",
  REPEAT_TOTAL: "pv_repeat_total",
  REPEAT_DONE: "pv_repeat_done",
};

async function getState() {
  return await chrome.storage.local.get(Object.values(STATE_KEYS));
}

async function setStatus(status) {
  await chrome.storage.local.set({ [STATE_KEYS.STATUS]: status });
  log(`status -> ${status}`);
}

async function log(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  const entry = `[${stamp}] ${line}`;
  console.log("[PV-BG]", entry);
  const cur = (await chrome.storage.local.get(STATE_KEYS.LAST_LOG))[STATE_KEYS.LAST_LOG] || [];
  cur.push(entry);
  // keep only last 200 lines
  while (cur.length > 200) cur.shift();
  await chrome.storage.local.set({ [STATE_KEYS.LAST_LOG]: cur });
}

// -----------------------------------------------------------------------------
// Random helpers (account credentials)
// -----------------------------------------------------------------------------
function randString(len, alphabet) {
  const a = alphabet || "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) s += a[buf[i] % a.length];
  return s;
}

function generateUsername() {
  // Letters only, length 8 (mirror existing python script)
  return randString(8, "abcdefghijklmnopqrstuvwxyz");
}

function generatePassword() {
  // Strong-enough: upper + lower + digits + symbol
  const upper = randString(2, "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const lower = randString(4, "abcdefghijklmnopqrstuvwxyz");
  const digits = randString(3, "0123456789");
  const sym = "!"; // PixVerse accepts ! per existing script
  return `Tx${upper}${lower}${digits}${sym}`;
}

// -----------------------------------------------------------------------------
// mail.tm API
// -----------------------------------------------------------------------------
async function mailTmFetch(path, options = {}) {
  const res = await fetch(`${MAIL_TM_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/ld+json",
      ...(options.headers || {}),
    },
  });
  return res;
}

async function mailTmGetDomain(preferred) {
  const res = await mailTmFetch("/domains?page=1");
  if (!res.ok) throw new Error(`mail.tm /domains failed: ${res.status}`);
  const data = await res.json();
  const list = data["hydra:member"] || [];
  if (!list.length) throw new Error("mail.tm: no active domains returned");
  if (preferred) {
    const match = list.find((d) => d.domain === preferred && d.isActive !== false);
    if (match) return match.domain;
  }
  // fall back to first active
  const active = list.find((d) => d.isActive !== false) || list[0];
  return active.domain;
}

async function mailTmCreateAccount(preferredDomain) {
  const domain = await mailTmGetDomain(preferredDomain);
  const localPart = randString(10);
  const address = `${localPart}@${domain}`;
  const password = randString(14, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");

  const createRes = await mailTmFetch("/accounts", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  if (createRes.status !== 201) {
    const txt = await createRes.text();
    const err = new Error(`mail.tm /accounts ${createRes.status}: ${txt.slice(0, 200)}`);
    err.status = createRes.status;
    err.retryAfter = parseInt(createRes.headers.get("retry-after") || "0", 10);
    throw err;
  }

  const tokenRes = await mailTmFetch("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    const err = new Error(`mail.tm /token ${tokenRes.status}: ${txt.slice(0, 200)}`);
    err.status = tokenRes.status;
    err.retryAfter = parseInt(tokenRes.headers.get("retry-after") || "0", 10);
    throw err;
  }
  const tokenData = await tokenRes.json();
  return { address, password, token: tokenData.token, id: tokenData.id, domain };
}

// Retry wrapper: mail.tm rate-limits new account creation per IP. On 429 we
// back off with increasing delays. Other errors fail fast.
async function mailTmCreateAccountWithRetry(preferredDomain) {
  // Backoff schedule in seconds. mail.tm typically needs ~30-60s between
  // accounts from the same IP; we go up to 3min for resilience.
  const backoffSec = [0, 30, 60, 90, 120, 180];
  let lastErr;
  for (let i = 0; i < backoffSec.length; i++) {
    if (backoffSec[i] > 0) {
      const wait = (lastErr && lastErr.retryAfter) ? Math.max(lastErr.retryAfter, backoffSec[i]) : backoffSec[i];
      log(`mail.tm 429 backoff: waiting ${wait}s before retry ${i}/${backoffSec.length - 1}`);
      await setStatus("rate-limited");
      await new Promise((r) => setTimeout(r, wait * 1000));
      await setStatus("creating-mailbox");
    }
    try {
      return await mailTmCreateAccount(preferredDomain);
    } catch (e) {
      lastErr = e;
      if (e.status === 429) {
        log(`mail.tm: 429 on attempt ${i + 1}, will retry`);
        continue;
      }
      // Non-rate-limit failure: don't retry, propagate.
      throw e;
    }
  }
  throw lastErr || new Error("mail.tm: exhausted retries");
}

async function mailTmListMessages(token) {
  const res = await mailTmFetch("/messages?page=1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`mail.tm /messages ${res.status}`);
  const data = await res.json();
  return data["hydra:member"] || [];
}

async function mailTmGetMessage(token, msgId) {
  const res = await mailTmFetch(`/messages/${msgId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`mail.tm /messages/${msgId} ${res.status}`);
  return await res.json();
}

// -----------------------------------------------------------------------------
// Verification code / link extraction
// -----------------------------------------------------------------------------
function extractVerificationFromMessage(msg) {
  const text = msg.text || "";
  const html = Array.isArray(msg.html) ? msg.html.join(" ") : (msg.html || "");
  const full = `${text} ${html}`;

  // 1. Look for 4-6 digit numeric codes. Prefer the first 6-digit one,
  //    then 4-5 digits.
  let code = null;
  const allCodes = full.match(/\b\d{4,8}\b/g) || [];
  const candidates = allCodes.filter((c) => c.length >= 4 && c.length <= 6);
  if (candidates.length) {
    const six = candidates.find((c) => c.length === 6);
    code = six || candidates[0];
  }

  // 2. Look for a verification link to pixverse.
  let link = null;
  const linkRe = /https?:\/\/[^\s<>"'\)]+/g;
  const links = full.match(linkRe) || [];
  for (const l of links) {
    const lower = l.toLowerCase();
    if (lower.includes("pixverse") &&
        /(verify|confirm|activate|reset|register|email)/.test(lower)) {
      link = l.replace(/[.,;:)>\]]+$/, "");
      break;
    }
  }

  return { code, link, subject: msg.subject || "", from: msg.from };
}

// -----------------------------------------------------------------------------
// Run orchestration
// -----------------------------------------------------------------------------
async function startRun(opts = {}) {
  // Initialise repeat counters on the first run only. Subsequent iterations
  // pass keepCounters:true and just increment pv_repeat_done after each
  // successful claim.
  if (!opts.keepCounters) {
    const total = Math.max(1, parseInt(opts.repeatTotal, 10) || 1);
    await chrome.storage.local.set({
      [STATE_KEYS.REPEAT_TOTAL]: total,
      [STATE_KEYS.REPEAT_DONE]: 0,
      [STATE_KEYS.LAST_LOG]: [],
    });
    log(`Run started (target: ${total} iterations)`);
  } else {
    log(`Run started (continuation, iteration ${(await currentIter()) + 1})`);
  }
  await chrome.storage.local.set({ [STATE_KEYS.RUN_ACTIVE]: true });

  // Wipe any previous per-iteration state BEFORE we navigate, otherwise the
  // content-script boot block would race-trigger fillForm() with the stale
  // pv_account from the previous iteration.
  await chrome.storage.local.remove([
    STATE_KEYS.ACCOUNT,
    STATE_KEYS.MAIL_TOKEN,
    "pv_verification",
  ]);

  // Always start each run from a clean, logged-out /register page. This also
  // covers the very first run when the user happens to already be logged in.
  await setStatus("logging-out");
  const tab = await forceLogoutAndOpenRegister();

  await setStatus("creating-mailbox");

  let mailbox;
  try {
    mailbox = await mailTmCreateAccountWithRetry(opts.preferredDomain || "wshu.net");
  } catch (e) {
    log(`mail.tm error: ${e.message}`);
    await setStatus("error");
    await chrome.storage.local.set({ [STATE_KEYS.RUN_ACTIVE]: false });
    return { ok: false, error: e.message };
  }

  const account = {
    username: generateUsername(),
    email: mailbox.address,
    password: generatePassword(),
    mailPassword: mailbox.password,
    domain: mailbox.domain,
    createdAt: new Date().toISOString(),
  };

  await chrome.storage.local.set({
    [STATE_KEYS.ACCOUNT]: account,
    [STATE_KEYS.MAIL_TOKEN]: mailbox.token,
  });

  // Append to permanent account history. This survives 'Clear' in the popup
  // so the user never loses credentials. The popup exports it as a .txt.
  try {
    const stored = await chrome.storage.local.get("pv_accounts_history");
    const history = Array.isArray(stored.pv_accounts_history) ? stored.pv_accounts_history : [];
    const referral = (await chrome.storage.local.get("pv_referral_code")).pv_referral_code || "";
    history.push({ ...account, referral });
    // Cap at 1000 entries.
    while (history.length > 1000) history.shift();
    await chrome.storage.local.set({ pv_accounts_history: history });
    log(`Account history: ${history.length} entry/entries stored`);
  } catch (e) {
    log(`history append failed: ${e.message}`);
  }

  log(`Mailbox ready: ${account.email}`);
  log(`Username: ${account.username}`);
  await setStatus("mailbox-ready");

  // Schedule periodic inbox polling.
  await chrome.alarms.clear("pv-inbox-poll");
  await chrome.alarms.create("pv-inbox-poll", { periodInMinutes: 0.1 }); // every 6s

  // The tab is already on /register from forceLogoutAndOpenRegister.
  // Give the content script a small grace period after re-injection.
  await new Promise((r) => setTimeout(r, 600));
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PV_FILL_FORM", account });
    log("Sent PV_FILL_FORM to tab " + tab.id);
  } catch (e) {
    log(`sendMessage failed (will retry on tab load): ${e.message}`);
  }
  await setStatus("filling-form");

  return { ok: true, account };
}

async function currentIter() {
  return (await chrome.storage.local.get(STATE_KEYS.REPEAT_DONE))[STATE_KEYS.REPEAT_DONE] || 0;
}

async function stopRun() {
  await chrome.alarms.clear("pv-inbox-poll");
  await chrome.alarms.clear("pv-next-iteration");
  await chrome.storage.local.set({ [STATE_KEYS.RUN_ACTIVE]: false });
  await setStatus("idle");
  log("Run stopped");
}

// -----------------------------------------------------------------------------
// Repeat-loop: log out (purge cookies), navigate to /register, start new run.
// -----------------------------------------------------------------------------
async function clearPixverseCookies() {
  let removed = 0;
  let found = 0;
  try {
    // Try every reasonable selector. chrome.cookies.getAll requires
    // host_permissions for the matched URL/domain; the manifest grants
    // *.pixverse.ai so all of these should resolve.
    const sets = await Promise.all([
      chrome.cookies.getAll({ domain: "pixverse.ai" }),
      chrome.cookies.getAll({ domain: "app.pixverse.ai" }),
      chrome.cookies.getAll({ domain: ".pixverse.ai" }),
      chrome.cookies.getAll({ url: "https://app.pixverse.ai/" }),
      chrome.cookies.getAll({ url: "https://pixverse.ai/" }),
    ]);
    const seen = new Set();
    const all = [];
    for (const list of sets) {
      for (const c of list || []) {
        const key = `${c.domain}|${c.path}|${c.name}|${c.partitionKey?.topLevelSite || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(c);
      }
    }
    found = all.length;
    for (const c of all) {
      const url = `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`;
      try {
        const removeOpts = { url, name: c.name, storeId: c.storeId };
        if (c.partitionKey) removeOpts.partitionKey = c.partitionKey;
        await chrome.cookies.remove(removeOpts);
        removed++;
      } catch (e) { /* keep going */ }
    }
  } catch (e) {
    log(`cookie clear error: ${e.message}`);
  }
  log(`Cookies: found=${found}, removed=${removed}`);
}

// Clears localStorage / sessionStorage / IndexedDB / Cache Storage and
// unregisters all service workers on every open pixverse tab.
// Cookie-only logout is not enough because PixVerse keeps its JWT in
// web storage too. We use an async function so we can actually wait for
// IndexedDB.databases() to settle before returning.
async function clearPixverseWebStorage() {
  const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" });
  if (!tabs.length) {
    log("Web storage clear: no pixverse tab found yet");
    return;
  }

  const totals = { ls: 0, ss: 0, idb: 0, sw: 0, caches: 0 };

  for (const t of tabs) {
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        // Async function -> executeScript awaits the returned Promise.
        func: async () => {
          const out = { ls: 0, ss: 0, idb: 0, sw: 0, caches: 0, errors: [] };
          try {
            out.ls = localStorage.length;
            localStorage.clear();
          } catch (e) { out.errors.push("ls:" + e.message); }
          try {
            out.ss = sessionStorage.length;
            sessionStorage.clear();
          } catch (e) { out.errors.push("ss:" + e.message); }
          try {
            if (typeof indexedDB.databases === "function") {
              const dbs = await indexedDB.databases();
              out.idb = dbs.length;
              await Promise.all((dbs || []).map((db) =>
                new Promise((resolve) => {
                  try {
                    const req = indexedDB.deleteDatabase(db.name);
                    req.onsuccess = req.onerror = req.onblocked = () => resolve();
                  } catch (_) { resolve(); }
                })
              ));
            }
          } catch (e) { out.errors.push("idb:" + e.message); }
          try {
            if (navigator.serviceWorker) {
              const regs = await navigator.serviceWorker.getRegistrations();
              for (const r of regs || []) {
                try { await r.unregister(); out.sw++; } catch (_) {}
              }
            }
          } catch (e) { out.errors.push("sw:" + e.message); }
          try {
            if (self.caches && caches.keys) {
              const ks = await caches.keys();
              out.caches = ks.length;
              await Promise.all(ks.map((k) => caches.delete(k).catch(() => {})));
            }
          } catch (e) { out.errors.push("caches:" + e.message); }
          return out;
        },
      });
    } catch (e) {
      log(`scripting on tab ${t.id} (${t.url}) failed: ${e.message}`);
      continue;
    }
    const r = (results && results[0] && results[0].result) || {};
    totals.ls += r.ls || 0;
    totals.ss += r.ss || 0;
    totals.idb += r.idb || 0;
    totals.sw += r.sw || 0;
    totals.caches += r.caches || 0;
    if (r.errors && r.errors.length) {
      log(`web storage tab ${t.id} partial errors: ${r.errors.join(" | ")}`);
    }
  }
  log(`Web storage cleared: ls=${totals.ls} ss=${totals.ss} idb=${totals.idb} sw=${totals.sw} caches=${totals.caches}`);
}

// Wait for a tab's loading status to reach 'complete'.
async function waitForTabComplete(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return tab;
    } catch (e) { return null; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// Self-contained UI-logout function that runs inside the page via
// chrome.scripting.executeScript. We inject this directly instead of
// messaging the content script to avoid the "Receiving end does not exist"
// race when the SPA is mid-navigation.
async function pageWideUiLogout() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  function findLogoutBtn() {
    const re = /^(abmelden|ausloggen|sign\s*out|log\s*out|logout|abmeldung)$/i;
    const els = document.querySelectorAll("*");
    for (const el of els) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || "").trim();
      if (!txt || txt.length > 30) continue;
      if (!re.test(txt)) continue;
      let cur = el;
      for (let i = 0; i < 5 && cur; i++) {
        const role = cur.getAttribute && cur.getAttribute("role");
        if (cur.tagName === "BUTTON" || cur.tagName === "A" ||
            role === "button" || role === "menuitem") return cur;
        cur = cur.parentElement;
      }
      return el;
    }
    return null;
  }

  function clickFull(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true,
      view: window, clientX: cx, clientY: cy, button: 0,
      pointerType: "mouse", isPrimary: true };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", opts));
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new PointerEvent("pointerenter", opts));
      el.dispatchEvent(new MouseEvent("mouseenter", opts));
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
    } catch (_) {}
    try { el.click && el.click(); } catch (_) {}
  }

  // Wait up to 10 s for SPA hydration.
  const tStart = Date.now();
  while (Date.now() - tStart < 10000) {
    const n = document.querySelectorAll(
      "button, a, [role='button'], [aria-haspopup], img"
    ).length;
    if (n > 5) break;
    await sleep(300);
  }

  // 0) Already-visible logout?
  let logoutBtn = findLogoutBtn();
  if (logoutBtn) {
    clickFull(logoutBtn);
    return { success: true, method: "direct",
      text: (logoutBtn.innerText || "").trim().slice(0, 40) };
  }

  // 1) Try every interactive element in the top-right of the viewport,
  //    prioritising those carrying aria-haspopup (Ant Design / Base UI use
  //    that for dropdown triggers).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const all = Array.from(document.querySelectorAll(
    "button, a, [role='button'], img, [aria-haspopup], [class*='avatar' i], [class*='profile' i], [class*='user' i]"
  ));
  const cands = [];
  for (const el of all) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top > vh * 0.25) continue;
    if (r.right < vw * 0.5) continue;
    if (r.width > vw * 0.5) continue;
    cands.push(el);
  }
  cands.sort((a, b) => {
    const aHas = !!(a.matches && (a.matches("[aria-haspopup]") || a.closest("[aria-haspopup]")));
    const bHas = !!(b.matches && (b.matches("[aria-haspopup]") || b.closest("[aria-haspopup]")));
    if (aHas !== bHas) return bHas ? 1 : -1;
    return b.getBoundingClientRect().right - a.getBoundingClientRect().right;
  });

  const tried = [];
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    tried.push(`${el.tagName}@${r.right | 0},${r.top | 0}`);

    clickFull(el);
    await sleep(550);

    logoutBtn = findLogoutBtn();
    if (logoutBtn) {
      clickFull(logoutBtn);
      return { success: true, method: "menu",
        text: (logoutBtn.innerText || "").trim().slice(0, 40),
        triggerTag: el.tagName };
    }
    try {
      document.body.dispatchEvent(new KeyboardEvent("keydown",
        { key: "Escape", code: "Escape", bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent("keyup",
        { key: "Escape", code: "Escape", bubbles: true }));
    } catch (_) {}
    await sleep(150);
  }

  return { success: false, reason: "no logout button found",
    triedCount: tried.length, tried: tried.slice(0, 12) };
}

// Try to log the user out via the SPA's own profile-menu -> Abmelden flow.
// Injects pageWideUiLogout via chrome.scripting.executeScript so it works
// regardless of the content script's state. Returns true if the click chain
// actually succeeded.
async function tryUiLogout() {
  const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" });
  if (!tabs.length) {
    log("UI logout: no pixverse tab open");
    return false;
  }
  for (const t of tabs) {
    if (/\/(register|verify|login)/.test(t.url || "")) {
      log(`UI logout: tab ${t.id} on auth page (${t.url}), skipping`);
      continue;
    }
    const ready = await waitForTabComplete(t.id, 7000);
    if (!ready) {
      log(`UI logout: tab ${t.id} not 'complete' in time`);
      continue;
    }
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: pageWideUiLogout,
      });
      const r = (results && results[0] && results[0].result) || {};
      if (r.success) {
        log(`UI logout: success on tab ${t.id} - clicked "${r.text}" (method=${r.method}, trigger=${r.triggerTag || "n/a"})`);
        await new Promise((res) => setTimeout(res, 2500));
        return true;
      } else {
        log(`UI logout: failed on tab ${t.id} - ${r.reason || "unknown"}, tried=${r.triedCount || 0}: ${(r.tried || []).join(",")}`);
      }
    } catch (e) {
      log(`UI logout: scripting on tab ${t.id} failed: ${e.message}`);
    }
  }
  return false;
}

// Wipe all auth surfaces, then navigate (or open) a tab to /register so the
// SPA reboots completely and lands on the registration form.
async function forceLogoutAndOpenRegister() {
  // 1) Try the in-app logout button first - it's the most reliable way
  //    because the SPA's own logout code clears whatever it set.
  const uiOk = await tryUiLogout();

  // 2) Belt-and-braces: even after a successful UI logout we still wipe
  //    web storage + cookies. If the UI click failed entirely (e.g. user
  //    was already on /register), this is the only line of defence.
  await clearPixverseWebStorage();
  await clearPixverseCookies();

  // 3) Hop to about:blank first to evict any cached SPA state, then to
  //    /register. tabs.update doesn't always force a fresh load if the
  //    target URL is the same origin and the SPA intercepts navigation,
  //    so the about:blank detour guarantees a real page reload.
  const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: "about:blank", active: true });
  } else {
    await chrome.tabs.update(tab.id, { url: "about:blank", active: true });
  }
  await new Promise((r) => setTimeout(r, 700));

  await chrome.tabs.update(tab.id, { url: "https://app.pixverse.ai/register" });
  // Wait for navigation + content script (re-)injection to settle.
  await new Promise((r) => setTimeout(r, 2800));
  log(`forceLogoutAndOpenRegister done (uiLogout=${uiOk ? "ok" : "skipped"})`);
  return tab;
}

async function prepareNextRun() {
  const s = await getState();
  if (!s[STATE_KEYS.RUN_ACTIVE]) {
    log("Run was stopped externally, not starting next iteration");
    return;
  }
  // Drop per-iteration state. The repeat counters stay intact. startRun
  // itself will call forceLogoutAndOpenRegister so we don't repeat it here.
  await chrome.storage.local.remove([
    STATE_KEYS.ACCOUNT,
    STATE_KEYS.MAIL_TOKEN,
    "pv_verification",
  ]);
  await startRun({ keepCounters: true });
}

// -----------------------------------------------------------------------------
// Inbox polling driven by chrome.alarms
// -----------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Wakes up to start the next iteration after the cool-down between runs.
  // We use chrome.alarms here instead of setTimeout because the service
  // worker is allowed to go idle after ~30s of inactivity, and setTimeout
  // does NOT survive that. Alarms re-wake the SW reliably.
  if (alarm.name === "pv-next-iteration") {
    const state = await getState();
    if (!state[STATE_KEYS.RUN_ACTIVE]) {
      log("alarm pv-next-iteration: run no longer active, ignoring");
      return;
    }
    log("alarm pv-next-iteration: waking up for next iteration");
    await prepareNextRun();
    return;
  }
  if (alarm.name !== "pv-inbox-poll") return;
  const state = await getState();
  if (!state[STATE_KEYS.RUN_ACTIVE]) return;
  const token = state[STATE_KEYS.MAIL_TOKEN];
  if (!token) return;

  try {
    const messages = await mailTmListMessages(token);
    if (!messages.length) return;

    // Pick the first message that looks like a verification email.
    let chosen = messages[0];
    for (const m of messages) {
      const subj = (m.subject || "").toLowerCase();
      if (/(pixverse|verify|verification|confirm|code)/.test(subj)) {
        chosen = m;
        break;
      }
    }

    const detail = await mailTmGetMessage(token, chosen.id);
    const extracted = extractVerificationFromMessage(detail);
    log(`Mail received: subject="${extracted.subject}" code=${extracted.code} link=${extracted.link ? "yes" : "no"}`);

    if (!extracted.code && !extracted.link) {
      // Probably some non-verification email; ignore.
      return;
    }

    await chrome.storage.local.set({ pv_verification: extracted });
    await chrome.alarms.clear("pv-inbox-poll");
    await setStatus("verification-received");

    // Forward to content script of the pixverse tab.
    const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" });
    for (const t of tabs) {
      try {
        await chrome.tabs.sendMessage(t.id, {
          type: "PV_VERIFICATION",
          code: extracted.code,
          link: extracted.link,
        });
      } catch (e) { /* tab may not have content script */ }
    }
  } catch (e) {
    log(`poll error: ${e.message}`);
  }
});

// -----------------------------------------------------------------------------
// Message routing (popup <-> content)
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "PV_START": {
          const r = await startRun(msg.opts || {});
          sendResponse(r);
          return;
        }
        case "PV_STOP": {
          await stopRun();
          sendResponse({ ok: true });
          return;
        }
        case "PV_GET_STATE": {
          const s = await getState();
          sendResponse({ ok: true, state: s });
          return;
        }
        case "PV_CONTENT_LOG": {
          await log(`[content] ${msg.line}`);
          sendResponse({ ok: true });
          return;
        }
        case "PV_CONTENT_STATUS": {
          await setStatus(msg.status);
          sendResponse({ ok: true });
          return;
        }
        case "PV_REQUEST_ACCOUNT": {
          const s = await getState();
          sendResponse({ ok: true, account: s[STATE_KEYS.ACCOUNT] || null });
          return;
        }
        case "PV_FORCE_POLL_NOW": {
          // For debugging from popup
          chrome.alarms.create("pv-inbox-poll", { when: Date.now() + 100 });
          sendResponse({ ok: true });
          return;
        }
        case "PV_REWARD_COMPLETED": {
          // Sent by content.js once the referral submit succeeded. Decide
          // whether another iteration is needed.
          const s = await getState();
          const total = s[STATE_KEYS.REPEAT_TOTAL] || 1;
          const done = (s[STATE_KEYS.REPEAT_DONE] || 0) + 1;
          await chrome.storage.local.set({ [STATE_KEYS.REPEAT_DONE]: done });
          log(`Iteration ${done}/${total} complete`);
          sendResponse({ ok: true, done, total });

          if (done < total) {
            // Pause between iterations. mail.tm rate-limits new accounts at
            // roughly 1 per ~30-60s per IP; if we go faster we hit 429 and
            // have to back off anyway. Stay safely above their threshold.
            const delaySec = 35 + Math.floor(Math.random() * 10); // 35-45s
            log(`Next iteration in ${delaySec}s ...`);
            // chrome.alarms wakes the service worker even if it went idle.
            // setTimeout would silently die after ~30s of SW inactivity.
            await chrome.alarms.clear("pv-next-iteration");
            await chrome.alarms.create("pv-next-iteration", {
              when: Date.now() + delaySec * 1000,
            });
          } else {
            log("All iterations done. Stopping.");
            await stopRun();
          }
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep channel open for async sendResponse
});

// On extension load: clean run state so we don't immediately poll a stale token.
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ [STATE_KEYS.RUN_ACTIVE]: false });
  await setStatus("idle");
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({ [STATE_KEYS.RUN_ACTIVE]: false });
});
