#!/usr/bin/env python3
"""
PixVerse AI Login Page Scraper & Analyzer
Analysiert die Login-Seite von PixVerse AI und extrahiert wichtige Informationen.
"""

import asyncio
import json
from datetime import datetime
from playwright.async_api import async_playwright


async def scrape_pixverse_login():
    """
    Scrapt und analysiert die PixVerse AI Login-Seite.
    """
    print("=" * 60)
    print("PixVerse AI Login Page Scraper & Analyzer")
    print("=" * 60)
    print()
    
    async with async_playwright() as p:
        # Browser starten (sichtbar für Debugging)
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        
        # Ergebnis-Dictionary
        result = {
            "timestamp": datetime.now().isoformat(),
            "url": None,
            "title": None,
            "forms": [],
            "inputs": [],
            "buttons": [],
            "links": [],
            "scripts": [],
            "meta_tags": [],
            "api_endpoints": [],
            "oauth_providers": [],
            "cookies": []
        }
        
        try:
            # Zur Login-Seite navigieren
            login_url = "https://app.pixverse.ai"
            print(f"[→] Navigiere zu: {login_url}")
            
            await page.goto(login_url, wait_until="networkidle", timeout=30000)
            result["url"] = page.url
            
            print(f"[✓] Aktuelle URL: {page.url}")
            print()
            
            # Seiten-Titel
            title = await page.title()
            result["title"] = title
            print(f"[INFO] Seitentitel: {title}")
            print()
            
            # ============================================
            # 1. FORMULARE ANALYSIEREN
            # ============================================
            print("=" * 60)
            print("1. FORMULARE")
            print("=" * 60)
            
            forms = await page.query_selector_all("form")
            for i, form in enumerate(forms):
                form_info = {
                    "index": i,
                    "action": await form.get_attribute("action"),
                    "method": await form.get_attribute("method"),
                    "id": await form.get_attribute("id"),
                    "class": await form.get_attribute("class")
                }
                result["forms"].append(form_info)
                print(f"  Form {i}: action={form_info['action']}, method={form_info['method']}")
            
            if not forms:
                print("  Keine <form> Elemente gefunden (möglicherweise JavaScript-basiertes Login)")
            print()
            
            # ============================================
            # 2. INPUT-FELDER ANALYSIEREN
            # ============================================
            print("=" * 60)
            print("2. INPUT-FELDER")
            print("=" * 60)
            
            inputs = await page.query_selector_all("input")
            for i, input_el in enumerate(inputs):
                input_info = {
                    "index": i,
                    "type": await input_el.get_attribute("type"),
                    "name": await input_el.get_attribute("name"),
                    "id": await input_el.get_attribute("id"),
                    "placeholder": await input_el.get_attribute("placeholder"),
                    "required": await input_el.get_attribute("required")
                }
                result["inputs"].append(input_info)
                print(f"  Input {i}: type={input_info['type']}, name={input_info['name']}, placeholder={input_info['placeholder']}")
            print()
            
            # ============================================
            # 3. BUTTONS ANALYSIEREN
            # ============================================
            print("=" * 60)
            print("3. BUTTONS")
            print("=" * 60)
            
            buttons = await page.query_selector_all("button, input[type='submit'], input[type='button']")
            for i, btn in enumerate(buttons):
                btn_text = await btn.inner_text() if await btn.evaluate("el => el.tagName") != "INPUT" else await btn.get_attribute("value")
                btn_info = {
                    "index": i,
                    "text": btn_text,
                    "type": await btn.get_attribute("type"),
                    "id": await btn.get_attribute("id"),
                    "class": await btn.get_attribute("class")
                }
                result["buttons"].append(btn_info)
                print(f"  Button {i}: text=\"{btn_info['text']}\", type={btn_info['type']}")
            print()
            
            # ============================================
            # 4. LINKS ANALYSIEREN (Login/Registrierung)
            # ============================================
            print("=" * 60)
            print("4. WICHTIGE LINKS")
            print("=" * 60)
            
            links = await page.query_selector_all("a")
            for link in links:
                href = await link.get_attribute("href")
                text = await link.inner_text()
                if href and any(keyword in href.lower() or keyword in text.lower() 
                               for keyword in ["login", "sign", "auth", "register", "oauth"]):
                    link_info = {
                        "href": href,
                        "text": text.strip()
                    }
                    result["links"].append(link_info)
                    print(f"  Link: \"{text.strip()}\" -> {href}")
            print()
            
            # ============================================
            # 5. OAUTH PROVIDER ERKENNEN
            # ============================================
            print("=" * 60)
            print("5. OAUTH / SOCIAL LOGIN PROVIDER")
            print("=" * 60)
            
            # Suche nach OAuth-Buttons
            page_content = await page.content()
            oauth_keywords = ["google", "github", "apple", "facebook", "twitter", "discord", "microsoft"]
            
            for provider in oauth_keywords:
                if provider.lower() in page_content.lower():
                    result["oauth_providers"].append(provider.title())
                    print(f"  [✓] {provider.title()} Login erkannt")
            print()
            
            # ============================================
            # 6. API ENDPOINTS AUS JAVASCRIPT EXTRAHIEREN
            # ============================================
            print("=" * 60)
            print("6. API ENDPOINTS")
            print("=" * 60)
            
            scripts = await page.query_selector_all("script")
            for script in scripts:
                script_content = await script.inner_text()
                if script_content:
                    # Suche nach API-URLs
                    import re
                    api_patterns = [
                        r'https?://[^\s"\']+api[^\s"\']*',
                        r'https?://[^\s"\']+auth[^\s"\']*',
                        r'/api/[^\s"\']+',
                        r'https?://app-api\.pixverse\.ai[^\s"\']*'
                    ]
                    for pattern in api_patterns:
                        matches = re.findall(pattern, script_content)
                        for match in matches:
                            if match not in result["api_endpoints"]:
                                result["api_endpoints"].append(match)
                                print(f"  API: {match}")
            print()
            
            # ============================================
            # 7. META TAGS
            # ============================================
            print("=" * 60)
            print("7. META TAGS")
            print("=" * 60)
            
            meta_tags = await page.query_selector_all("meta")
            for meta in meta_tags[:10]:  # Nur die ersten 10
                name = await meta.get_attribute("name") or await meta.get_attribute("property")
                content = await meta.get_attribute("content")
                if name and content:
                    meta_info = {"name": name, "content": content[:100]}
                    result["meta_tags"].append(meta_info)
                    print(f"  {name}: {content[:100]}")
            print()
            
            # ============================================
            # 8. COOKIES
            # ============================================
            print("=" * 60)
            print("8. COOKIES")
            print("=" * 60)
            
            cookies = await context.cookies()
            for cookie in cookies:
                result["cookies"].append({
                    "name": cookie["name"],
                    "domain": cookie["domain"],
                    "path": cookie["path"]
                })
                print(f"  {cookie['name']}: {cookie['domain']}")
            print()
            
            # ============================================
            # SCREENSHOT SPEICHERN
            # ============================================
            screenshot_path = "/projects/sandbox/Testyy/pixverse_login_screenshot.png"
            await page.screenshot(path=screenshot_path, full_page=True)
            print(f"[✓] Screenshot gespeichert: {screenshot_path}")
            print()
            
            # ============================================
            # ERGEBNIS ALS JSON SPEICHERN
            # ============================================
            result_path = "/projects/sandbox/Testyy/pixverse_analysis.json"
            with open(result_path, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
            print(f"[✓] Analyse gespeichert: {result_path}")
            print()
            
            # ============================================
            # ZUSAMMENFASSUNG
            # ============================================
            print("=" * 60)
            print("ZUSAMMENFASSUNG")
            print("=" * 60)
            print(f"URL: {result['url']}")
            print(f"Titel: {result['title']}")
            print(f"Formulare: {len(result['forms'])}")
            print(f"Input-Felder: {len(result['inputs'])}")
            print(f"Buttons: {len(result['buttons'])}")
            print(f"OAuth Provider: {', '.join(result['oauth_providers']) if result['oauth_providers'] else 'Keine erkannt'}")
            print(f"API Endpoints: {len(result['api_endpoints'])}")
            print(f"Cookies: {len(result['cookies'])}")
            print()
            
            # Kurze Pause um die Seite zu betrachten
            print("[i] Browser bleibt für 5 Sekunden offen...")
            await asyncio.sleep(5)
            
        except Exception as e:
            print(f"[✗] Fehler: {e}")
            result["error"] = str(e)
        
        finally:
            await browser.close()
            print("[✓] Browser geschlossen")
    
    return result


if __name__ == "__main__":
    result = asyncio.run(scrape_pixverse_login())
