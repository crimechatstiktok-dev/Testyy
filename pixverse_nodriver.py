#!/usr/bin/env python3
"""
PixVerse AI Registrierung - mit nodriver (echter Browser, kein Test-Chromium)
==============================================================================

nodriver ist der professionelle Anti-Detection-Browser, der speziell dafür
gebaut ist, Cloudflare und Turnstile zu umgehen. Er nutzt das echte Chrome
(nicht Playwright-Chromium!) und ist nicht als Bot erkennbar.

INSTALLATION:
    pip install nodriver aiohttp

AUSFÜHRUNG:
    python pixverse_nodriver.py

Das Skript verwendet dein installiertes Google Chrome mit eigenem Profil.
Dein normales Chrome bleibt offen!
"""

import asyncio
import re
import random
import string
import json
import os
from datetime import datetime
import aiohttp

try:
    import nodriver as uc
except ImportError:
    print("FEHLER: nodriver nicht installiert!")
    print("Bitte installieren mit: pip install nodriver")
    exit(1)


# =====================================================================
# mail.tm API (für temporäre E-Mail)
# =====================================================================
class MailTM:
    def __init__(self):
        self.base_url = "https://api.mail.tm"
        self.email = None
        self.password = None
        self.token = None
    
    async def create_account(self):
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{self.base_url}/domains") as r:
                domains = (await r.json())["hydra:member"]
                domain = domains[0]["domain"]
            
            user = ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
            self.email = f"{user}@{domain}"
            self.password = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
            
            async with session.post(
                f"{self.base_url}/accounts",
                json={"address": self.email, "password": self.password}
            ) as r:
                if r.status != 201:
                    return None
            
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


# =====================================================================
# Cloudflare Turnstile lösen (mit nodriver einfacher!)
# =====================================================================
async def solve_turnstile(tab):
    """Mit nodriver löst sich Turnstile meist passiv. Wenn nicht: klicken."""
    print("    [Turnstile] Warte auf passive Lösung...")
    
    # Phase 1: Warte ob Turnstile sich passiv löst (bei nodriver oft der Fall!)
    for i in range(30):
        try:
            token = await tab.evaluate("""
                (() => {
                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                    return inp ? inp.value : null;
                })()
            """)
            
            if token and len(str(token)) > 10:
                print(f"    [✓] Turnstile passiv gelöst nach {i*2}s!")
                return True
        except Exception as e:
            pass
        
        if i % 5 == 4:
            print(f"    ... warte ({(i+1)*2}s)")
        
        await asyncio.sleep(2)
    
    # Phase 2: Falls nicht passiv - klicke aufs Widget
    print("    [Turnstile] Versuche zu klicken...")
    
    try:
        # Position des Widgets ermitteln
        pos = await tab.evaluate("""
            (() => {
                const el = document.querySelector('#cfcaptcha');
                if (el) {
                    const rect = el.getBoundingClientRect();
                    return {x: rect.x + 30, y: rect.y + rect.height / 2};
                }
                return null;
            })()
        """)
        
        if pos:
            print(f"    [✓] Klicke auf ({pos['x']:.0f}, {pos['y']:.0f})")
            # nodriver hat eigene Mausbewegung
            await tab.mouse_click(pos['x'], pos['y'])
            await asyncio.sleep(3)
    except Exception as e:
        print(f"    [WARN] Klick-Fehler: {e}")
    
    # Phase 3: Erneut warten
    for i in range(30):
        try:
            token = await tab.evaluate("""
                (() => {
                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                    return inp ? inp.value : null;
                })()
            """)
            if token and len(str(token)) > 10:
                print(f"    [✓] Token nach Klick erhalten ({i*2}s)!")
                return True
        except:
            pass
        
        await asyncio.sleep(2)
    
    return False


# =====================================================================
# Hauptprogramm
# =====================================================================
async def main():
    print("=" * 70)
    print("PixVerse Registrierung - mit nodriver (echter Browser)")
    print("=" * 70)
    
    # E-Mail erstellen
    print("\n[1] Erstelle temporäre E-Mail (mail.tm)...")
    mail = MailTM()
    temp_email = await mail.create_account()
    if not temp_email:
        print("    [FEHLER]")
        return
    print(f"    E-Mail: {temp_email}")
    
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
    
    # Profil-Verzeichnis (dein normales Chrome bleibt offen!)
    profile_dir = os.path.abspath("./pixverse_chrome_profile")
    os.makedirs(profile_dir, exist_ok=True)
    print(f"\n[2] Browser-Profil: {profile_dir}")
    print("    (Dein normales Chrome bleibt offen!)")
    
    # =====================================================================
    # Browser mit nodriver starten - nicht erkennbar als Bot!
    # =====================================================================
    print("\n[3] Starte echtes Chrome (anti-detection)...")
    
    browser = await uc.start(
        user_data_dir=profile_dir,
        headless=False,
        lang="de-DE",
        # nodriver findet automatisch das installierte Chrome
        browser_args=[
            "--window-size=1920,1080",
            "--disable-blink-features=AutomationControlled",
            "--lang=de-DE",
        ]
    )
    
    try:
        # Zur Register-Seite
        print("\n[4] Öffne PixVerse Register...")
        tab = await browser.get("https://app.pixverse.ai/register")
        await asyncio.sleep(5)
        
        # Fingerprint überprüfen
        print("\n[5] Browser-Check...")
        check = await tab.evaluate("""
            (() => ({
                ua: navigator.userAgent,
                webdriver: navigator.webdriver,
                chrome: !!window.chrome,
                cdc: Object.keys(window).filter(k => k.includes('cdc')).length
            }))()
        """)
        if isinstance(check, dict):
            print(f"    UserAgent: {check.get('ua', 'N/A')[:60]}...")
            print(f"    webdriver: {check.get('webdriver')} (sollte undefined sein!)")
            print(f"    Chrome-Objekt: {check.get('chrome')}")
            print(f"    CDC-Detection: {check.get('cdc')} (sollte 0 sein!)")
        
        # Formular ausfüllen
        print("\n[6] Fülle Formular aus...")
        
        # Username eingeben
        username_input = await tab.find('input[placeholder*="ername" i]', best_match=True)
        if username_input:
            await username_input.click()
            await asyncio.sleep(0.5)
            await username_input.send_keys(username)
            print(f"    [✓] Username: {username}")
        
        await asyncio.sleep(random.uniform(0.5, 1.0))
        
        # E-Mail eingeben
        email_input = await tab.find('input[placeholder*="ail" i]', best_match=True)
        if email_input:
            await email_input.click()
            await asyncio.sleep(0.5)
            await email_input.send_keys(temp_email)
            print(f"    [✓] E-Mail: {temp_email}")
        
        await asyncio.sleep(random.uniform(0.5, 1.0))
        
        # Passwort-Felder finden (es gibt 2)
        pwd_inputs = await tab.find_all('input[type="password"]')
        if len(pwd_inputs) >= 2:
            await pwd_inputs[0].click()
            await asyncio.sleep(0.3)
            await pwd_inputs[0].send_keys(password)
            
            await asyncio.sleep(random.uniform(0.5, 1.0))
            
            await pwd_inputs[1].click()
            await asyncio.sleep(0.3)
            await pwd_inputs[1].send_keys(password)
            print(f"    [✓] Passwort: {password}")
        
        await asyncio.sleep(2)
        
        # Turnstile lösen
        print("\n[7] Cloudflare Turnstile...")
        solved = await solve_turnstile(tab)
        
        if not solved:
            print("    [⚠️] Wenn Captcha sichtbar ist - klicke es bitte!")
            print("    (Sonst Enter drücken zum Weitermachen)")
            try:
                input("    Enter drücken: ")
            except:
                pass
        
        # Continue/Weiter klicken
        print("\n[8] Klicke Continue/Weiter...")
        await asyncio.sleep(1)
        
        try:
            # Suche Continue-Button (Englisch oder Deutsch)
            btn = await tab.find("Continue", best_match=True)
            if not btn:
                btn = await tab.find("Weiter", best_match=True)
            
            if btn:
                await btn.click()
                print("    [✓] Geklickt")
        except Exception as e:
            print(f"    [WARN] {e}")
        
        await asyncio.sleep(5)
        current_url = await tab.evaluate("window.location.href")
        print(f"    URL: {current_url}")
        
        # Auf E-Mail warten
        print("\n[9] Warte auf Verifizierungs-E-Mail (3 Min)...")
        verification_code = None
        verification_link = None
        
        for i in range(36):
            messages = await mail.get_messages()
            if messages:
                print(f"\n    [✓] E-Mail empfangen!")
                msg = messages[0]
                print(f"    Von: {msg.get('from', {}).get('address')}")
                print(f"    Betreff: {msg.get('subject')}")
                
                detail = await mail.get_message(msg["id"])
                text = detail.get("text", "")
                html_data = detail.get("html", [])
                full_html = " ".join(html_data) if isinstance(html_data, list) else str(html_data)
                full_content = text + " " + full_html
                
                codes = re.findall(r'\b(\d{4,8})\b', full_content)
                codes_filt = [c for c in codes if 4 <= len(c) <= 6]
                if codes_filt:
                    verification_code = codes_filt[0]
                    print(f"    Code: {verification_code}")
                
                links = re.findall(r'https?://[^\s<>"\']+', full_html)
                for link in links:
                    if "pixverse" in link.lower() and any(k in link.lower() for k in ["verify", "confirm", "activate"]):
                        verification_link = link
                        print(f"    Link: {link[:80]}")
                        break
                break
            
            await asyncio.sleep(5)
            if i % 6 == 5:
                print(f"    ... {(i+1)*5}s")
        
        # Verifizieren
        if verification_link:
            print(f"\n[10] Öffne Verifizierungslink...")
            await tab.get(verification_link)
            await asyncio.sleep(5)
            url_after = await tab.evaluate("window.location.href")
            if "register" not in url_after.lower():
                result["success"] = True
                print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
        elif verification_code:
            print(f"\n[10] Gebe Code ein: {verification_code}")
            try:
                # Versuche Code-Inputs zu finden
                inputs_all = await tab.find_all('input')
                visible_inps = []
                for inp in inputs_all:
                    try:
                        if await inp.evaluate("el => el.offsetParent !== null"):
                            visible_inps.append(inp)
                    except:
                        pass
                
                if len(visible_inps) >= len(verification_code):
                    for idx, d in enumerate(verification_code):
                        await visible_inps[idx].send_keys(d)
                        await asyncio.sleep(0.2)
                
                await asyncio.sleep(3)
                url_after = await tab.evaluate("window.location.href")
                if "register" not in url_after.lower():
                    result["success"] = True
                    print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
            except Exception as e:
                print(f"    [WARN] {e}")
        else:
            print("\n    [⚠️] Keine Verifizierung empfangen")
        
        print("\n    Browser bleibt 30s offen, dann schließt automatisch...")
        await asyncio.sleep(30)
        
    except Exception as e:
        print(f"\n[FEHLER] {e}")
        import traceback
        traceback.print_exc()
        result["error"] = str(e)
    
    finally:
        try:
            browser.stop()
        except:
            pass
    
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
    # nodriver braucht eigenen Event-Loop-Style
    uc.loop().run_until_complete(main())
