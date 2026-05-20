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
}

document.addEventListener("DOMContentLoaded", () => {
  refresh();

  $("btn-start").addEventListener("click", async () => {
    $("btn-start").disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: "PV_START", opts: {} });
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
