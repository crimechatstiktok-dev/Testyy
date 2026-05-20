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

  // Account history count.
  const hist = await chrome.storage.local.get("pv_accounts_history");
  const list = Array.isArray(hist.pv_accounts_history) ? hist.pv_accounts_history : [];
  $("f-export-count").textContent = `${list.length} Account${list.length === 1 ? "" : "s"} gespeichert`;
  $("btn-export").disabled = list.length === 0;
  $("btn-history-clear").disabled = list.length === 0;
}

function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function formatAccountsTxt(list) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const lines = [];
  lines.push("=".repeat(72));
  lines.push("PixVerse Auto-Register - Account history");
  lines.push(`Export: ${now}`);
  lines.push(`Total : ${list.length}`);
  lines.push("=".repeat(72));
  lines.push("");
  list.forEach((a, i) => {
    const idx = pad(i + 1, 4);
    const created = (a.createdAt || "").replace("T", " ").slice(0, 19);
    lines.push(`[${idx}] ${created}`);
    lines.push(`  Username     : ${a.username || ""}`);
    lines.push(`  Email        : ${a.email || ""}`);
    lines.push(`  Password     : ${a.password || ""}`);
    lines.push(`  Mail.tm Pass : ${a.mailPassword || ""}`);
    lines.push(`  Domain       : ${a.domain || ""}`);
    if (a.referral) lines.push(`  Referral     : ${a.referral}`);
    lines.push("");
  });
  return lines.join("\n");
}

async function exportAccounts() {
  const hist = await chrome.storage.local.get("pv_accounts_history");
  const list = Array.isArray(hist.pv_accounts_history) ? hist.pv_accounts_history : [];
  if (!list.length) {
    alert("Noch keine Accounts in der Historie.");
    return;
  }
  const text = formatAccountsTxt(list);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pixverse-accounts-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
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
    // Clear per-run state but PRESERVE the account history (and the user's
    // referral / repeat-count preferences) so credentials are never lost.
    const KEEP = ["pv_accounts_history", "pv_referral_code", "pv_repeat_total_pref"];
    const keep = await chrome.storage.local.get(KEEP);
    await chrome.storage.local.clear();
    await chrome.storage.local.set(keep);
    await chrome.runtime.sendMessage({ type: "PV_STOP" });
    refresh();
  });

  $("btn-export").addEventListener("click", exportAccounts);

  $("btn-history-clear").addEventListener("click", async () => {
    if (!confirm("Wirklich die komplette Account-Historie loeschen? Das kann nicht rueckgaengig gemacht werden.")) return;
    await chrome.storage.local.remove("pv_accounts_history");
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
