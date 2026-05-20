#!/usr/bin/env python3
"""
PixVerse Registrierung - CDP Connect zu deinem echten Chrome
=============================================================

ANLEITUNG:
1. Doppelklick auf start_chrome.bat (Windows) oder start_chrome.sh (Mac/Linux)
   -> Ein NEUES Chrome-Fenster oeffnet sich mit Debug-Port
   -> Dein normales Chrome bleibt offen!

2. Im neuen Chrome-Fenster:
   - Falls Cloudflare-Captcha erscheint, klicke es manuell weg
   - WICHTIG: Lass das Fenster geoeffnet!

3. In einem zweiten Terminal: python pixverse_cdp.py
   -> Skript haengt sich an dein Chrome an
   -> Cloudflare sieht es als deinen normalen Browser

INSTALLATION:
    pip install playwright requests
    (kein 'playwright install chromium' noetig - wir nutzen dein Chrome!)
"""

import asyncio
import re
import random
import string
import json
import time
from datetime import datetime
import requests


# =====================================================================
# mail.tm fuer temporaere E-Mail
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


async def main():
    print("=" * 70)
    print("PixVerse Registrierung - CDP Connect zu deinem Chrome")
    print("=" * 70)

    print("\n[CHECK] Pruefe ob Chrome mit Debug-Port laeuft...")
    try:
        r = requests.get("http://localhost:9222/json/version", timeout=3)
        version = r.json()
        print(f"    [OK] Chrome gefunden: {version.get('Browser', 'Unknown')}")
    except:
        print("\n    [FEHLER] Chrome nicht erreichbar auf Port 9222!")
        print("\n    Bitte zuerst start_chrome.bat (Windows) oder start_chrome.sh ausfuehren!")
        print("    Dann das Chrome-Fenster offen lassen und dieses Skript erneut starten.")
        return

    # E-Mail erstellen
    print("\n[1] Erstelle temporaere E-Mail (mail.tm)...")
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

    # Mit deinem Chrome verbinden!
    from playwright.async_api import async_playwright

    print("\n[2] Verbinde mich mit deinem Chrome via CDP...")
    async with async_playwright() as p:
        # connect_over_cdp = anhaengen an laufenden Browser
        browser = await p.chromium.connect_over_cdp("http://localhost:9222")
        print(f"    [OK] Verbunden! Anzahl Contexts: {len(browser.contexts)}")

        # Den existierenden Context und Tab nehmen (das ist DEIN Chrome!)
        context = browser.contexts[0]
        pages = context.pages

        # Page mit pixverse.ai finden oder neuen Tab oeffnen
        page = None
        for p_check in pages:
            if "pixverse" in p_check.url.lower():
                page = p_check
                print(f"    [OK] Bestehender PixVerse-Tab gefunden: {page.url}")
                break

        if not page:
            print("    Oeffne neuen Tab...")
            page = await context.new_page()
            await page.goto("https://app.pixverse.ai/register", wait_until="load")

        # Sicherstellen dass wir auf register sind
        if "register" not in page.url:
            print("    Navigiere zu /register...")
            await page.goto("https://app.pixverse.ai/register", wait_until="load")

        await asyncio.sleep(3)

        # Pruefe ob Cloudflare-Challenge sichtbar
        title = await page.title()
        if "moment" in title.lower() or "challenge" in title.lower():
            print("\n    [!] Cloudflare-Challenge sichtbar - bitte im Browser manuell loesen!")
            print("    Dann Enter im Terminal druecken...")
            input()

        # Formular ausfuellen
        print("\n[3] Fuelle Formular aus...")
        try:
            inputs = await page.query_selector_all("input")
            visible = []
            for inp in inputs:
                if await inp.is_visible():
                    visible.append(inp)

            if len(visible) >= 4:
                # Felder leeren falls schon ausgefuellt
                for inp in visible[:4]:
                    await inp.click()
                    await page.keyboard.press("Control+A")
                    await page.keyboard.press("Delete")

                await visible[0].click()
                await visible[0].type(username, delay=80)
                await asyncio.sleep(0.5)

                await visible[1].click()
                await visible[1].type(temp_email, delay=80)
                await asyncio.sleep(0.5)

                await visible[2].click()
                await visible[2].type(password, delay=80)
                await asyncio.sleep(0.5)

                await visible[3].click()
                await visible[3].type(password, delay=80)

                print(f"    [OK] Username: {username}")
                print(f"    [OK] E-Mail: {temp_email}")
                print(f"    [OK] Passwort eingetragen")
        except Exception as e:
            print(f"    [WARN] Auto-Fuellen fehlgeschlagen: {e}")
            print("    Bitte manuell ausfuellen, Enter zum Fortfahren...")
            input()

        # Captcha - wenn das Chrome echt ist, sollte es passiv klappen
        print("\n[4] Warte auf Turnstile...")
        for i in range(30):
            try:
                token = await page.evaluate("""() => {
                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                    return inp ? inp.value : null;
                }""")
                if token and len(token) > 10:
                    print(f"    [OK] Turnstile geloest nach {i*2}s!")
                    break
            except:
                pass
            if i % 5 == 4:
                print(f"    ... {(i+1)*2}s")
            await asyncio.sleep(2)
        else:
            print("    [!] Turnstile nicht passiv geloest")
            print("    Bitte im Chrome-Fenster manuell auf das Captcha klicken!")
            print("    Dann Enter druecken...")
            input()

        # Continue klicken
        print("\n[5] Klicke Continue/Weiter...")
        await asyncio.sleep(1)
        try:
            btn = await page.query_selector("button:has-text('Continue'), button:has-text('Weiter')")
            if btn:
                await btn.click()
                print("    [OK] Geklickt")
        except Exception as e:
            print(f"    [WARN] {e}")
            print("    Bitte manuell klicken, Enter zum Fortfahren...")
            input()

        await asyncio.sleep(5)
        print(f"    URL: {page.url}")

        # E-Mail abwarten
        print("\n[6] Warte auf Verifizierungs-E-Mail (3 Min)...")
        verification_code = None
        verification_link = None

        for i in range(36):
            messages = mail.get_messages()
            if messages:
                print(f"\n    [OK] E-Mail empfangen!")
                msg = messages[0]
                print(f"    Von: {msg.get('from', {}).get('address')}")
                print(f"    Betreff: {msg.get('subject')}")

                detail = mail.get_message(msg["id"])
                text = detail.get("text", "")
                html_data = detail.get("html", [])
                full_html = " ".join(html_data) if isinstance(html_data, list) else str(html_data)
                full = text + " " + full_html

                codes = [c for c in re.findall(r'\b(\d{4,6})\b', full)]
                if codes:
                    verification_code = codes[0]
                    print(f"    Code: {verification_code}")

                links = re.findall(r'https?://[^\s<>"\']+', full_html)
                for link in links:
                    if "pixverse" in link.lower() and any(k in link.lower() for k in ["verify", "confirm", "activate"]):
                        verification_link = link
                        print(f"    Link: {link[:80]}")
                        break
                break

            time.sleep(5)
            if i % 6 == 5:
                print(f"    ... {(i+1)*5}s")

        # Verifizieren
        if verification_link:
            print(f"\n[7] Oeffne Verifizierungslink...")
            await page.goto(verification_link)
            await asyncio.sleep(5)
            print(f"    URL: {page.url}")
        elif verification_code:
            print(f"\n[7] Code zum Eingeben: {verification_code}")
            print("    (Bitte in der Seite eingeben falls noetig)")

        print("\n[FERTIG] Browser bleibt geoeffnet - schliesse ihn manuell wenn fertig.")

    print("\n" + "=" * 70)
    print("ERGEBNIS")
    print("=" * 70)
    print(f"E-Mail: {temp_email}")
    print(f"Username: {username}")
    print(f"Passwort: {password}")


if __name__ == "__main__":
    asyncio.run(main())
