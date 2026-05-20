#!/usr/bin/env python3
"""
PixVerse AI Registrierung mit txen.de
=====================================

Anleitung:
1. Installiere die Abhängigkeiten: pip install playwright aiohttp
2. Installiere Browser: playwright install chromium
3. Führe das Skript aus: python pixverse_register_local.py
4. Löse die Cloudflare-Challenge manuell im Browser
5. Das Skript übernimmt dann die Registrierung

Dieses Skript sollte LOKAL auf deinem Computer ausgeführt werden,
da txen.de durch Cloudflare geschützt ist und manuelle Interaktion erfordert.
"""

import asyncio
import re
import random
import string
import json
from datetime import datetime
from playwright.async_api import async_playwright


async def main():
    print("=" * 70)
    print("PixVerse AI Registrierung mit txen.de")
    print("=" * 70)
    print("\n⚠️  WICHTIG: Löse die Cloudflare-Challenge manuell im Browser!")
    print()
    
    # Registrierungsdaten
    username = ''.join(random.choices(string.ascii_lowercase, k=8))
    password = "TestPass123!"
    
    result = {
        "timestamp": datetime.now().isoformat(),
        "username": username,
        "password": password,
        "temp_email": None,
        "login_successful": False
    }
    
    async with async_playwright() as p:
        # Browser im SICHTBAREN Modus starten (headless=False)
        browser = await p.chromium.launch(
            headless=False,  # WICHTIG: Sichtbar für manuelle Cloudflare-Lösung
            slow_mo=100
        )
        context = await browser.new_context(
            viewport={"width": 1400, "height": 900},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X_10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        
        # Tab 1: txen.de
        txen_page = await context.new_page()
        
        # Tab 2: PixVerse
        pixverse_page = await context.new_page()
        
        temp_email = None
        
        try:
            # ==========================================
            # SCHRITT 1: txen.de öffnen
            # ==========================================
            print("[1] Öffne txen.de...")
            print("    👉 Bitte löse die Cloudflare-Challenge im Browser!")
            
            await txen_page.goto("https://txen.de/", timeout=60000)
            
            # Warten bis User Cloudflare gelöst hat
            print("    Warte auf E-Mail-Anzeige...")
            print("    (Drücke Enter im Terminal wenn du die E-Mail siehst)")
            
            # E-Mail automatisch erkennen
            for i in range(60):  # 60 Sekunden warten
                content = await txen_page.evaluate("() => document.body.innerText")
                
                # Suche nach E-Mail-Pattern
                email_match = re.search(r'[\w\.-]+@txen\.de', content)
                if email_match:
                    temp_email = email_match.group()
                    print(f"\n    ✅ E-Mail erkannt: {temp_email}")
                    break
                
                # Prüfe Input-Felder
                email_input = await txen_page.query_selector("input[value*='@txen.de']")
                if email_input:
                    temp_email = await email_input.get_attribute("value")
                    print(f"\n    ✅ E-Mail aus Input: {temp_email}")
                    break
                
                await asyncio.sleep(1)
            
            if not temp_email:
                # Fallback: User muss E-Mail eingeben
                print("\n    ⚠️  Keine E-Mail automatisch erkannt.")
                temp_email = input("    Bitte gib die txen.de E-Mail ein: ").strip()
            
            result["temp_email"] = temp_email
            
            # ==========================================
            # SCHRITT 2: PixVerse Registrierung
            # ==========================================
            print(f"\n[2] Öffne PixVerse Registrierung...")
            
            await pixverse_page.goto("https://app.pixverse.ai/register", timeout=30000)
            await asyncio.sleep(2)
            
            print(f"\n[3] Fülle Registrierungsformular aus...")
            
            # Inputs finden und ausfüllen
            inputs = await pixverse_page.query_selector_all("input")
            
            if len(inputs) >= 4:
                # Username
                await inputs[0].click()
                await inputs[0].fill(username)
                print(f"    Username: {username}")
                
                # E-Mail
                await inputs[1].click()
                await inputs[1].fill(temp_email)
                print(f"    E-Mail: {temp_email}")
                
                # Passwort
                await inputs[2].click()
                await inputs[2].fill(password)
                print(f"    Passwort: {password}")
                
                # Passwort bestätigen
                await inputs[3].click()
                await inputs[3].fill(password)
                print(f"    Passwort bestätigt")
            
            print("\n[4] Klicke 'Continue'...")
            
            continue_btn = await pixverse_page.query_selector("button:has-text('Continue')")
            if continue_btn:
                await continue_btn.click()
            
            await asyncio.sleep(5)
            
            # ==========================================
            # SCHRITT 3: Verifizierung
            # ==========================================
            print("\n[5] Prüfe auf Verifizierungs-E-Mail...")
            
            # Zurück zu txen.de
            await txen_page.bring_to_front()
            
            # Auf E-Mail warten
            print("    Warte auf Verifizierungs-E-Mail...")
            print("    (Prüfe den Posteingang auf txen.de)")
            
            verification_code = None
            verification_link = None
            
            for i in range(36):  # 3 Minuten
                # Seite neu laden
                await txen_page.reload(wait_until="load")
                await asyncio.sleep(5)
                
                content = await txen_page.evaluate("() => document.body.innerText")
                
                # Prüfe auf PixVerse E-Mail
                if "pixverse" in content.lower() or "verify" in content.lower():
                    print(f"\n    ✅ Verifizierungs-E-Mail empfangen!")
                    
                    # Code extrahieren
                    codes = re.findall(r'\b(\d{4,8})\b', content)
                    if codes:
                        verification_code = codes[0]
                        print(f"    Code: {verification_code}")
                    
                    # Link extrahieren
                    links = re.findall(r'https?://[^\s<>"\']+', content)
                    for link in links:
                        if "pixverse" in link.lower() or "verify" in link.lower():
                            verification_link = link
                            print(f"    Link: {link[:70]}")
                            break
                    
                    break
                
                if i % 6 == 5:
                    print(f"    ... noch nichts ({(i+1)*5}s)")
            
            # ==========================================
            # SCHRITT 4: Verifizierung durchführen
            # ==========================================
            if verification_link:
                print(f"\n[6] Öffne Verifizierungslink...")
                await pixverse_page.goto(verification_link)
                await asyncio.sleep(5)
                
                print(f"    URL: {pixverse_page.url}")
                
                # Prüfe ob eingeloggt
                if "login" not in pixverse_page.url.lower():
                    result["login_successful"] = True
                    print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
            
            elif verification_code:
                print(f"\n[6] Gebe Verifizierungscode ein...")
                await pixverse_page.bring_to_front()
                
                # Code-Inputs finden
                code_inputs = await pixverse_page.query_selector_all("input")
                if code_inputs:
                    for i, digit in enumerate(verification_code):
                        if i < len(code_inputs):
                            await code_inputs[i].fill(digit)
                    
                    await asyncio.sleep(3)
                    
                    if "login" not in pixverse_page.url.lower():
                        result["login_successful"] = True
                        print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
            
            else:
                print("\n    ⚠️  Keine Verifizierungs-E-Mail empfangen.")
                print("    PixVerse akzeptiert möglicherweise txen.de nicht.")
            
            # ==========================================
            # Ergebnis
            # ==========================================
            await asyncio.sleep(5)
            
            print("\n" + "=" * 70)
            print("ERGEBNIS")
            print("=" * 70)
            print(f"Username: {username}")
            print(f"E-Mail: {temp_email}")
            print(f"Passwort: {password}")
            print(f"Registriert: {'JA' if result['login_successful'] else 'UNBEKANNT'}")
            
            # Warte bevor Browser geschlossen wird
            input("\nDrücke Enter um zu beenden...")
            
        except Exception as e:
            print(f"\n❌ Fehler: {e}")
            input("\nDrücke Enter um zu beenden...")
        
        finally:
            await browser.close()
    
    # Ergebnis speichern
    result_path = "pixverse_registration_result.json"
    with open(result_path, "w") as f:
        json.dump(result, f, indent=2)
    
    print(f"\nErgebnis gespeichert: {result_path}")


if __name__ == "__main__":
    asyncio.run(main())
