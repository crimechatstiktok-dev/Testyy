#!/usr/bin/env python3
"""
PixVerse Registrierung - Cookie-basiert
========================================
Nutzt Cloudflare-Cookies von deinem echten Browser.
Kein Captcha nötig!

ANLEITUNG:
1. Öffne https://app.pixverse.ai/register in deinem Chrome
2. F12 -> Application -> Cookies -> app.pixverse.ai
3. Kopiere __cf_bm und cf_clearance Werte unten rein
4. python pixverse_cookie.py

Cookies laufen nach ca. 30 Min - 2h ab.
Einfach neu holen wenn "403" kommt.

INSTALLATION:
    pip install requests aiohttp playwright
    playwright install chromium
"""

import requests
import re
import random
import string
import json
import time
import asyncio
from datetime import datetime

# =====================================================================
# HIER DEINE COOKIES EINTRAGEN (vor jedem Run aktualisieren!)
# =====================================================================
CF_BM = "18GmUNZvsJdrnjpL3C9770h5RVwWA2CVZJ8Vv5oIpSc-1779295995.2390497-1.0.1.1-NxLr5s3GD59oNVhYnaC6v5WUGKIOECdwluuIgJhSRxSt6RdzrlruTRRrgBvuDHJVmgp5zlyC1h5o8mO3pdh7TiVM7qK8XXASqQYBJSF6AcmMa13s.h2AzVpHCfVhXWp3"

CF_CLEARANCE = "91JzzOxxhwwdFUnbK.IKNhqh.P1xfMyCZ8XbqtjniQo-1779295995-1.2.1.1-l1UqRv2wC4yTwB5ZQxOJEK8KwzsTqs6bAHuo_o3Milt9m_adHg7blvsn8gMAE.AsG2QTtujZhlJadi6VGqpnIcqyJRZE30qEsw5UCGGJEccpA3fcRPuXxcSigFGy0FYT.4J074ej7FOGYOfDOPPJOGtT2b11HMsX9S3Jfkm20E1nX.4MjcjQwzxrIsLYZlYESp.e_NkR8s_M9TAlt8FUCumgi4QTCgm.sh8jEZGF8qYLX4kh1.NZ1pHh_VYcAggur7fwO2X.b7GDW.4L4tBA58ZvKW9.M44sMZYcs1WX2mgsdfQwuYNWpiW21EFXbO1vlgF9csODqBgJM15Y5mXYxQPnWjtWG4bVzRX1wJQ1KalKuNMclCoXkl04IeFX.xZ7nTsowikKdc_oWDaRSjnRgk28e2Hkx7p3xeqibakXK.M"

# User-Agent MUSS mit dem uebereinstimmen, der den Cookie generiert hat!
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"


# =====================================================================
# mail.tm E-Mail API
# =====================================================================
class MailTM:
    def __init__(self):
        self.base_url = "https://api.mail.tm"
        self.email = None
        self.password = None
        self.token = None

    def create_account(self):
        r = requests.get(f"{self.base_url}/domains")
        domain = r.json()["hydra:member"][0]["domain"]
        user = ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
        self.email = f"{user}@{domain}"
        self.password = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
        r = requests.post(f"{self.base_url}/accounts", json={"address": self.email, "password": self.password})
        if r.status_code != 201:
            return None
        r = requests.post(f"{self.base_url}/token", json={"address": self.email, "password": self.password})
        self.token = r.json().get("token")
        return self.email

    def get_messages(self):
        r = requests.get(f"{self.base_url}/messages", headers={"Authorization": f"Bearer {self.token}"})
        return r.json().get("hydra:member", [])

    def get_message(self, msg_id):
        r = requests.get(f"{self.base_url}/messages/{msg_id}", headers={"Authorization": f"Bearer {self.token}"})
        return r.json()


# =====================================================================
# Hauptprogramm - Browser mit Cookies oeffnen
# =====================================================================
async def run_browser():
    from playwright.async_api import async_playwright

    print("\n[3] Starte Browser mit deinen Cookies...")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=['--no-sandbox'])
        context = await browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1920, "height": 945},
            locale="de-DE",
            timezone_id="Europe/Berlin"
        )

        # COOKIES VOR DEM LADEN SETZEN!
        await context.add_cookies([
            {"name": "__cf_bm", "value": CF_BM, "domain": ".pixverse.ai", "path": "/"},
            {"name": "cf_clearance", "value": CF_CLEARANCE, "domain": ".pixverse.ai", "path": "/"},
        ])

        page = await context.new_page()

        print("    Lade PixVerse Register...")
        await page.goto("https://app.pixverse.ai/register", wait_until="load", timeout=30000)
        await asyncio.sleep(3)

        print(f"    URL: {page.url}")

        # Prüfe ob Cloudflare durchgelassen hat
        content = await page.evaluate("() => document.body.innerText.substring(0, 300)")
        if "moment" in content.lower() or "challenge" in content.lower():
            print("\n    [FEHLER] Cookies abgelaufen! Bitte neue holen.")
            await browser.close()
            return None, None, None

        print("    [OK] Cloudflare umgangen!")
        return browser, context, page


def main():
    print("=" * 70)
    print("PixVerse Registrierung - Cookie-basiert")
    print("=" * 70)

    # E-Mail erstellen
    print("\n[1] Erstelle temporaere E-Mail...")
    mail = MailTM()
    temp_email = mail.create_account()
    if not temp_email:
        print("    [FEHLER]")
        return
    print(f"    E-Mail: {temp_email}")

    username = ''.join(random.choices(string.ascii_lowercase, k=8))
    password = "TestPass123!" + ''.join(random.choices(string.digits, k=3))
    print(f"    Username: {username}")
    print(f"    Passwort: {password}")

    # Browser mit Cookies starten
    async def do_registration():
        browser, context, page = await run_browser()
        if not page:
            return

        try:
            # Formular ausfuellen
            print("\n[4] Fuelle Formular...")
            inputs = await page.query_selector_all("input")
            visible = []
            for inp in inputs:
                if await inp.is_visible():
                    visible.append(inp)

            if len(visible) >= 4:
                await visible[0].type(username, delay=80)
                await visible[1].type(temp_email, delay=80)
                await visible[2].type(password, delay=80)
                await visible[3].type(password, delay=80)
                print(f"    [OK] Formular ausgefuellt")

            await asyncio.sleep(2)

            # Turnstile - mit Cookie sollte es passiv gehen!
            print("\n[5] Warte auf Turnstile (mit Cookie sollte es passiv klappen)...")
            for i in range(30):
                token = await page.evaluate("""() => {
                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                    return inp ? inp.value : null;
                }""")
                if token and len(token) > 10:
                    print(f"    [OK] Turnstile geloest nach {i*2}s!")
                    break
                if i % 5 == 4:
                    print(f"    ... {(i+1)*2}s")
                await asyncio.sleep(2)
            else:
                print("    [WARN] Turnstile nicht geloest - versuche manuell!")
                input("    Klicke Captcha im Browser und druecke Enter: ")

            # Continue
            print("\n[6] Klicke Continue...")
            btn = await page.query_selector("button:has-text('Continue'), button:has-text('Weiter')")
            if btn:
                await btn.click(force=True)
                print("    [OK] Geklickt")

            await asyncio.sleep(5)
            print(f"    URL: {page.url}")

            # Warte auf E-Mail
            print("\n[7] Warte auf E-Mail (3 Min)...")
            for i in range(36):
                messages = mail.get_messages()
                if messages:
                    print(f"\n    [OK] E-Mail da!")
                    msg = messages[0]
                    print(f"    Betreff: {msg.get('subject')}")
                    detail = mail.get_message(msg["id"])
                    text = detail.get("text", "")
                    html_data = detail.get("html", [])
                    full = text + " ".join(html_data if isinstance(html_data, list) else [str(html_data)])
                    codes = [c for c in re.findall(r'\b(\d{4,6})\b', full)]
                    if codes:
                        print(f"    Code: {codes[0]}")
                    links = [l for l in re.findall(r'https?://[^\s<>"]+', full) if "pixverse" in l.lower()]
                    if links:
                        print(f"    Link: {links[0][:70]}")
                    break
                time.sleep(5)
                if i % 6 == 5:
                    print(f"    ... {(i+1)*5}s")

            print("\n    Browser bleibt 30s offen...")
            await asyncio.sleep(30)

        finally:
            await browser.close()

    asyncio.run(do_registration())

    print("\n" + "=" * 70)
    print("FERTIG")
    print("=" * 70)
    print(f"E-Mail: {temp_email}")
    print(f"Username: {username}")
    print(f"Passwort: {password}")


if __name__ == "__main__":
    main()
