// =============================================================================
// PixVerse Auto-Register - Content Script
// =============================================================================
// Laeuft auf app.pixverse.ai/register (und /verify, /login fallback).
// Aufgaben:
//   1. Beim Erhalt von PV_FILL_FORM: 4 Felder (User, Mail, Pass, Confirm)
//      mit React-kompatiblen Events fuellen.
//   2. Auf Turnstile-Loesung warten (input[name="cf-turnstile-response"]
//      enthaelt Token oder Continue-Button wird enabled).
//   3. Continue/Weiter klicken.
//   4. Nach Empfang von PV_VERIFICATION: Code in das Verifizierungs-Input
//      eingeben (1 Feld ODER mehrere Digit-Boxen) ODER, bei Link, navigieren.
// =============================================================================

(() => {
  if (window.__pvAutoRegisterInjected) return;
  window.__pvAutoRegisterInjected = true;

  const state = {
    account: null,
    formFilled: false,
    continueClicked: false,
    verificationDone: false,
  };

  // ---------------------------------------------------------------------------
  // Logging helpers
  // ---------------------------------------------------------------------------
  function logBg(line) {
    try {
      chrome.runtime.sendMessage({ type: "PV_CONTENT_LOG", line });
    } catch (e) { /* ignore - service worker might be sleeping */ }
    console.log("[PV-CT]", line);
  }
  function setStatus(s) {
    try {
      chrome.runtime.sendMessage({ type: "PV_CONTENT_STATUS", status: s });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // React-friendly input setter: triggers onChange handlers reliably.
  // ---------------------------------------------------------------------------
  function setReactInputValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
                                             : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  function visibleInputs() {
    const all = Array.from(document.querySelectorAll("input"));
    return all.filter((i) => {
      const t = (i.type || "text").toLowerCase();
      if (["hidden", "submit", "button", "checkbox", "radio", "file"].includes(t)) return false;
      return isVisible(i);
    });
  }

  function findContinueButton() {
    const btns = Array.from(document.querySelectorAll("button"));
    for (const b of btns) {
      const txt = (b.innerText || b.textContent || "").trim();
      if (/^(continue|weiter|sign up|register|submit|next)$/i.test(txt) ||
          /continue|weiter/i.test(txt)) {
        if (isVisible(b)) return b;
      }
    }
    // Fallback: any visible submit button
    for (const b of btns) {
      if (b.type === "submit" && isVisible(b)) return b;
    }
    return null;
  }

  function buttonEnabled(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    const cls = btn.className || "";
    if (typeof cls === "string" && cls.includes("cursor-not-allowed")) return false;
    if (btn.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function getTurnstileToken() {
    const inp = document.querySelector('input[name="cf-turnstile-response"]');
    return inp && inp.value ? inp.value : null;
  }

  // ---------------------------------------------------------------------------
  // Step 1 - fill the form
  // ---------------------------------------------------------------------------
  async function fillForm(account) {
    state.account = account;
    setStatus("filling-form");
    logBg("fillForm start");

    // Wait until at least 4 visible inputs are mounted.
    const inputs = await waitFor(() => {
      const v = visibleInputs();
      return v.length >= 4 ? v : null;
    }, 20000, 250);

    if (!inputs) {
      logBg("ERROR: did not find 4 visible inputs in time");
      setStatus("error");
      return;
    }

    const values = [account.username, account.email, account.password, account.password];
    for (let i = 0; i < 4; i++) {
      const el = inputs[i];
      el.focus();
      setReactInputValue(el, values[i]);
      el.blur();
      await sleep(120 + Math.random() * 180);
    }
    state.formFilled = true;
    logBg("Form filled (user/email/pass/confirm)");
    setStatus("waiting-turnstile");

    waitForTurnstileAndContinue();
  }

  // ---------------------------------------------------------------------------
  // Step 2/3 - wait for Turnstile token, then click Continue
  // ---------------------------------------------------------------------------
  async function waitForTurnstileAndContinue() {
    const start = Date.now();
    const maxMs = 180000; // 3 min total

    while (Date.now() - start < maxMs) {
      const token = getTurnstileToken();
      const btn = findContinueButton();
      const enabled = buttonEnabled(btn);

      if (token && token.length > 10) {
        logBg(`Turnstile token detected (len=${token.length})`);
        setStatus("turnstile-solved");
        // Small human-ish pause before clicking.
        await sleep(700 + Math.random() * 800);
        clickContinue();
        return;
      }

      if (enabled) {
        // Some sites enable the button without exposing the token to a hidden
        // input (token lives inside the iframe). Treat enabled-button as ok.
        logBg("Continue enabled (token not visible) -> clicking");
        setStatus("turnstile-solved");
        await sleep(500 + Math.random() * 600);
        clickContinue();
        return;
      }

      await sleep(800);
    }

    logBg("Turnstile timeout (3 min). Aborting auto-click.");
    setStatus("error");
  }

  function clickContinue() {
    if (state.continueClicked) return;
    const btn = findContinueButton();
    if (!btn) {
      logBg("ERROR: continue button not found");
      setStatus("error");
      return;
    }
    if (!buttonEnabled(btn)) {
      logBg("WARN: button still disabled, attempting force click anyway");
    }
    btn.click();
    state.continueClicked = true;
    logBg("Continue clicked");
    setStatus("submitted");
    // After click, a verification view (code or 'check email') will render.
    watchForVerificationUI();
  }

  // ---------------------------------------------------------------------------
  // Step 4 - verification
  // ---------------------------------------------------------------------------
  // We poll for either a code-input (single or split digit boxes) and we
  // also listen for PV_VERIFICATION message from the background.
  // ---------------------------------------------------------------------------
  let pendingVerification = null;

  function watchForVerificationUI() {
    setStatus("waiting-mail");
    logBg("Watching for verification UI / inbox...");
    // Nothing to do here actively; PV_VERIFICATION arrives via chrome.runtime
    // and applyVerification() will dispatch.
  }

  async function applyVerification(payload) {
    if (state.verificationDone) return;
    pendingVerification = payload;

    if (payload.link) {
      logBg(`Navigating to verification link: ${payload.link.slice(0, 80)}...`);
      setStatus("opening-link");
      window.location.href = payload.link;
      state.verificationDone = true;
      return;
    }

    if (!payload.code) {
      logBg("Verification payload empty - nothing to do");
      return;
    }

    logBg(`Trying to enter code: ${payload.code}`);
    setStatus("entering-code");

    // Some PixVerse builds show split boxes (one digit each), others a single
    // input. Detect by counting visible numeric/text inputs that appear to be
    // verification-specific (small maxlength or only digits).
    const ok = await waitFor(() => {
      const inputs = visibleInputs();
      // Heuristic: form inputs we already saw are gone (we navigated past
      // /register UI), or new inputs that are obviously OTP-like.
      const otpLike = inputs.filter((i) => {
        const ml = parseInt(i.getAttribute("maxlength") || "0", 10);
        const inMode = (i.getAttribute("inputmode") || "").toLowerCase();
        const auto = (i.getAttribute("autocomplete") || "").toLowerCase();
        return ml === 1 || ml === 6 || inMode === "numeric" || auto.includes("one-time-code");
      });
      if (otpLike.length) return otpLike;
      // Fallback: if there are 1-2 visible inputs total, just use them.
      if (inputs.length > 0 && inputs.length <= 2) return inputs;
      return null;
    }, 60000, 500);

    if (!ok) {
      logBg("ERROR: code-input UI did not appear in 60s");
      setStatus("error");
      return;
    }

    if (ok.length >= payload.code.length) {
      // Split digit boxes - one digit per input.
      for (let i = 0; i < payload.code.length; i++) {
        const el = ok[i];
        el.focus();
        setReactInputValue(el, payload.code[i]);
        await sleep(80 + Math.random() * 120);
      }
    } else {
      // Single input takes the whole code.
      const el = ok[0];
      el.focus();
      setReactInputValue(el, payload.code);
    }

    logBg("Code entered");
    state.verificationDone = true;
    setStatus("code-entered");

    // Try to click a confirm button if present.
    await sleep(800);
    const confirmBtn = (() => {
      const btns = Array.from(document.querySelectorAll("button"));
      for (const b of btns) {
        const t = (b.innerText || "").trim().toLowerCase();
        if (/(confirm|verify|verifizieren|bestaetigen|continue|weiter|submit)/i.test(t) && isVisible(b)) {
          return b;
        }
      }
      return null;
    })();
    if (confirmBtn && buttonEnabled(confirmBtn)) {
      confirmBtn.click();
      logBg("Confirm button clicked");
      setStatus("done");
    } else {
      logBg("No confirm button (maybe auto-submit) - leaving as is");
      setStatus("done");
    }
  }

  // ---------------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------------
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitFor(fn, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = fn();
        if (v) return v;
      } catch (_) {}
      await sleep(intervalMs);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Message handler from background
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "PV_FILL_FORM") {
          await fillForm(msg.account);
          sendResponse({ ok: true });
        } else if (msg.type === "PV_VERIFICATION") {
          await applyVerification(msg);
          sendResponse({ ok: true });
        } else if (msg.type === "PV_PING") {
          sendResponse({ ok: true, url: location.href });
        } else {
          sendResponse({ ok: false, error: "unknown" });
        }
      } catch (e) {
        logBg(`handler error: ${e.message}`);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  });

  // If a run is already active and we just landed on the page (e.g. extension
  // navigated us via verification link), pull the latest known state and
  // continue where appropriate.
  (async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: "PV_GET_STATE" });
      if (r && r.ok && r.state && r.state.pv_run_active && r.state.pv_account) {
        logBg(`Content loaded - run active, url=${location.pathname}`);
        // If we're back on /register and form not yet filled this session, fill it.
        if (/\/register/.test(location.pathname) && !state.formFilled) {
          // small grace period for app shell hydration
          setTimeout(() => fillForm(r.state.pv_account), 1500);
        }
        // If we land on /verify and there is already a verification stored, apply it.
        if (/\/verify/.test(location.pathname) && r.state.pv_verification) {
          setTimeout(() => applyVerification(r.state.pv_verification), 1500);
        }
      }
    } catch (e) { /* ignore */ }
  })();

  logBg(`content script ready @ ${location.pathname}`);
})();
