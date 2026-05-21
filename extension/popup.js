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

// In-popup buffer of files the user picked. Not persisted; selecting again
// replaces the buffer.
let pickedImages = []; // [{ name, dataUri }]

async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: "PV_GET_STATE" });
  if (!r || !r.ok) return;
  const s = r.state || {};
  setPill(s.pv_status || "idle");
  fillAccount(s.pv_account || {});
  renderLog(s.pv_log || []);

  // Repeat progress.
  const total = s.pv_repeat_total || parseInt($("f-repeat").value, 10) || 1;
  const done = s.pv_repeat_done || 0;
  $("f-progress").textContent = `${done} / ${total}`;

  // Generation progress.
  const gTotal = s.pv_gen_total || 0;
  const gDone = s.pv_gen_done || 0;
  $("f-gen-progress").textContent = `${gDone} / ${gTotal}`;

  // History count.
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
    if (typeof a.credits === "number") lines.push(`  Credits      : ${a.credits}`);
    if (a.lastChecked) lines.push(`  LastChecked  : ${(a.lastChecked || "").replace("T", " ").slice(0, 19)}`);
    if (a.loginFailed) lines.push(`  LoginFailed  : true`);
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

// Split a textarea full of CLIP blocks into individual prompts. Heuristic:
// split before each line that matches /^CLIP\s*\d/ (case-insensitive). Each
// chunk is the full text of one prompt, headers preserved. Empty/short chunks
// are filtered out.
function parsePrompts(text) {
  const lines = (text || "").split(/\r?\n/);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*CLIP\s*\d/i.test(line) && current.length) {
      blocks.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n").trim());
  return blocks.filter((b) => b.length >= 20);
}

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("file read failed"));
    r.readAsDataURL(file);
  });
}

async function onImagesPicked(ev) {
  const files = Array.from(ev.target.files || []);
  pickedImages = [];
  for (const f of files) {
    try {
      const data = await fileToDataUri(f);
      pickedImages.push({ name: f.name, dataUri: data });
    } catch (e) {
      console.warn("file read failed", f.name, e);
    }
  }
  updateGenCounts();
}

function updateGenCounts() {
  const prompts = parsePrompts($("f-gen-prompts").value);
  $("f-gen-counts").textContent = `${prompts.length} Prompts · ${pickedImages.length} Bilder`;
}

async function startGenerations() {
  const prompts = parsePrompts($("f-gen-prompts").value);
  if (!prompts.length) { alert("Keine Prompts gefunden. Tipp: jeden Prompt mit 'CLIP N' beginnen lassen."); return; }
  if (!pickedImages.length) { alert("Keine Bilder ausgewaehlt."); return; }
  if (prompts.length !== pickedImages.length) {
    if (!confirm(`Anzahl Prompts (${prompts.length}) != Anzahl Bilder (${pickedImages.length}). Trotzdem starten? Es wird die kleinere Menge verarbeitet.`)) return;
  }
  const n = Math.min(prompts.length, pickedImages.length);

  // Build LIGHTWEIGHT metadata only - no imageDataUri here. Image bytes are
  // streamed to the background separately (one message per image) so we
  // never put them in chrome.storage.local (10 MB QUOTA_BYTES limit) and
  // also avoid one giant runtime.sendMessage payload.
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      index: i,
      prompt: prompts[i],
      imageName: pickedImages[i].name,
    });
  }
  const perAccount = Math.max(1, Math.min(10, parseInt($("f-gen-per-account").value, 10) || 3));

  const btn = $("btn-gen-start");
  const origText = btn.textContent;
  btn.disabled = true;
  try {
    // 1) Reset any leftover bytes from a previous (cancelled) batch.
    await chrome.runtime.sendMessage({ type: "PV_GEN_IMAGES_RESET" });

    // 2) Stream each image one-by-one. Each message stays well below any
    //    runtime.sendMessage size limits and the bg keeps the bytes in
    //    an in-memory Map, NOT in chrome.storage.local.
    for (let i = 0; i < n; i++) {
      btn.textContent = `Sende Bild ${i + 1}/${n}...`;
      let r;
      try {
        r = await chrome.runtime.sendMessage({
          type: "PV_GEN_IMAGE_CHUNK",
          index: i,
          name: pickedImages[i].name,
          dataUri: pickedImages[i].dataUri,
        });
      } catch (e) {
        alert(`Bild ${i + 1} (${pickedImages[i].name}) konnte nicht gesendet werden: ${e.message}`);
        return;
      }
      if (!r || !r.ok) {
        alert(`Bild ${i + 1} (${pickedImages[i].name}) konnte nicht gesendet werden: ${r?.error || "unknown"}`);
        return;
      }
    }

    // 3) Now kick off the queue with text-only metadata.
    btn.textContent = origText;
    const r = await chrome.runtime.sendMessage({
      type: "PV_START_GENERATIONS",
      opts: { items, perAccount },
    });
    if (!r || !r.ok) {
      alert("Generierungen-Start fehlgeschlagen: " + (r?.error || "unknown"));
      return;
    }
    refresh();
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();

  chrome.storage.local.get("pv_referral_code").then((s) => {
    $("f-referral").value = (s.pv_referral_code || "Q1XJSEBM").toUpperCase();
  });
  $("f-referral").addEventListener("input", (e) => {
    const v = (e.target.value || "").trim().toUpperCase();
    e.target.value = v;
    chrome.storage.local.set({ pv_referral_code: v || "Q1XJSEBM" });
  });

  chrome.storage.local.get("pv_repeat_total_pref").then((s) => {
    $("f-repeat").value = Math.max(1, parseInt(s.pv_repeat_total_pref, 10) || 1);
  });
  $("f-repeat").addEventListener("input", (e) => {
    const v = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1));
    e.target.value = v;
    chrome.storage.local.set({ pv_repeat_total_pref: v });
  });

  chrome.storage.local.get("pv_gen_per_account_pref").then((s) => {
    $("f-gen-per-account").value = Math.max(1, parseInt(s.pv_gen_per_account_pref, 10) || 3);
  });
  $("f-gen-per-account").addEventListener("input", (e) => {
    const v = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 3));
    e.target.value = v;
    chrome.storage.local.set({ pv_gen_per_account_pref: v });
  });

  $("f-gen-prompts").addEventListener("input", updateGenCounts);
  $("f-gen-images").addEventListener("change", onImagesPicked);
  $("btn-gen-start").addEventListener("click", startGenerations);
  $("btn-gen-stop").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "PV_STOP_GENERATIONS" });
    refresh();
  });

  $("btn-claim").addEventListener("click", async () => {
    const tabs = await chrome.tabs.query({ url: "https://app.pixverse.ai/*", active: true, currentWindow: true });
    let tab = tabs[0];
    if (!tab) { const all = await chrome.tabs.query({ url: "https://app.pixverse.ai/*" }); tab = all[0]; }
    if (!tab) { alert("Kein PixVerse-Tab offen."); return; }
    try { await chrome.tabs.sendMessage(tab.id, { type: "PV_CLAIM_REFERRAL_NOW" }); }
    catch (e) { alert("Konnte den Tab nicht ansprechen: " + e.message); }
  });

  $("btn-start").addEventListener("click", async () => {
    $("btn-start").disabled = true;
    try {
      const repeatTotal = Math.max(1, parseInt($("f-repeat").value, 10) || 1);
      const r = await chrome.runtime.sendMessage({ type: "PV_START", opts: { repeatTotal } });
      if (!r.ok) alert("Start fehlgeschlagen: " + r.error);
    } finally { $("btn-start").disabled = false; refresh(); }
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
    const KEEP = ["pv_accounts_history", "pv_referral_code", "pv_repeat_total_pref", "pv_gen_per_account_pref"];
    const keep = await chrome.storage.local.get(KEEP);
    await chrome.storage.local.clear();
    await chrome.storage.local.set(keep);
    await chrome.runtime.sendMessage({ type: "PV_STOP" });
    await chrome.runtime.sendMessage({ type: "PV_STOP_GENERATIONS" });
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

  const live = setInterval(refresh, 1500);
  window.addEventListener("unload", () => clearInterval(live));
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === "local") refresh(); });
});
