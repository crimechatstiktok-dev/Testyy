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
    throw new Error(`mail.tm /accounts ${createRes.status}: ${txt.slice(0, 200)}`);
  }

  const tokenRes = await mailTmFetch("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    throw new Error(`mail.tm /token ${tokenRes.status}: ${txt.slice(0, 200)}`);
  }
  const tokenData = await tokenRes.json();
  return { address, password, token: tokenData.token, id: tokenData.id, domain };
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
  await chrome.storage.local.set({ [STATE_KEYS.LAST_LOG]: [] });
  await chrome.storage.local.set({ [STATE_KEYS.RUN_ACTIVE]: true });
  await setStatus("creating-mailbox");
  log("Run started");

  let mailbox;
  try {
    mailbox = await mailTmCreateAccount(opts.preferredDomain || "wshu.net");
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

  log(`Mailbox ready: ${account.email}`);
  log(`Username: ${account.username}`);
  await setStatus("mailbox-ready");

  // Schedule periodic inbox polling.
  await chrome.alarms.clear("pv-inbox-poll");
  await chrome.alarms.create("pv-inbox-poll", { periodInMinutes: 0.1 }); // every 6s

  // Tell the active tab (or open one) to start filling the form.
  let tab = await getOrCreatePixverseRegisterTab();
  // give the content script a moment in case the tab was just created
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

async function stopRun() {
  await chrome.alarms.clear("pv-inbox-poll");
  await chrome.storage.local.set({ [STATE_KEYS.RUN_ACTIVE]: false });
  await setStatus("idle");
  log("Run stopped");
}

async function getOrCreatePixverseRegisterTab() {
  const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" });
  if (tabs.length) {
    const t = tabs[0];
    // ensure register page
    if (!/\/register/.test(t.url || "")) {
      await chrome.tabs.update(t.id, { url: "https://app.pixverse.ai/register", active: true });
    } else {
      await chrome.tabs.update(t.id, { active: true });
    }
    return t;
  }
  return await chrome.tabs.create({ url: "https://app.pixverse.ai/register", active: true });
}

// -----------------------------------------------------------------------------
// Inbox polling driven by chrome.alarms
// -----------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
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
