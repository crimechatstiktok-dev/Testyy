#!/usr/bin/env python3
"""
PixVerse Registrierung - mit SeleniumBase UC Mode
==================================================
SeleniumBase UC Mode ist DER Industrie-Standard für Cloudflare-Bypass.
Es ist speziell darauf ausgelegt, Cloudflare Turnstile zu umgehen.

INSTALLATION:
    pip install seleniumbase aiohttp requests

AUSFÜHRUNG:
    python pixverse_seleniumbase.py
"""

import time
import re
import random
import string
import json
import os
from datetime import datetime
import requests

try:
    from seleniumbase import Driver
except ImportError:
    print("FEHLER: seleniumbase nicht installiert!")
    print("Installation: pip install seleniumbase")
    exit(1)


# =====================================================================
# mail.tm API Client (synchron)
# =====================================================================
class MailTM:
    def __init__(self):
        self.base_url = "https://api.mail.tm"
        self.email = None
        self.password = None
        self.token = None
    
    def create_account(self):
        # Domain holen
        r = requests.get(f"{self.base_url}/domains")
        domain = r.json()["hydra:member"][0]["domain"]
        
        # Account erstellen
        user = ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
        self.email = f"{user}@{domain}"
        self.password = ''.join(random.choices(string.ascii_letters + string.digits, k=12))
        
        r = requests.post(
            f"{self.base_url}/accounts",
            json={"address": self.email, "password": self.password}
        )
        if r.status_code != 201:
            return None
        
        # Token holen
        r = requests.post(
            f"{self.base_url}/token",
            json={"address": self.email, "password": self.password}
        )
        self.token = r.json().get("token")
        return self.email
    
    def get_messages(self):
        r = requests.get(
            f"{self.base_url}/messages",
            headers={"Authorization": f"Bearer {self.token}"}
        )
        return r.json().get("hydra:member", [])
    
    def get_message(self, msg_id):
        r = requests.get(
            f"{self.base_url}/messages/{msg_id}",
            headers={"Authorization": f"Bearer {self.token}"}
        )
        return r.json()


def main():
    print("=" * 70)
    print("PixVerse Registrierung mit SeleniumBase UC Mode")
    print("=" * 70)
    
    # E-Mail
    print("\n[1] Erstelle temporäre E-Mail (mail.tm)...")
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
    
    result = {
        "timestamp": datetime.now().isoformat(),
        "email": temp_email,
        "username": username,
        "password": password,
        "success": False
    }
    
    # =====================================================================
    # SeleniumBase UC Mode - speziell für Cloudflare!
    # =====================================================================
    print("\n[2] Starte Browser im UC Mode (Anti-Cloudflare)...")
    
    driver = Driver(
        uc=True,                # Undetected Chrome Mode (KRITISCH!)
        headed=True,            # Sichtbarer Browser
        headless=False,
        locale_code="de",
        # User Data Dir für persistentes Profil
        user_data_dir=os.path.abspath("./pixverse_uc_profile"),
    )
    
    try:
        # uc_open_with_reconnect umgeht Cloudflare automatisch
        print("\n[3] Öffne PixVerse Register (mit UC Reconnect)...")
        url = "https://app.pixverse.ai/register"
        
        # Diese Methode wartet automatisch auf Cloudflare und reconnected
        # Parameter: URL, reconnect_time (in Sekunden)
        driver.uc_open_with_reconnect(url, reconnect_time=6)
        
        time.sleep(3)
        
        # Falls Cloudflare-Captcha sichtbar - automatisch klicken!
        print("\n[4] Falls Captcha sichtbar - UC Mode klickt automatisch...")
        try:
            driver.uc_gui_click_captcha()
            print("    [✓] Captcha-Klick versucht")
        except Exception as e:
            print(f"    [INFO] Kein Captcha sichtbar oder bereits gelöst: {e}")
        
        time.sleep(3)
        
        # Formular ausfüllen
        print("\n[5] Fülle Formular aus...")
        
        # Username
        try:
            driver.type('input[placeholder*="Benutzer" i], input[placeholder*="ername" i]', username)
            print(f"    [✓] Username: {username}")
        except:
            # Fallback: erstes Text-Input
            inputs = driver.find_elements("css selector", 'input[type="text"]')
            if inputs:
                inputs[0].send_keys(username)
                print(f"    [✓] Username (Fallback): {username}")
        
        time.sleep(random.uniform(0.5, 1.0))
        
        # E-Mail
        try:
            driver.type('input[placeholder*="ail" i]', temp_email)
            print(f"    [✓] E-Mail: {temp_email}")
        except:
            inputs = driver.find_elements("css selector", 'input[type="text"]')
            if len(inputs) >= 2:
                inputs[1].send_keys(temp_email)
                print(f"    [✓] E-Mail (Fallback): {temp_email}")
        
        time.sleep(random.uniform(0.5, 1.0))
        
        # Passwort (2 Felder)
        pwd_inputs = driver.find_elements("css selector", 'input[type="password"]')
        if len(pwd_inputs) >= 2:
            pwd_inputs[0].send_keys(password)
            time.sleep(random.uniform(0.3, 0.7))
            pwd_inputs[1].send_keys(password)
            print(f"    [✓] Passwort: {password}")
        
        time.sleep(2)
        
        # Versuche Captcha nochmal automatisch zu lösen
        print("\n[6] UC Mode - Captcha-Bypass...")
        try:
            driver.uc_gui_click_captcha()
            print("    [✓] Captcha-Klick erfolgt")
        except Exception as e:
            print(f"    [INFO] {e}")
        
        # Warte auf Turnstile-Token
        print("\n[7] Warte auf Turnstile-Token...")
        for i in range(30):
            try:
                token = driver.execute_script("""
                    const inp = document.querySelector('input[name="cf-turnstile-response"]');
                    return inp ? inp.value : null;
                """)
                if token and len(str(token)) > 10:
                    print(f"    [✓] Token erhalten nach {i*2}s!")
                    break
            except:
                pass
            
            if i % 5 == 4:
                print(f"    ... warte ({(i+1)*2}s)")
            time.sleep(2)
        
        # Continue klicken
        print("\n[8] Klicke Continue/Weiter...")
        time.sleep(1)
        try:
            # Erst Englisch versuchen, dann Deutsch
            try:
                driver.click('button:contains("Continue")')
            except:
                driver.click('button:contains("Weiter")')
            print("    [✓] Geklickt")
        except Exception as e:
            print(f"    [WARN] {e}")
            # Fallback: alle Buttons durchgehen
            buttons = driver.find_elements("css selector", "button")
            for btn in buttons:
                try:
                    text = btn.text.strip()
                    if text in ["Continue", "Weiter"]:
                        btn.click()
                        print(f"    [✓] Button '{text}' geklickt")
                        break
                except:
                    continue
        
        time.sleep(5)
        print(f"    URL: {driver.current_url}")
        
        # Auf E-Mail warten
        print("\n[9] Warte auf Verifizierungs-E-Mail (3 Min)...")
        verification_code = None
        verification_link = None
        
        for i in range(36):
            messages = mail.get_messages()
            if messages:
                print(f"\n    [✓] E-Mail empfangen!")
                msg = messages[0]
                print(f"    Von: {msg.get('from', {}).get('address')}")
                print(f"    Betreff: {msg.get('subject')}")
                
                detail = mail.get_message(msg["id"])
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
            
            time.sleep(5)
            if i % 6 == 5:
                print(f"    ... {(i+1)*5}s")
        
        # Verifizieren
        if verification_link:
            print(f"\n[10] Öffne Verifizierungslink...")
            driver.get(verification_link)
            time.sleep(5)
            if "register" not in driver.current_url.lower():
                result["success"] = True
                print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
        elif verification_code:
            print(f"\n[10] Gebe Code ein: {verification_code}")
            inputs = driver.find_elements("css selector", "input")
            visible_inps = [i for i in inputs if i.is_displayed()]
            if len(visible_inps) >= len(verification_code):
                for idx, d in enumerate(verification_code):
                    visible_inps[idx].send_keys(d)
                    time.sleep(0.2)
            time.sleep(3)
            if "register" not in driver.current_url.lower():
                result["success"] = True
                print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
        
        print("\n    Browser bleibt 30s offen...")
        time.sleep(30)
        
    except Exception as e:
        print(f"\n[FEHLER] {e}")
        import traceback
        traceback.print_exc()
        result["error"] = str(e)
    
    finally:
        try:
            driver.quit()
        except:
            pass
    
    with open("pixverse_account.json", "w") as f:
        json.dump(result, f, indent=2)
    
    print("\n" + "=" * 70)
    print("ERGEBNIS")
    print("=" * 70)
    print(f"E-Mail: {temp_email}")
    print(f"Username: {username}")
    print(f"Passwort: {password}")
    print(f"Erfolgreich: {result['success']}")


if __name__ == "__main__":
    main()
