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
  GEN_ACTIVE: "pv_gen_active",
  GEN_QUEUE: "pv_gen_queue",        // [{ prompt, imageDataUri }]
  GEN_DONE: "pv_gen_done",          // count
  GEN_TOTAL: "pv_gen_total",        // count
  GEN_PER_ACCOUNT: "pv_gen_per_account",
};

// Per-generation cost (PixVerse V6 image-to-video at the listed quality).
const PV_GENERATION_COST = 60;

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
// Account history helpers
// -----------------------------------------------------------------------------
async function getAccountsHistory() {
  const s = await chrome.storage.local.get("pv_accounts_history");
  return Array.isArray(s.pv_accounts_history) ? s.pv_accounts_history : [];
}

async function updateAccountInHistory(email, patch) {
  const list = await getAccountsHistory();
  const idx = list.findIndex((a) => (a.email || "").toLowerCase() === (email || "").toLowerCase());
  if (idx < 0) return false;
  list[idx] = { ...list[idx], ...patch, lastChecked: new Date().toISOString() };
  await chrome.storage.local.set({ pv_accounts_history: list });
  return true;
}

// Pick an account from history that has at least `minCredits` credits. If the
// credit count is unknown (older entry without credits field), we treat it as
// "probably enough" only if we have never tracked it - it'll get re-checked
// on login. Returns null if nothing fits.
async function pickAccountWithCredits(minCredits) {
  const list = await getAccountsHistory();
  // Prefer accounts with KNOWN credits >= min.
  const known = list.filter((a) => typeof a.credits === "number");
  const ok = known.filter((a) => a.credits >= minCredits);
  if (ok.length) {
    // Most recent matching first.
    ok.sort((a, b) => (b.lastChecked || b.createdAt || "").localeCompare(a.lastChecked || a.createdAt || ""));
    return ok[0];
  }
  // Fall back: never-checked entries (treat optimistically). Newest first.
  const unchecked = list.filter((a) => typeof a.credits !== "number");
  unchecked.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return unchecked[0] || null;
}

// -----------------------------------------------------------------------------
// Login + credits read (executeScript, page-side)
// -----------------------------------------------------------------------------

// Runs in the page. Fills email + password and clicks the submit button on
// /login. Returns { ok: true } once the click is dispatched, or
// { ok: false, reason } on failure.
async function pageWideLoginFill({ email, password }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setReact = (el, value) => {
    const proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };

  // Wait up to 15s for the login form to render.
  const start = Date.now();
  let inputs = [];
  while (Date.now() - start < 15000) {
    inputs = Array.from(document.querySelectorAll("input")).filter((i) => {
      const t = (i.type || "text").toLowerCase();
      return ["text", "email", "password"].includes(t) && isVisible(i);
    });
    if (inputs.length >= 2) break;
    await sleep(300);
  }
  if (inputs.length < 2) return { ok: false, reason: "login form not found (need 2 inputs)" };

  // Heuristic: first text/email input = email, the password input = password.
  let emailInp = inputs.find((i) => /email|mail/i.test(i.name + " " + i.id + " " + (i.placeholder || "")))
              || inputs.find((i) => i.type === "email")
              || inputs.find((i) => i.type !== "password")
              || inputs[0];
  let passInp = inputs.find((i) => i.type === "password")
              || inputs.find((i) => /pass/i.test(i.name + " " + i.id + " " + (i.placeholder || "")))
              || inputs[1];

  emailInp.focus(); setReact(emailInp, email); emailInp.blur();
  await sleep(150);
  passInp.focus(); setReact(passInp, password); passInp.blur();
  await sleep(400);

  // Find submit button: text Continue/Weiter/Anmelden/Einloggen/Sign in/Log in.
  const submit = Array.from(document.querySelectorAll("button"))
    .find((b) =>
      /^(continue|weiter|anmelden|einloggen|sign\s*in|log\s*in)$/i
        .test((b.innerText || b.textContent || "").trim()) && isVisible(b)
    );
  if (!submit) return { ok: false, reason: "no login submit button found" };
  if (submit.disabled) return { ok: false, reason: "submit button disabled (turnstile not solved?)" };
  submit.click();
  return { ok: true };
}

// Runs in the page. Tries to find the user-credits number near the top-right
// avatar/badge. PixVerse renders something like "190" next to a lightning
// icon. We pick the smallest visible numeric token in the top 80px that
// looks like 1-5 digits.
function pageReadCredits() {
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }
  const cands = [];
  const all = document.querySelectorAll("span, div, p, a, button, b, strong");
  for (const el of all) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top > 80) continue;        // top navbar only
    if (r.right < window.innerWidth * 0.4) continue; // right half-ish
    const txt = (el.innerText || el.textContent || "").trim();
    if (!/^\d{1,5}$/.test(txt)) continue;
    const n = parseInt(txt, 10);
    if (n < 0 || n > 99999) continue;
    cands.push({ el, n, r });
  }
  if (!cands.length) return { ok: false, reason: "no credit-like number in navbar" };
  // Prefer the smallest top-coordinate, then leftmost (the one nearest the
  // lightning icon). Most layouts put credits as a single number.
  cands.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  return { ok: true, credits: cands[0].n };
}

// Navigates the active pixverse tab to /login, fills the form, submits, and
// then reads the credits once the dashboard loads. Updates pv_accounts_history.
async function loginToAccount(account) {
  log(`Logging in as ${account.email}`);
  const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://app.pixverse.ai/login", active: true });
  } else {
    await chrome.tabs.update(tab.id, { url: "https://app.pixverse.ai/login", active: true });
  }
  await waitForTabComplete(tab.id, 10000);
  await new Promise((r) => setTimeout(r, 1500));

  let res;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [{ email: account.email, password: account.password }],
      func: pageWideLoginFill,
    });
    res = (out && out[0] && out[0].result) || { ok: false };
  } catch (e) {
    log(`login executeScript failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
  if (!res.ok) {
    log(`login fill failed: ${res.reason || "unknown"}`);
    return { ok: false, error: res.reason };
  }
  log(`login form submitted, waiting for dashboard...`);

  // Wait for navigation away from /login.
  const start = Date.now();
  while (Date.now() - start < 25000) {
    await new Promise((r) => setTimeout(r, 500));
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (t && t.url && !/\/login/.test(t.url)) break;
  }
  await waitForTabComplete(tab.id, 8000);
  await new Promise((r) => setTimeout(r, 1500));

  // Read credits.
  let credits = null;
  try {
    const out = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageReadCredits,
    });
    const r = (out && out[0] && out[0].result) || {};
    if (r.ok) credits = r.credits;
    else log(`credits read: ${r.reason || "unknown"}`);
  } catch (e) {
    log(`credits read failed: ${e.message}`);
  }

  if (credits != null) {
    log(`Login OK, credits=${credits}`);
    await updateAccountInHistory(account.email, { credits });
  } else {
    log(`Login OK, credits unknown`);
  }
  return { ok: true, tab, credits };
}

// =============================================================================
// Phase 2 - Page-side generation flow
// =============================================================================
//
// The actual UI automation that triggers ONE PixVerse video generation. Runs
// inside the page via chrome.scripting.executeScript (NOT via content-script
// messaging - we want a single deterministic round-trip per item, no
// race-conditions with SPA navigation).
//
// Steps (top of the function, in order):
//   1) If a "Bild" / "Image" tab exists, click it (the form is tab-gated on
//      some PixVerse builds). No-op if already selected (PixVerse uses
//      data-active="" attribute presence + aria-selected="true").
//   2) Locate the prompt textarea by placeholder regex /beschreib/i (matches
//      the German placeholder "Beschreiben Sie den Inhalt, ..."). Fallback:
//      first visible textarea.
//   3) Locate a file input that accepts images (input[type=file] with no
//      `accept` or `accept` containing "image"/"*"). Inject the supplied
//      data-URI as a real File via DataTransfer + change event - we never
//      click the open-dialog button.
//   4) Wait ~2.5s for the upload preview to render.
//   5) Fill the prompt via the React-friendly setter (native value setter
//      + bubbling input/change events).
//   6) Settings:
//        Audio toggle  -> ON
//        Multi-Aufnahme/Multi-shot toggle -> OFF
//        Modell dropdown -> "PixVerse V6"
//        Anzahl number stepper -> 1
//      All located via DOM-distance to the matching label, never by class.
//   7) Click "Erstellen"/"Create"/"Generate" with the full pointer/mouse
//      sequence (same pattern claimReferralReward uses for the referral
//      submit button).
//   8) Soft-confirm: sleep 5.5s and check whether the create button became
//      disabled / its text changed / a generating-spinner appeared. We do
//      NOT wait for the video to finish - that takes minutes. 5-10s is
//      enough to know the request was accepted.
//
// Returns { ok, reason?, startedAt?, confirmed?, audio?, multi?, model? }.
async function pageWideRunGeneration({ prompt, imageName, imageDataUri }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };

  const setReact = (el, value) => {
    const proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const clickFull = (el) => {
    if (!el) return false;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, button: 0, buttons: 1,
      pointerType: "mouse", isPrimary: true,
    };
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
    return true;
  };

  // Find the smallest (deepest) visible element whose own text matches.
  const findDeepestLabel = (re) => {
    const cands = document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,div,span,label,p,a,strong,em,b"
    );
    let best = null, bestLen = Infinity;
    for (const el of cands) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || "").trim();
      if (!txt || txt.length > 200) continue;
      if (!re.test(txt)) continue;
      if (txt.length < bestLen) { bestLen = txt.length; best = el; }
    }
    return best;
  };

  const findClickableByText = (re) => {
    const list = document.querySelectorAll(
      "button, a, [role='button'], [role='tab'], [role='option'], [role='menuitem']"
    );
    for (const el of list) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || "").trim();
      if (re.test(txt)) return el;
    }
    return null;
  };

  // Pick the clickable matching clickRe with smallest DOM-distance to the
  // deepest label matching labelRe. Mirrors content.js#findClickableNearLabel.
  const findClickableNearLabel = (labelRe, clickRe, extraSel) => {
    const label = findDeepestLabel(labelRe);
    if (!label) return null;
    const sel = extraSel
      || "button, a, [role='button'], [role='switch'], [role='tab'], [role='option']";
    const cands = Array.from(document.querySelectorAll(sel)).filter((b) =>
      isVisible(b) && clickRe.test((b.innerText || b.textContent || "").trim())
    );
    if (!cands.length) return null;
    const ancestors = new Map();
    let d = 0;
    for (let n = label; n; n = n.parentElement) { ancestors.set(n, d++); }
    let best = null, bestDist = Infinity;
    for (const btn of cands) {
      let n = btn, bd = 0;
      while (n && !ancestors.has(n)) { n = n.parentElement; bd++; }
      if (!n) continue;
      const total = bd + ancestors.get(n);
      if (total < bestDist) { bestDist = total; best = btn; }
    }
    return best;
  };

  // Find a toggle-switch closest in DOM-distance to a label matching labelRe.
  // Includes role=switch, [data-state=checked|unchecked], and class-name
  // heuristics ("switch"/"toggle") - empty-text elements are fine here so
  // we match by selector, not by inner text.
  const findToggleNearLabel = (labelRe) => {
    const label = findDeepestLabel(labelRe);
    if (!label) return null;
    const cands = Array.from(document.querySelectorAll(
      "[role='switch'], button[role='switch'], [data-state='checked'], [data-state='unchecked'], [class*='switch' i], [class*='toggle' i]"
    )).filter(isVisible);
    if (!cands.length) return null;
    const ancestors = new Map();
    let d = 0;
    for (let n = label; n; n = n.parentElement) { ancestors.set(n, d++); }
    let best = null, bestDist = Infinity;
    for (const btn of cands) {
      let n = btn, bd = 0;
      while (n && !ancestors.has(n)) { n = n.parentElement; bd++; }
      if (!n) continue;
      const total = bd + ancestors.get(n);
      if (total < bestDist) { bestDist = total; best = btn; }
    }
    return best;
  };

  const toggleState = (el) => {
    if (!el) return null;
    const ac = el.getAttribute("aria-checked");
    if (ac === "true") return true;
    if (ac === "false") return false;
    const ap = el.getAttribute("aria-pressed");
    if (ap === "true") return true;
    if (ap === "false") return false;
    const ds = el.dataset && (el.dataset.state || el.dataset.checked);
    if (ds === "checked" || ds === "on" || ds === "true") return true;
    if (ds === "unchecked" || ds === "off" || ds === "false") return false;
    const cls = ((el.className || "") + "").toLowerCase();
    if (/(^|[\s_-])(checked|active|on|enabled|is-on)([\s_-]|$)/.test(cls)) return true;
    return false;
  };

  const setToggle = async (labelRe, want) => {
    const t = findToggleNearLabel(labelRe);
    if (!t) return { ok: false, reason: "toggle not found" };
    const cur = toggleState(t);
    if (cur === want) return { ok: true, was: cur, clicked: false };
    clickFull(t);
    await sleep(350);
    return { ok: true, was: cur, clicked: true };
  };

  const dataUriToFile = (uri, name) => {
    const m = (uri || "").match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
    if (!m) throw new Error("not a data URI");
    const mime = m[1] || "image/png";
    const b64 = m[2];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    let safe = name || "upload";
    if (!/\.[a-z0-9]{2,5}$/i.test(safe)) {
      const ext = (mime.split("/")[1] || "png").split("+")[0];
      safe = safe + "." + ext;
    }
    return new File([arr], safe, { type: mime });
  };

  const waitFor = async (fn, timeoutMs, intervalMs) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { const v = fn(); if (v) return v; } catch (_) {}
      await sleep(intervalMs);
    }
    return null;
  };

  // ---------------------------------------------------------------------------
  // 1) Click "Bild" / "Image" tab if present and not already selected.
  // ---------------------------------------------------------------------------
  try {
    const bildTab = await waitFor(() => {
      const cands = Array.from(document.querySelectorAll(
        "[role='tab'], button, a, div, span"
      )).filter((el) => {
        if (!isVisible(el)) return false;
        const t = (el.innerText || "").trim();
        return /^(bild|image|foto)$/i.test(t) && t.length <= 10;
      });
      return cands[0] || null;
    }, 4000, 250);
    if (bildTab) {
      const sel = bildTab.getAttribute("aria-selected");
      // PixVerse uses data-active="" (attribute presence) for active tabs.
      const hasDataActive = bildTab.hasAttribute("data-active");
      const ds  = bildTab.dataset && (bildTab.dataset.state || "");
      const cls = ((bildTab.className || "") + "").toLowerCase();
      const alreadyActive = sel === "true" || hasDataActive ||
        ds === "active" || /\bactive\b|\bselected\b/.test(cls);
      if (!alreadyActive) {
        clickFull(bildTab);
        await sleep(700);
      }
    }
  } catch (_) { /* tab is optional */ }

  // ---------------------------------------------------------------------------
  // 2) Prompt textarea.
  // ---------------------------------------------------------------------------
  const promptEl = await waitFor(() => {
    const tas = Array.from(document.querySelectorAll("textarea")).filter(isVisible);
    for (const ta of tas) {
      const sig = (ta.placeholder || "") + " "
                + (ta.getAttribute("aria-label") || "") + " "
                + (ta.name || "");
      if (/beschreib|describe/i.test(sig)) return ta;
    }
    // Fallback: a single visible textarea is almost certainly the prompt.
    if (tas.length === 1) return tas[0];
    return null;
  }, 15000, 300);
  if (!promptEl) return { ok: false, reason: "prompt textarea not found" };

  // ---------------------------------------------------------------------------
  // 3) File input.
  // ---------------------------------------------------------------------------
  const fileInput = await waitFor(() => {
    const inputs = Array.from(document.querySelectorAll("input[type='file']"));
    if (!inputs.length) return null;
    // Prefer one whose accept attribute mentions image (or is empty/star).
    for (const i of inputs) {
      const acc = (i.getAttribute("accept") || "").toLowerCase();
      if (!acc || acc.includes("image") || acc.includes("*")) return i;
    }
    return inputs[0];
  }, 15000, 300);
  if (!fileInput) return { ok: false, reason: "file input not found" };

  // ---------------------------------------------------------------------------
  // 4) Inject the file via DataTransfer.
  // ---------------------------------------------------------------------------
  let file;
  try { file = dataUriToFile(imageDataUri, imageName); }
  catch (e) { return { ok: false, reason: "data URI decode failed: " + e.message }; }

  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    // React's onChange listens on the bubbling change event.
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    return { ok: false, reason: "file injection failed: " + e.message };
  }

  // 5) Give the upload preview time to render.
  await sleep(2500);

  // ---------------------------------------------------------------------------
  // 6) Fill prompt.
  // ---------------------------------------------------------------------------
  promptEl.focus();
  setReact(promptEl, prompt || "");
  promptEl.blur();
  await sleep(400);

  // ---------------------------------------------------------------------------
  // 7) Settings.
  // ---------------------------------------------------------------------------
  const audioRes = await setToggle(/^\s*audio\s*$/i, true);
  const multiRes = await setToggle(
    /^\s*multi[- ]?aufnahme\s*$|multi[- ]?shot|multi[- ]?take/i, false
  );

  // Modell dropdown.
  let modelRes;
  try {
    let trigger = findClickableNearLabel(
      /^\s*modell\s*$|^\s*model\s*$/i,
      /pixverse\s*v\s*\d/i,
      "button, a, [role='button'], [role='combobox'], [aria-haspopup], div, span"
    );
    if (!trigger) trigger = findClickableByText(/^pixverse\s*v\s*\d/i);
    if (trigger) {
      const cur = (trigger.innerText || "").trim();
      if (/pixverse\s*v\s*6/i.test(cur)) {
        modelRes = { ok: true, alreadyV6: true };
      } else {
        clickFull(trigger);
        await sleep(700);
        const opt = findClickableByText(/^pixverse\s*v\s*6\b/i)
                 || findClickableByText(/\bpixverse\s*v\s*6\b/i);
        if (opt) {
          clickFull(opt);
          await sleep(400);
          modelRes = { ok: true, switched: true };
        } else {
          // Close any open menu.
          document.body.dispatchEvent(new KeyboardEvent("keydown",
            { key: "Escape", code: "Escape", bubbles: true }));
          await sleep(150);
          modelRes = { ok: false, reason: "v6 option not found" };
        }
      }
    } else {
      modelRes = { ok: false, reason: "model trigger not found" };
    }
  } catch (e) { modelRes = { ok: false, reason: "model error: " + e.message }; }

  // Anzahl = 1. Best-effort: a number input near a label "Anzahl"/"Quantity".
  try {
    const numLabel = findDeepestLabel(/^anzahl|^quantity|number of/i);
    if (numLabel) {
      let cur = numLabel;
      let inp = null;
      for (let i = 0; i < 5 && cur; i++) {
        const cands = cur.querySelectorAll(
          "input[type='number'], input[inputmode='numeric'], input[role='spinbutton']"
        );
        for (const c of cands) { if (isVisible(c)) { inp = c; break; } }
        if (inp) break;
        cur = cur.parentElement;
      }
      if (inp && (inp.value || "").trim() !== "1") {
        inp.focus();
        setReact(inp, "1");
        inp.blur();
        await sleep(200);
      }
    }
  } catch (_) { /* non-fatal */ }

  // ---------------------------------------------------------------------------
  // 8) Click "Erstellen". Wait up to 12s for it to be enabled (upload may
  //    still be processing on the server side).
  // ---------------------------------------------------------------------------
  const createRe = /^\s*(erstellen|create|generate|generieren)\s*$/i;
  const createBtn = await waitFor(() => {
    const list = Array.from(document.querySelectorAll("button, [role='button']"));
    for (const b of list) {
      if (!isVisible(b)) continue;
      const t = (b.innerText || b.textContent || "").trim();
      if (!createRe.test(t)) continue;
      if (b.disabled) continue;
      if (b.getAttribute("aria-disabled") === "true") continue;
      const cls = ((b.className || "") + "").toLowerCase();
      if (cls.includes("cursor-not-allowed")) continue;
      if (cls.includes("disabled") && !cls.includes("not-disabled")) continue;
      return b;
    }
    return null;
  }, 12000, 400);
  if (!createBtn) {
    return {
      ok: false, reason: "Erstellen button not enabled in time",
      audio: audioRes, multi: multiRes, model: modelRes,
    };
  }

  clickFull(createBtn);
  const startedAt = new Date().toISOString();

  // ---------------------------------------------------------------------------
  // 9) Soft-confirm the click took effect. We don't wait for the video to
  //    finish - that takes minutes. 5.5s is enough to observe the transition
  //    to "generating" / disabled / spinner.
  // ---------------------------------------------------------------------------
  await sleep(5500);
  let confirmed = false;
  try {
    const stillEnabled = !createBtn.disabled
      && createBtn.getAttribute("aria-disabled") !== "true";
    const txt = (createBtn.innerText || "").trim();
    if (!stillEnabled || /generat|wird erstellt|läuft|warten/i.test(txt)) confirmed = true;
    if (!confirmed) {
      const newVid = document.querySelector(
        "video, [class*='loading' i], [class*='generating' i], [class*='processing' i], [class*='progress' i]"
      );
      if (newVid && isVisible(newVid)) confirmed = true;
    }
  } catch (_) {}

  return {
    ok: true,
    startedAt,
    confirmed,
    audio: audioRes,
    multi: multiRes,
    model: modelRes,
  };
}

// Wrapper that ensures the tab is on a creation page, then injects
// pageWideRunGeneration. Tries "/" first (home page hosts the form on most
// PixVerse builds); if the page-side function reports "prompt textarea not
// found" or "file input not found", retries once on /creation/video.
async function runGenerationInTab(tab, item) {
  const inject = async () => {
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [{
          prompt: item.prompt,
          imageName: item.imageName,
          imageDataUri: item.imageDataUri,
        }],
        func: pageWideRunGeneration,
      });
      return (out && out[0] && out[0].result) || { ok: false, reason: "no result" };
    } catch (e) {
      return { ok: false, reason: "executeScript: " + e.message };
    }
  };

  // The generation form lives on "/" (home/Startseite). /creation/video is
  // the gallery (filter tabs Video/Bild/Mini-App/Gespeichert), confirmed
  // from a sample of the page DOM, NOT the form. So we always navigate to
  // "/" before injecting; we only skip the navigation if we're already
  // there to avoid an unnecessary SPA reload.
  let curPath = "";
  try {
    const cur = await chrome.tabs.get(tab.id);
    curPath = new URL(cur.url).pathname;
  } catch (_) {}

  if (curPath !== "/") {
    await chrome.tabs.update(tab.id, { url: "https://app.pixverse.ai/" });
    await waitForTabComplete(tab.id, 12000);
    await new Promise((r) => setTimeout(r, 2000));
  }

  return await inject();
}

// -----------------------------------------------------------------------------
// Generations queue runner
// -----------------------------------------------------------------------------
async function startGenerationsBatch(opts) {
  const items = Array.isArray(opts.items) ? opts.items : [];
  if (!items.length) {
    log("Generations: empty queue");
    return { ok: false, error: "no items" };
  }
  const perAccount = Math.max(1, parseInt(opts.perAccount, 10) || 3);
  await chrome.storage.local.set({
    [STATE_KEYS.GEN_ACTIVE]: true,
    [STATE_KEYS.GEN_QUEUE]: items,
    [STATE_KEYS.GEN_DONE]: 0,
    [STATE_KEYS.GEN_TOTAL]: items.length,
    [STATE_KEYS.GEN_PER_ACCOUNT]: perAccount,
    [STATE_KEYS.LAST_LOG]: [],
  });
  log(`Generations queued: ${items.length} items, ${perAccount} per account`);
  // Kick off the first step.
  await chrome.alarms.clear("pv-generations-step");
  await chrome.alarms.create("pv-generations-step", { when: Date.now() + 100 });
  return { ok: true, total: items.length };
}

async function stopGenerations() {
  await chrome.alarms.clear("pv-generations-step");
  await chrome.storage.local.set({ [STATE_KEYS.GEN_ACTIVE]: false });
  await setStatus("idle");
  log("Generations stopped");
}

// One step of the generation loop. Picks/logs in to an account, ensures it has
// >= 180 credits (or whatever perAccount * cost requires), runs up to N
// generations, logs out, schedules next step. The actual generation trigger
// is a stub for now (Phase 2). For Phase 1 we just verify login + credits +
// per-account loop control.
async function generationsStep() {
  const s = await getState();
  if (!s[STATE_KEYS.GEN_ACTIVE]) {
    log("alarm pv-generations-step: gen not active, ignoring");
    return;
  }
  const queue = Array.isArray(s[STATE_KEYS.GEN_QUEUE]) ? s[STATE_KEYS.GEN_QUEUE] : [];
  const perAccount = s[STATE_KEYS.GEN_PER_ACCOUNT] || 3;
  if (!queue.length) {
    log("Generations: queue empty, all done");
    await stopGenerations();
    return;
  }
  await setStatus("picking-account");

  const need = perAccount * PV_GENERATION_COST;
  let acc = await pickAccountWithCredits(need);

  if (!acc) {
    log(`No history account has >= ${need} credits. Creating new one...`);
    // Create a brand-new account via the existing register flow. After the
    // referral claim completes, control comes back here automatically because
    // PV_REWARD_COMPLETED schedules pv-next-iteration; but here we want the
    // generations loop to resume. So we run a 1-iteration register/claim
    // synchronously, then re-query.
    await setStatus("creating-mailbox");
    const r = await startRun({ repeatTotal: 1 });
    if (!r.ok) {
      log(`Could not create new account: ${r.error}`);
      await stopGenerations();
      return;
    }
    // The register flow runs asynchronously (mail polling, form filling, ...).
    // We resume the generations step in 90s to give it time to complete.
    log("Register flow started; resuming generations in 90s");
    await chrome.alarms.create("pv-generations-step", { when: Date.now() + 90 * 1000 });
    return;
  }

  log(`Selected account ${acc.email} (credits=${acc.credits ?? "?"})`);

  // Logout first (in case some previous session lingers).
  await setStatus("logging-out");
  await forceLogoutAndOpenRegister();

  // Login.
  await setStatus("logging-in");
  const loginRes = await loginToAccount(acc);
  if (!loginRes.ok) {
    log(`Login failed for ${acc.email}, removing-from-pool and retrying`);
    // Mark this account as 0 credits to skip it next time.
    await updateAccountInHistory(acc.email, { credits: 0, loginFailed: true });
    await chrome.alarms.create("pv-generations-step", { when: Date.now() + 5000 });
    return;
  }
  let credits = loginRes.credits ?? acc.credits ?? need;
  if (typeof credits === "number" && credits < PV_GENERATION_COST) {
    log(`Account ${acc.email} only has ${credits} credits, switching`);
    await updateAccountInHistory(acc.email, { credits });
    await chrome.alarms.create("pv-generations-step", { when: Date.now() + 2000 });
    return;
  }

  // Phase 2: real generation flow. Inject pageWideRunGeneration per item,
  // append a pv_gen_history entry on success, re-read credits from the
  // navbar after each successful trigger, and bail to the next account
  // after 2 consecutive failures (e.g. UI broke / account locked).
  await setStatus("generating");
  let did = 0, failures = 0;
  while (did < perAccount && queue.length > 0 && credits >= PV_GENERATION_COST) {
    const item = queue[0];
    const idx = (s[STATE_KEYS.GEN_DONE] || 0) + did + 1;
    const promptPreview = (item.prompt || "").slice(0, 80).replace(/\n/g, " ");
    log(`[gen] #${idx} ${acc.email} <- ${item.imageName || "<unnamed>"} | ${promptPreview}`);

    const res = await runGenerationInTab(loginRes.tab, item);
    if (!res.ok) {
      failures++;
      log(`[gen] FAIL #${idx}: ${res.reason || "unknown"} (failures=${failures})`);
      if (failures >= 2) {
        log(`[gen] too many failures on ${acc.email}, switching account`);
        break;
      }
      // Backoff and retry the SAME item (no shift, no decrement).
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }

    // Success: pop item, log to gen-history, update counters.
    queue.shift();
    did++;
    failures = 0;
    if (typeof credits === "number") credits -= PV_GENERATION_COST;

    try {
      const histStore = await chrome.storage.local.get("pv_gen_history");
      const hist = Array.isArray(histStore.pv_gen_history) ? histStore.pv_gen_history : [];
      hist.push({
        accountEmail: acc.email,
        prompt: item.prompt,
        imageName: item.imageName,
        startedAt: res.startedAt || new Date().toISOString(),
        confirmed: !!res.confirmed,
      });
      // Cap to prevent unbounded growth (Phase 3 will iterate this list).
      while (hist.length > 5000) hist.shift();
      await chrome.storage.local.set({ pv_gen_history: hist });
    } catch (e) { log(`gen-history append failed: ${e.message}`); }

    // Re-read credits from the navbar - cheap and authoritative.
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId: loginRes.tab.id },
        func: pageReadCredits,
      });
      const r = (out && out[0] && out[0].result) || {};
      if (r.ok) credits = r.credits;
    } catch (_) { /* keep estimated credits */ }

    await chrome.storage.local.set({
      [STATE_KEYS.GEN_QUEUE]: queue,
      [STATE_KEYS.GEN_DONE]: (s[STATE_KEYS.GEN_DONE] || 0) + did,
    });
    await updateAccountInHistory(acc.email, { credits });

    log(`[gen] OK #${idx} confirmed=${res.confirmed ? "yes" : "soft"} `
      + `credits=${credits} queue=${queue.length}`);

    // Small pause between generations on the same account to let the UI
    // settle (the gallery card animation, the credits-deduction tick, ...).
    await new Promise((r) => setTimeout(r, 3000));
  }

  await updateAccountInHistory(acc.email, { credits });

  // Logout and schedule next batch.
  await setStatus("logging-out");
  await tryUiLogout();
  if (queue.length === 0) {
    log("Generations: queue empty, done");
    await stopGenerations();
    return;
  }
  log(`Generations: ${did} done on this account, ${queue.length} remaining. Next batch in 30s`);
  await chrome.alarms.create("pv-generations-step", { when: Date.now() + 30 * 1000 });
}

// -----------------------------------------------------------------------------
// Inbox polling driven by chrome.alarms
// -----------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Generations queue tick.
  if (alarm.name === "pv-generations-step") {
    try { await generationsStep(); }
    catch (e) { log(`generationsStep error: ${e.message}`); }
    return;
  }
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
        case "PV_START_GENERATIONS": {
          const r = await startGenerationsBatch(msg.opts || {});
          sendResponse(r);
          return;
        }
        case "PV_STOP_GENERATIONS": {
          await stopGenerations();
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
