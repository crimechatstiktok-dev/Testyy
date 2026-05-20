#!/usr/bin/env python3
"""
PixVerse AI Registrierung - MIT ECHTEM BROWSER-FINGERPRINT
==========================================================

Verwendet den vom User bereitgestellten echten Browser-Fingerprint
(Chrome 148 auf Windows 10, NVIDIA RTX 3050 Ti) um Cloudflare zu umgehen.

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


# =====================================================================
# ECHTER BROWSER-FINGERPRINT (vom User bereitgestellt)
# =====================================================================
FINGERPRINT = {
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "platform": "Win32",
    "language": "de-DE",
    "languages": ["de-DE", "de", "en-US", "en"],
    "timezone": "Europe/Berlin",
    "hardwareConcurrency": 12,
    "deviceMemory": 32,
    "vendor": "Google Inc.",
    "vendorSub": "",
    "product": "Gecko",
    "productSub": "20030107",
    "screen": {
        "width": 1920,
        "height": 1080,
        "availWidth": 1920,
        "availHeight": 1032,
        "colorDepth": 32,
        "pixelDepth": 32,
        "availLeft": 0,
        "availTop": 0
    },
    "viewport": {
        "width": 1920,
        "height": 945  # window.innerHeight
    },
    "outerSize": {
        "width": 1920,
        "height": 1032
    },
    "devicePixelRatio": 1,
    "webgl": {
        "vendor": "Google Inc. (NVIDIA)",
        "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)"
    },
    "secChUa": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "secChUaPlatform": '"Windows"',
    "secChUaMobile": "?0",
    "acceptLanguage": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"
}


# =====================================================================
# Anti-Detection JavaScript - überschreibt Browser-Properties
# =====================================================================
ANTI_DETECTION_SCRIPT = """
(() => {
    // 1. webdriver entfernen (kritisch!)
    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
    
    // 2. Plugins simulieren (5 PDF Viewer)
    const pluginsData = [
        {name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
        {name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
        {name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
        {name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
        {name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format'}
    ];
    
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const plugins = pluginsData.map(p => ({
                name: p.name,
                filename: p.filename,
                description: p.description,
                length: 1
            }));
            plugins.length = pluginsData.length;
            plugins.item = (i) => plugins[i];
            plugins.namedItem = (n) => plugins.find(p => p.name === n);
            return plugins;
        }
    });
    
    Object.defineProperty(navigator, 'pdfViewerEnabled', {get: () => true});
    
    // 3. Sprachen
    Object.defineProperty(navigator, 'languages', {get: () => ['de-DE', 'de', 'en-US', 'en']});
    Object.defineProperty(navigator, 'language', {get: () => 'de-DE'});
    
    // 4. Hardware
    Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 12});
    Object.defineProperty(navigator, 'deviceMemory', {get: () => 32});
    Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});
    Object.defineProperty(navigator, 'vendor', {get: () => 'Google Inc.'});
    Object.defineProperty(navigator, 'vendorSub', {get: () => ''});
    Object.defineProperty(navigator, 'product', {get: () => 'Gecko'});
    Object.defineProperty(navigator, 'productSub', {get: () => '20030107'});
    Object.defineProperty(navigator, 'cookieEnabled', {get: () => true});
    Object.defineProperty(navigator, 'onLine', {get: () => true});
    
    // 5. Chrome-Objekt (sehr wichtig für Cloudflare!)
    if (!window.chrome) {
        window.chrome = {};
    }
    window.chrome.runtime = window.chrome.runtime || {
        onConnect: undefined,
        onMessage: undefined,
        connect: () => {},
        sendMessage: () => {}
    };
    window.chrome.app = {
        isInstalled: false,
        InstallState: {DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed'},
        RunningState: {CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running'}
    };
    window.chrome.loadTimes = function() {
        return {
            requestTime: Date.now() / 1000 - 1,
            startLoadTime: Date.now() / 1000 - 1,
            commitLoadTime: Date.now() / 1000 - 0.5,
            finishDocumentLoadTime: Date.now() / 1000 - 0.3,
            finishLoadTime: Date.now() / 1000 - 0.1,
            firstPaintTime: Date.now() / 1000 - 0.2,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2'
        };
    };
    window.chrome.csi = function() {
        return {
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Date.now() - 100,
            tran: 15
        };
    };
    
    // 6. WebGL Vendor/Renderer überschreiben (NVIDIA RTX 3050 Ti)
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) {  // UNMASKED_VENDOR_WEBGL
            return 'Google Inc. (NVIDIA)';
        }
        if (parameter === 37446) {  // UNMASKED_RENDERER_WEBGL
            return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)';
        }
        return getParameter.call(this, parameter);
    };
    
    // Auch für WebGL2
    if (window.WebGL2RenderingContext) {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Google Inc. (NVIDIA)';
            if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Ti Laptop GPU (0x000025A0) Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return getParameter2.call(this, parameter);
        };
    }
    
    // 7. Screen-Properties
    Object.defineProperty(screen, 'width', {get: () => 1920});
    Object.defineProperty(screen, 'height', {get: () => 1080});
    Object.defineProperty(screen, 'availWidth', {get: () => 1920});
    Object.defineProperty(screen, 'availHeight', {get: () => 1032});
    Object.defineProperty(screen, 'colorDepth', {get: () => 32});
    Object.defineProperty(screen, 'pixelDepth', {get: () => 32});
    Object.defineProperty(screen, 'availLeft', {get: () => 0});
    Object.defineProperty(screen, 'availTop', {get: () => 0});
    
    // 8. Permissions API natürlicher
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => {
        if (parameters.name === 'notifications') {
            return Promise.resolve({state: 'prompt'});
        }
        return originalQuery(parameters);
    };
    
    // 9. UserAgentData (Chrome 148)
    if (navigator.userAgentData) {
        const brands = [
            {brand: "Chromium", version: "148"},
            {brand: "Google Chrome", version: "148"},
            {brand: "Not/A)Brand", version: "99"}
        ];
        Object.defineProperty(navigator.userAgentData, 'brands', {get: () => brands});
        Object.defineProperty(navigator.userAgentData, 'mobile', {get: () => false});
        Object.defineProperty(navigator.userAgentData, 'platform', {get: () => 'Windows'});
    }
    
    // 10. iframe contentWindow chrome (für Cloudflare iframe-Check)
    const iframeProto = HTMLIFrameElement.prototype;
    const originalContentWindow = Object.getOwnPropertyDescriptor(iframeProto, 'contentWindow');
})();
"""


class MailTM:
    """mail.tm API Client - kostenlose temporäre E-Mails ohne Cloudflare"""
    
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


async def solve_turnstile(page, max_wait=120):
    """
    Versucht Cloudflare Turnstile automatisch zu lösen.
    Mit echtem Browser-Fingerprint sollte sich Turnstile passiv lösen.
    """
    print("    [Turnstile] Warte auf Token (passive Lösung erwartet)...")
    
    # Phase 1: Passive Lösung erwarten
    for i in range(20):
        token = await page.evaluate("""() => {
            const inp = document.querySelector('input[name="cf-turnstile-response"]');
            return inp ? inp.value : null;
        }""")
        
        if token and len(token) > 10:
            print(f"    [✓] Turnstile passiv gelöst nach {i*2}s! Token: {token[:30]}...")
            return True
        
        if i % 5 == 4:
            print(f"    ... warte ({(i+1)*2}s)")
        
        await asyncio.sleep(2)
    
    # Phase 2: Container suchen und klicken
    print("    [Turnstile] Suche Widget zum Klicken...")
    
    container_pos = await page.evaluate("""() => {
        const el = document.querySelector('#cfcaptcha');
        if (el) {
            const rect = el.getBoundingClientRect();
            const iframe = el.querySelector('iframe');
            return {
                x: rect.x, y: rect.y,
                width: rect.width, height: rect.height,
                hasIframe: !!iframe
            };
        }
        return null;
    }""")
    
    if not container_pos:
        print("    [WARN] #cfcaptcha nicht gefunden")
        return False
    
    print(f"    [✓] Widget bei ({container_pos['x']:.0f}, {container_pos['y']:.0f}) iframe={container_pos['hasIframe']}")
    
    # Klick mit menschlicher Mausbewegung
    target_x = container_pos["x"] + 30
    target_y = container_pos["y"] + container_pos["height"] / 2
    
    # Mehrfache Mausbewegungen wie ein Mensch
    await page.mouse.move(random.randint(100, 800), random.randint(100, 500), steps=10)
    await asyncio.sleep(random.uniform(0.3, 0.7))
    await page.mouse.move(target_x - 200, target_y - 100, steps=20)
    await asyncio.sleep(random.uniform(0.2, 0.5))
    await page.mouse.move(target_x - 50, target_y - 20, steps=15)
    await asyncio.sleep(random.uniform(0.1, 0.3))
    await page.mouse.move(target_x, target_y, steps=8)
    await asyncio.sleep(random.uniform(0.3, 0.6))
    
    await page.mouse.click(target_x, target_y)
    print(f"    [✓] Klick auf ({target_x:.0f}, {target_y:.0f})")
    
    # Phase 3: Erneut warten
    for i in range(30):
        await asyncio.sleep(2)
        result = await page.evaluate("""() => {
            const inp = document.querySelector('input[name="cf-turnstile-response"]');
            const buttons = document.querySelectorAll('button');
            let btn = null;
            for (const b of buttons) {
                if (b.innerText.includes('Continue') || b.innerText.includes('Weiter')) {
                    btn = b;
                    break;
                }
            }
            return {
                token: inp ? inp.value : null,
                btnEnabled: btn ? !btn.className.includes('cursor-not-allowed') : false
            };
        }""")
        
        if result["token"] and len(result["token"]) > 10:
            print(f"    [✓] Token nach Klick erhalten ({i*2}s)!")
            return True
        if result["btnEnabled"]:
            print(f"    [✓] Continue aktiviert ({i*2}s)!")
            return True
        
        if i % 10 == 9:
            print(f"    ... warte ({(i+1)*2}s)")
    
    return False


async def main():
    print("=" * 70)
    print("PixVerse Registrierung mit echtem Browser-Fingerprint")
    print("=" * 70)
    print(f"Fingerprint: Chrome {FINGERPRINT['userAgent'].split('Chrome/')[1].split(' ')[0]} auf Windows 10")
    print(f"             {FINGERPRINT['webgl']['renderer'][:60]}...")
    
    # Mail erstellen
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
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=[
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                f'--window-size={FINGERPRINT["outerSize"]["width"]},{FINGERPRINT["outerSize"]["height"]}',
            ]
        )
        
        # Context mit allen Fingerprint-Werten
        context = await browser.new_context(
            viewport={
                "width": FINGERPRINT["viewport"]["width"],
                "height": FINGERPRINT["viewport"]["height"]
            },
            user_agent=FINGERPRINT["userAgent"],
            locale=FINGERPRINT["language"],
            timezone_id=FINGERPRINT["timezone"],
            screen={
                "width": FINGERPRINT["screen"]["width"],
                "height": FINGERPRINT["screen"]["height"]
            },
            device_scale_factor=FINGERPRINT["devicePixelRatio"],
            color_scheme="light",
            extra_http_headers={
                "Accept-Language": FINGERPRINT["acceptLanguage"],
                "sec-ch-ua": FINGERPRINT["secChUa"],
                "sec-ch-ua-mobile": FINGERPRINT["secChUaMobile"],
                "sec-ch-ua-platform": FINGERPRINT["secChUaPlatform"],
            }
        )
        
        # Anti-Detection vor jeder Seite injizieren
        await context.add_init_script(ANTI_DETECTION_SCRIPT)
        
        page = await context.new_page()
        
        try:
            print("\n[2] Öffne PixVerse Register...")
            await page.goto("https://app.pixverse.ai/register", wait_until="load", timeout=30000)
            await asyncio.sleep(3)
            
            # Fingerprint überprüfen
            print("\n[3] Überprüfe Fingerprint...")
            fp_check = await page.evaluate("""() => ({
                userAgent: navigator.userAgent,
                platform: navigator.platform,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: navigator.deviceMemory,
                webdriver: navigator.webdriver,
                pluginsLen: navigator.plugins.length,
                languages: navigator.languages,
                vendor: navigator.vendor,
                hasChrome: !!window.chrome,
                hasChromeRuntime: !!(window.chrome && window.chrome.runtime),
                screenW: screen.width,
                screenH: screen.height
            })""")
            
            print(f"    UserAgent: {fp_check['userAgent'][:60]}...")
            print(f"    Platform: {fp_check['platform']}, CPUs: {fp_check['hardwareConcurrency']}, RAM: {fp_check['deviceMemory']}GB")
            print(f"    webdriver: {fp_check['webdriver']} (sollte undefined sein!)")
            print(f"    Plugins: {fp_check['pluginsLen']}, Chrome: {fp_check['hasChrome']}, Runtime: {fp_check['hasChromeRuntime']}")
            print(f"    Screen: {fp_check['screenW']}x{fp_check['screenH']}")
            
            # Formular ausfüllen
            print("\n[4] Fülle Formular...")
            inputs = await page.query_selector_all("input")
            visible = []
            for inp in inputs:
                if await inp.is_visible():
                    visible.append(inp)
            
            if len(visible) >= 4:
                await visible[0].click()
                await visible[0].type(username, delay=random.randint(50, 120))
                await asyncio.sleep(random.uniform(0.3, 0.7))
                
                await visible[1].click()
                await visible[1].type(temp_email, delay=random.randint(50, 120))
                await asyncio.sleep(random.uniform(0.3, 0.7))
                
                await visible[2].click()
                await visible[2].type(password, delay=random.randint(50, 120))
                await asyncio.sleep(random.uniform(0.3, 0.7))
                
                await visible[3].click()
                await visible[3].type(password, delay=random.randint(50, 120))
                await asyncio.sleep(random.uniform(0.5, 1.0))
                
                print(f"    [✓] Username, E-Mail, Passwort eingegeben")
            
            # Turnstile lösen
            print("\n[5] Cloudflare Turnstile lösen...")
            turnstile_solved = await solve_turnstile(page)
            
            if not turnstile_solved:
                print("    [⚠️] Manuell lösen wenn nötig")
                input("    Drücke Enter wenn Captcha gelöst ist...")
            
            # Continue klicken
            print("\n[6] Klicke Continue/Weiter...")
            await asyncio.sleep(random.uniform(0.5, 1.5))
            btn = await page.query_selector("button:has-text('Continue'), button:has-text('Weiter')")
            if btn:
                btn_class = await btn.get_attribute("class") or ""
                if "cursor-not-allowed" in btn_class:
                    print("    [WARN] Button noch deaktiviert, warte 5s...")
                    await asyncio.sleep(5)
                
                await btn.click(force=True)
                print("    [✓] Geklickt")
            
            await asyncio.sleep(5)
            print(f"    URL: {page.url}")
            
            # Auf E-Mail warten
            print("\n[7] Warte auf Verifizierungs-E-Mail (3 Min)...")
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
                print(f"\n[8] Öffne Verifizierungslink...")
                await page.goto(verification_link, wait_until="load")
                await asyncio.sleep(5)
                if "register" not in page.url.lower():
                    result["success"] = True
                    print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
            elif verification_code:
                print(f"\n[8] Gebe Code ein: {verification_code}")
                code_inps = []
                for inp in await page.query_selector_all("input"):
                    if await inp.is_visible():
                        code_inps.append(inp)
                if len(code_inps) >= len(verification_code):
                    for idx, d in enumerate(verification_code):
                        await code_inps[idx].fill(d)
                        await asyncio.sleep(0.2)
                    await asyncio.sleep(3)
                    if "register" not in page.url.lower():
                        result["success"] = True
                        print("\n    ✅ REGISTRIERUNG ERFOLGREICH!")
            
            print("\n    Warte 10s vor Beenden...")
            await asyncio.sleep(10)
            
        except Exception as e:
            print(f"\n[FEHLER] {e}")
            import traceback
            traceback.print_exc()
            result["error"] = str(e)
        
        finally:
            await browser.close()
    
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
    asyncio.run(main())
