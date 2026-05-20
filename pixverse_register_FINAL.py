#!/usr/bin/env python3
"""
PixVerse AI Registrierung - FINALE VERSION für lokale Ausführung
================================================================

Dieses Skript:
1. Erstellt eine temporäre E-Mail über mail.tm (kein Cloudflare!)
2. Öffnet PixVerse Register-Seite
3. Füllt das Formular automatisch aus
4. WARTET auf Cloudflare Turnstile (löst sich auf echten Computern AUTOMATISCH!)
5. Klickt Submit
6. Wartet auf Verifizierungs-E-Mail über mail.tm API
7. Extrahiert Code/Link und verifiziert

WICHTIG: Auf einem echten Desktop-Computer löst sich Cloudflare Turnstile 
automatisch (passive challenge). In Server-Umgebungen wird der Browser als 
Bot erkannt und blockiert.

INSTALLATION:
    pip install playwright aiohttp
    playwright install chromium

AUSFÜHRUNG:
    python pixverse_register_FINAL.py
"""

import asyncio
import re
import random
import string
import json
from datetime import datetime
from playwright.async_api import async_playwright
import aiohttp


class MailTM:
    """mail.tm API Client - kostenlose temporäre E-Mails ohne Cloudflare"""
    
    def __init__(self):
        self.base_url = "https://api.mail.tm"
        self.email = None
        self.password = None
        self.token = None
    
    async def create_account(self):
        async with aiohttp.ClientSession() as session:
            # Domain holen
            async with session.get(f"{self.base_url}/domains") as r:
                domains = (await r.json())["hydra:member"]
                domain = domains[0]["domain"]
            
            # Account erstellen
            user = ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
            self.email = f"{user}@{domain}"
            self.password = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
            
            async with session.post(
                f"{self.base_url}/accounts",
                json={"address": self.email, "password": self.password}
            ) as r:
                if r.status != 201:
                    return None
            
            # Token holen
            async with session.post(
                f"{self.base_url}/token",
                json={"address": self.email, "password": self.password}
            ) as r:
                self.token = (await r.json()).get("token")
            
            return self.email
    
    async def get_messages(self):
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.base_url}/messages",
                headers={"Authorization": f"Bearer {self.token}"}
            ) as r:
                return (await r.json()).get("hydra:member", [])
    
    async def get_message(self, msg_id):
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.base_url}/messages/{msg_id}",
                headers={"Authorization": f"Bearer {self.token}"}
            ) as r:
                return await r.json()


async def main():
    print("=" * 70)
    print("PixVerse AI Registrierung - Automatisch")
    print("=" * 70)
    
    # Mail erstellen
    print("\n[1] Erstelle temporäre E-Mail über mail.tm...")
    mail = MailTM()
    temp_email = await mail.create_account()
    
    if not temp_email:
        print("    [FEHLER] Konnte E-Mail nicht erstellen")
        return
    
    print(f"    [✓] E-Mail: {temp_email}")
    
    # Daten generieren
    username = ''.join(random.choices(string.ascii_lowercase, k=8))
    password = "TestPass123!" + ''.join(random.choices(string.digits, k=3))
    
    print(f"    Username: {username}")
    print(f"    Passwort: {password}")
    
    result = {
        "timestamp": datetime.now().isoformat(),
        "email": temp_email,
        "username": username,
        "password": password,
        "success": False
    }
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,  # SICHTBAR für Cloudflare Turnstile
            args=[
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox'
            ]
        )
        context = await browser.new_context(
            viewport={"width": 1400, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            locale="de-DE",
            timezone_id="Europe/Berlin"
        )
        
        # Anti-Detection
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
            Object.defineProperty(navigator, 'languages', {get: () => ['de-DE','de','en']});
            Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});
            window.chrome = {runtime: {}, loadTimes: function(){}, csi: function(){}};
        """)
        
        page = await context.new_page()
        
        try:
            # Register-Seite
            print("\n[2] Öffne PixVerse Register...")
            await page.goto("https://app.pixverse.ai/register", wait_until="load", timeout=30000)
            await asyncio.sleep(3)
            
            # Formular ausfüllen
            print("\n[3] Fülle Formular aus...")
            
            # Sichtbare Inputs holen
            visible_inputs = []
            all_inputs = await page.query_selector_all("input")
            for inp in all_inputs:
                if await inp.is_visible():
                    visible_inputs.append(inp)
            
            if len(visible_inputs) >= 4:
                # Mit "human-like" Tippen
                await visible_inputs[0].click()
                await visible_inputs[0].type(username, delay=80)
                await asyncio.sleep(0.5)
                
                await visible_inputs[1].click()
                await visible_inputs[1].type(temp_email, delay=80)
                await asyncio.sleep(0.5)
                
                await visible_inputs[2].click()
                await visible_inputs[2].type(password, delay=80)
                await asyncio.sleep(0.5)
                
                await visible_inputs[3].click()
                await visible_inputs[3].type(password, delay=80)
                await asyncio.sleep(0.5)
                
                print(f"    Username: {username}")
                print(f"    E-Mail: {temp_email}")
                print(f"    Passwort: {password}")
            
            # Warte auf Cloudflare Turnstile
            print("\n[4] Warte auf Cloudflare Turnstile...")
            print("    (Auf Desktop löst sich das automatisch in 5-30 Sekunden)")
            
            turnstile_solved = False
            for i in range(60):  # Max 2 Minuten
                token = await page.evaluate("""() => {
                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                    return inp ? inp.value : null;
                }""")
                
                if token and len(token) > 10:
                    print(f"    [✓] Turnstile gelöst nach {i*2}s!")
                    turnstile_solved = True
                    break
                
                await asyncio.sleep(2)
                if i % 10 == 9:
                    print(f"    ... noch nicht gelöst ({(i+1)*2}s)")
            
            if not turnstile_solved:
                print("    [⚠️] Turnstile nicht automatisch gelöst")
                print("    Bitte löse das Captcha manuell im Browser!")
                input("    Drücke Enter wenn das Captcha gelöst ist...")
            
            # Submit
            print("\n[5] Klicke 'Continue/Weiter'...")
            btn = await page.query_selector("button:has-text('Continue'), button:has-text('Weiter')")
            if btn:
                await btn.click()
                print("    [✓] Geklickt")
            
            await asyncio.sleep(5)
            print(f"    URL: {page.url}")
            
            # Auf E-Mail warten
            print("\n[6] Warte auf Verifizierungs-E-Mail (max 3 Min)...")
            
            verification_code = None
            verification_link = None
            
            for i in range(36):  # 3 Minuten
                messages = await mail.get_messages()
                
                if messages:
                    print(f"\n    [✓] E-Mail empfangen!")
                    msg = messages[0]
                    print(f"    Von: {msg.get('from', {}).get('address')}")
                    print(f"    Betreff: {msg.get('subject')}")
                    
                    # Details holen
                    detail = await mail.get_message(msg["id"])
                    text = detail.get("text", "")
                    html_data = detail.get("html", [])
                    full_html = " ".join(html_data) if isinstance(html_data, list) else str(html_data)
                    full_content = text + " " + full_html
                    
                    # Code extrahieren
                    codes = re.findall(r'\b(\d{4,8})\b', full_content)
                    if codes:
                        # Filter: nur sinnvolle Codes (4-6 stellig)
                        codes_filtered = [c for c in codes if 4 <= len(c) <= 6]
                        if codes_filtered:
                            verification_code = codes_filtered[0]
                            print(f"    Code: {verification_code}")
                    
                    # Link extrahieren
                    links = re.findall(r'https?://[^\s<>"\']+', full_html)
                    for link in links:
                        if "pixverse" in link.lower() and ("verify" in link.lower() or "confirm" in link.lower() or "activate" in link.lower()):
                            verification_link = link
                            print(f"    Link: {link[:80]}")
                            break
                    
                    break
                
                await asyncio.sleep(5)
                if i % 6 == 5:
                    print(f"    ... noch nichts ({(i+1)*5}s)")
            
            # Verifizieren
            if verification_link:
                print(f"\n[7] Öffne Verifizierungslink...")
                await page.goto(verification_link, wait_until="load")
                await asyncio.sleep(5)
                print(f"    URL: {page.url}")
                
                if "register" not in page.url.lower():
                    result["success"] = True
                    print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
            
            elif verification_code:
                print(f"\n[7] Gebe Code ein: {verification_code}")
                code_inputs = []
                all_inps = await page.query_selector_all("input")
                for inp in all_inps:
                    if await inp.is_visible():
                        code_inputs.append(inp)
                
                if len(code_inputs) >= len(verification_code):
                    for idx, digit in enumerate(verification_code):
                        await code_inputs[idx].fill(digit)
                        await asyncio.sleep(0.2)
                    
                    await asyncio.sleep(3)
                    if "register" not in page.url.lower():
                        result["success"] = True
                        print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
            
            else:
                print("\n    [⚠️] Keine Verifizierung empfangen")
            
            # Warte
            print("\n    Warte 10s vor Beenden...")
            await asyncio.sleep(10)
            
        except Exception as e:
            print(f"\n[FEHLER] {e}")
            result["error"] = str(e)
        
        finally:
            await browser.close()
    
    # Ergebnis speichern
    with open("pixverse_account.json", "w") as f:
        json.dump(result, f, indent=2)
    
    print("\n" + "=" * 70)
    print("ERGEBNIS")
    print("=" * 70)
    print(f"E-Mail: {temp_email}")
    print(f"Username: {username}")
    print(f"Passwort: {password}")
    print(f"Erfolgreich: {result['success']}")
    print(f"\nGespeichert in: pixverse_account.json")


if __name__ == "__main__":
    asyncio.run(main())
