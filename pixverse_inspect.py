#!/usr/bin/env python3
"""
PixVerse Form Inspector - Untersucht das Formular im Detail
"""
import asyncio
from playwright.async_api import async_playwright

async def main():
    print("=" * 70)
    print("PixVerse Form Inspector")
    print("=" * 70)
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=['--no-sandbox'])
        context = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await context.new_page()
        
        await page.goto("https://app.pixverse.ai/register", wait_until="load", timeout=30000)
        await asyncio.sleep(3)
        
        # Detaillierte Inspektion
        info = await page.evaluate("""() => {
            // Alle Inputs (auch versteckte)
            const allInputs = Array.from(document.querySelectorAll('input')).map((inp, i) => ({
                index: i,
                type: inp.type,
                name: inp.name,
                id: inp.id,
                placeholder: inp.placeholder,
                value: inp.value,
                checked: inp.checked,
                visible: inp.offsetParent !== null,
                required: inp.required,
                disabled: inp.disabled
            }));
            
            // Alle Buttons
            const allButtons = Array.from(document.querySelectorAll('button')).map((b, i) => ({
                index: i,
                text: b.innerText.trim(),
                type: b.type,
                disabled: b.disabled,
                visible: b.offsetParent !== null
            })).filter(b => b.text || b.visible);
            
            // Forms
            const forms = Array.from(document.querySelectorAll('form')).map(f => ({
                action: f.action,
                method: f.method,
                id: f.id,
                novalidate: f.noValidate
            }));
            
            // Suche nach Checkboxes (auch custom)
            const checkboxes = Array.from(document.querySelectorAll('[role="checkbox"], .ant-checkbox')).map(c => ({
                tag: c.tagName,
                role: c.getAttribute('role'),
                ariaChecked: c.getAttribute('aria-checked'),
                className: c.className.substring(0, 100),
                text: c.innerText?.substring(0, 100)
            }));
            
            return {allInputs, allButtons, forms, checkboxes};
        }""")
        
        print("\n[INPUTS] Alle Input-Elemente:")
        for inp in info["allInputs"]:
            visibility = "👁️" if inp["visible"] else "🚫"
            print(f"  [{inp['index']}] {visibility} type={inp['type']:10s} placeholder='{inp['placeholder']}' name='{inp['name']}' value='{inp['value'][:30]}'")
        
        print("\n[BUTTONS]")
        for btn in info["allButtons"]:
            disabled = "🔒" if btn["disabled"] else "✅"
            print(f"  [{btn['index']}] {disabled} '{btn['text'][:40]}' type={btn['type']}")
        
        print("\n[FORMS]")
        for form in info["forms"]:
            print(f"  action='{form['action']}', method={form['method']}, novalidate={form['novalidate']}")
        
        print("\n[CHECKBOXES (custom)]")
        for cb in info["checkboxes"]:
            print(f"  {cb['tag']} role={cb['role']} checked={cb['ariaChecked']} text='{cb['text']}'")
        
        await page.screenshot(path="/projects/sandbox/Testyy/inspect_form.png", full_page=True)
        print("\n[Screenshot: inspect_form.png]")
        
        await browser.close()

asyncio.run(main())
