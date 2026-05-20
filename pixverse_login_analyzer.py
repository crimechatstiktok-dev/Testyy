#!/usr/bin/env python3
"""
PixVerse AI Login Analyzer
Analysiert die Login-Seite und zeigt alle verfügbaren Optionen.
"""

import asyncio
import json
from datetime import datetime
from playwright.async_api import async_playwright


async def analyze_login_page():
    """Analysiert die PixVerse Login-Seite detailliert"""
    
    print("=" * 70)
    print("PixVerse AI Login Analyzer")
    print("=" * 70)
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1400, "height": 900},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        )
        page = await context.new_page()
        
        analysis = {
            "timestamp": datetime.now().isoformat(),
            "url": None,
            "title": None,
            "forms": [],
            "inputs": [],
            "buttons": [],
            "oauth_options": [],
            "email_login_available": False,
            "page_text_snippets": []
        }
        
        try:
            # 1. Direkt zur Login-Seite
            print("\n[→] Navigiere zu Login-Seite...")
            await page.goto("https://app.pixverse.ai/login", wait_until="load", timeout=60000)
            
            analysis["url"] = page.url
            analysis["title"] = await page.title()
            print(f"[✓] URL: {page.url}")
            print(f"[✓] Titel: {analysis['title']}")
            
            await page.screenshot(path="/projects/sandbox/Testyy/analyzer_01_login_page.png")
            
            # 2. Gesamten Seiteninhalt analysieren
            print("\n" + "=" * 70)
            print("SEITEN-ANALYSE")
            print("=" * 70)
            
            page_info = await page.evaluate("""() => {
                return {
                    // Alle Inputs
                    inputs: Array.from(document.querySelectorAll('input')).map(i => ({
                        type: i.type,
                        name: i.name,
                        placeholder: i.placeholder,
                        id: i.id,
                        className: i.className.substring(0, 50),
                        visible: i.offsetParent !== null
                    })),
                    
                    // Alle Buttons mit Text
                    buttons: Array.from(document.querySelectorAll('button')).map(b => ({
                        text: b.innerText.trim().substring(0, 50),
                        type: b.type,
                        className: b.className.substring(0, 50)
                    })).filter(b => b.text),
                    
                    // Alle Links
                    links: Array.from(document.querySelectorAll('a')).map(a => ({
                        text: a.innerText.trim().substring(0, 30),
                        href: a.href
                    })).filter(l => l.text),
                    
                    // Sichtbarer Text (gekürzt)
                    visibleText: document.body.innerText.substring(0, 2000),
                    
                    // OAuth-Indikatoren
                    hasGoogle: document.body.innerText.toLowerCase().includes('google'),
                    hasApple: document.body.innerText.toLowerCase().includes('apple'),
                    hasDiscord: document.body.innerText.toLowerCase().includes('discord'),
                    hasFacebook: document.body.innerText.toLowerCase().includes('facebook'),
                    hasTwitter: document.body.innerText.toLowerCase().includes('twitter'),
                    hasGithub: document.body.innerText.toLowerCase().includes('github'),
                    
                    // E-Mail-Login Indikator
                    hasEmailInput: !!document.querySelector('input[type="email"], input[placeholder*="email" i]'),
                    
                    // Forms
                    forms: Array.from(document.querySelectorAll('form')).map(f => ({
                        action: f.action,
                        method: f.method,
                        id: f.id
                    }))
                };
            }""")
            
            # 3. Ergebnisse anzeigen
            print("\n[INPUTS]")
            visible_inputs = [i for i in page_info["inputs"] if i["visible"]]
            for inp in visible_inputs:
                print(f"  - type={inp['type']}, placeholder={inp['placeholder']}, name={inp['name']}")
                if inp["type"] == "email" or "email" in (inp["placeholder"] or "").lower():
                    analysis["email_login_available"] = True
            
            analysis["inputs"] = visible_inputs
            
            print("\n[BUTTONS]")
            for btn in page_info["buttons"][:15]:
                print(f"  - \"{btn['text']}\" (type={btn['type']})")
            
            analysis["buttons"] = page_info["buttons"]
            
            print("\n[OAUTH OPTIONEN]")
            oauth_map = {
                "Google": page_info["hasGoogle"],
                "Apple": page_info["hasApple"],
                "Discord": page_info["hasDiscord"],
                "Facebook": page_info["hasFacebook"],
                "Twitter": page_info["hasTwitter"],
                "GitHub": page_info["hasGithub"]
            }
            
            for provider, available in oauth_map.items():
                if available:
                    analysis["oauth_options"].append(provider)
                    print(f"  ✓ {provider}")
            
            print("\n[E-MAIL LOGIN]")
            if page_info["hasEmailInput"]:
                print("  ✓ E-Mail-Input vorhanden")
                analysis["email_login_available"] = True
            else:
                print("  ✗ Kein E-Mail-Input gefunden")
            
            print("\n[FORMS]")
            for form in page_info["forms"]:
                print(f"  - action={form['action']}, method={form['method']}")
            
            analysis["forms"] = page_info["forms"]
            
            # 4. Wichtige Text-Snippets
            print("\n[WICHTIGE TEXT-INHALTE]")
            text = page_info["visibleText"]
            
            # Suche nach relevanten Schlüsselwörtern
            keywords = ["login", "sign", "email", "password", "verify", "code", "continue", "register"]
            relevant_lines = []
            
            for line in text.split("\n"):
                line = line.strip()
                if line and any(kw in line.lower() for kw in keywords):
                    relevant_lines.append(line[:100])
            
            for line in relevant_lines[:10]:
                print(f"  > {line}")
            
            analysis["page_text_snippets"] = relevant_lines[:10]
            
            # 5. Screenshots von verschiedenen Zuständen
            print("\n[→] Teste Interaktionen...")
            
            # Versuche E-Mail-Input zu finden
            email_input = await page.query_selector("input[type='email'], input[placeholder*='email' i]")
            
            if email_input:
                print("[✓] E-Mail-Input gefunden - teste mit Test-E-Mail")
                await email_input.fill("test@example.com")
                await asyncio.sleep(1)
                await page.screenshot(path="/projects/sandbox/Testyy/analyzer_02_email_entered.png")
                
                # Suche und klicke Continue/Next Button
                continue_btns = await page.query_selector_all("button")
                for btn in continue_btns:
                    text = await btn.inner_text()
                    if any(kw in text.lower() for kw in ["continue", "next", "send", "submit"]):
                        print(f"[→] Klicke '{text.strip()}'")
                        await btn.click()
                        await asyncio.sleep(3)
                        await page.screenshot(path="/projects/sandbox/Testyy/analyzer_03_after_click.png")
                        break
                
                # Prüfe was passiert ist
                await asyncio.sleep(2)
                current_text = await page.evaluate("() => document.body.innerText")
                
                if "invalid" in current_text.lower() or "error" in current_text.lower():
                    print("[INFO] Validierungsfehler erkannt")
                elif "code" in current_text.lower() or "verify" in current_text.lower():
                    print("[INFO] Verifizierungs-Seite erkannt")
                elif "password" in current_text.lower():
                    print("[INFO] Passwort-Eingabe erwartet")
                
                await page.screenshot(path="/projects/sandbox/Testyy/analyzer_04_final.png")
            
            # 6. Cookies und Storage
            cookies = await context.cookies()
            print(f"\n[COOKIES] {len(cookies)} gesetzt")
            analysis["cookies_count"] = len(cookies)
            
            # Ergebnis speichern
            result_path = "/projects/sandbox/Testyy/login_analysis.json"
            with open(result_path, "w", encoding="utf-8") as f:
                json.dump(analysis, f, indent=2, ensure_ascii=False)
            
            print("\n" + "=" * 70)
            print("ZUSAMMENFASSUNG")
            print("=" * 70)
            print(f"E-Mail Login möglich: {analysis['email_login_available']}")
            print(f"OAuth Optionen: {', '.join(analysis['oauth_options']) if analysis['oauth_options'] else 'Keine'}")
            print(f"Inputs gefunden: {len(analysis['inputs'])}")
            print(f"Buttons gefunden: {len(analysis['buttons'])}")
            print(f"\nAnalyse gespeichert: {result_path}")
            print(f"Screenshots: analyzer_01-04.png")
            
            return analysis
            
        except Exception as e:
            print(f"\n[✗] Fehler: {e}")
            await page.screenshot(path="/projects/sandbox/Testyy/analyzer_error.png")
            return {"error": str(e)}
        
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(analyze_login_page())
