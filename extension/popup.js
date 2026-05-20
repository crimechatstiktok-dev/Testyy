// =============================================================================
// PixVerse Auto-Register - Popup
// =============================================================================

const $ = (id) => document.getElementById(id);

function setPill(status) {
  const pill = $("status-pill");
  pill.textContent = status || "idle";
  pill.className = "pill " + (status || "idle");
}

function fillAccount(acc) {
  $("f-user").value = acc?.username || "";
  $("f-mail").value = acc?.email || "";
  $("f-pass").value = acc?.password || "";
  $("f-mailpass").value = acc?.mailPassword || "";
  $("f-domain").value = acc?.domain || "";
}

function renderLog(lines) {
  const pre = $("log");
  pre.textContent = (lines || []).join("\n");
  pre.scrollTop = pre.scrollHeight;
}

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "PV_GET_STATE" });
  if (!r || !r.ok) return;
  const s = r.state || {};
  setPill(s.pv_status || "idle");
  fillAccount(s.pv_account || {});
  renderLog(s.pv_log || []);

  // Progress bubble: e.g. "2 / 5". When idle and no run started yet, mirror
  // the current input value as the target.
  const total = s.pv_repeat_total || parseInt($("f-repeat").value, 10) || 1;
  const done = s.pv_repeat_done || 0;
  $("f-progress").textContent = `${done} / ${total}`;
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();

  // Load stored referral code (default Q1XJSEBM).
  chrome.storage.local.get("pv_referral_code").then((s) => {
    $("f-referral").value = (s.pv_referral_code || "Q1XJSEBM").toUpperCase();
  });

  // Persist referral code on each change.
  $("f-referral").addEventListener("input", (e) => {
    const v = (e.target.value || "").trim().toUpperCase();
    e.target.value = v;
    chrome.storage.local.set({ pv_referral_code: v || "Q1XJSEBM" });
  });

  // Load stored repeat count (default 1).
  chrome.storage.local.get("pv_repeat_total_pref").then((s) => {
    $("f-repeat").value = Math.max(1, parseInt(s.pv_repeat_total_pref, 10) || 1);
  });

  // Persist repeat preference on each change.
  $("f-repeat").addEventListener("input", (e) => {
    const v = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1));
    e.target.value = v;
    chrome.storage.local.set({ pv_repeat_total_pref: v });
  });

  // Manual "Claim" trigger (sends a message to the active pixverse tab).
  $("btn-claim").addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*", active: true, currentWindow: true });
    let tab = tabs[0];
    if (!tab) {
      const all = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" });
      tab = all[0];
    }
    if (!tab) {
      alert("Kein PixVerse-Tab offen.");
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PV_CLAIM_REFERRAL_NOW" });
    } catch (e) {
      alert("Konnte den Tab nicht ansprechen: " + e.message);
    }
  });

  $("btn-start").addEventListener("click", async () => {
    $("btn-start").disabled = true;
    try {
      const repeatTotal = Math.max(1, parseInt($("f-repeat").value, 10) || 1);
      const r = await chrome.runtime.sendMessage({
        type: "PV_START",
        opts: { repeatTotal },
      });
      if (!r.ok) alert("Start fehlgeschlagen: " + r.error);
    } finally {
      $("btn-start").disabled = false;
      refresh();
    }
  });

  $("btn-stop").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "PV_STOP" });
    refresh();
  });

  $("btn-poll").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "PV_FORCE_POLL_NOW" });
    setTimeout(refresh, 500);
  });

  $("btn-clear").addEventListener("click", async () => {
    await chrome.storage.local.clear();
    await chrome.runtime.sendMessage({ type: "PV_STOP" });
    refresh();
  });

  document.querySelectorAll("button.copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = $(btn.dataset.target);
      if (!target || !target.value) return;
      await navigator.clipboard.writeText(target.value);
      const orig = btn.textContent;
      btn.textContent = "Kopiert!";
      setTimeout(() => (btn.textContent = orig), 900);
    });
  });

  // Live updates while popup is open.
  const live = setInterval(refresh, 1500);
  window.addEventListener("unload", () => clearInterval(live));

  // Listen for storage changes to update immediately.
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") refresh();
  });
});
