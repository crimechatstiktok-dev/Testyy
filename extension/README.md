# PixVerse Auto-Register (Chrome Extension)

Chrome-Extension (Manifest V3) die Registrierungen auf
[app.pixverse.ai/register](https://app.pixverse.ai/register) automatisiert.
Sie nutzt mail.tm fuer eine temporaere E-Mail und erwartet, dass Cloudflare
Turnstile passiv geloest wird (deshalb in deinem echten "tele"-Profil laufen
lassen, nicht im automatisierten Headless-Chromium).

## Was sie macht

1. Erstellt eine Mailbox ueber `mail.tm` (Default-Domain `wshu.net`, faellt
   automatisch auf eine andere aktive Domain zurueck wenn nicht verfuegbar).
2. Generiert Username + Passwort.
3. Oeffnet `https://app.pixverse.ai/register` und fuellt die 4 sichtbaren
   Felder (Username, E-Mail, Passwort, Confirm) per React-kompatiblem
   Input-Setter (echter `value`-Setter + bubbling `input` / `change` Events).
4. Pollt `input[name="cf-turnstile-response"]` und den Continue-Button. Sobald
   ein Token vorhanden _oder_ der Button enabled ist, wird er geklickt.
5. Pollt im Service-Worker via `chrome.alarms` alle ~6 s die mail.tm-Inbox.
6. Extrahiert per Regex den Verifizierungs-Code (4-6 Ziffern, 6 bevorzugt)
   bzw. einen Verifizierungs-Link.
7. Traegt den Code ein (1 Feld _oder_ 6 Digit-Boxen werden beide unterstuetzt)
   bzw. navigiert zum Link, und klickt einen Confirm-Button falls vorhanden.

## Installation

1. In Chrome `chrome://extensions` oeffnen.
2. _Entwicklermodus_ oben rechts aktivieren.
3. _"Entpackte Erweiterung laden"_ -> diesen `extension/` Ordner waehlen.
4. Die Extension zeigt das Icon in der Toolbar; rechts daneben oeffnet ein
   Klick das Popup.

> Wichtig: Damit Turnstile passiv durchgeht, **starte Chrome bewusst mit
> deinem echten "tele"-Profil**. Dieses Repository hat dafuer
> `start_chrome.bat` / `start_chrome.sh`.

## Bedienung

- **Registrierung starten** - legt Mailbox an, oeffnet `/register` (oder
  benutzt einen vorhandenen Tab) und triggert die Automatisierung.
- **Stop** - beendet das Polling, behaelt aber Account-Daten.
- **Inbox jetzt** - erzwingt sofortiges Polling (Debug).
- **Clear** - alles loeschen.
- Account-Felder sind kopierbar; das mail.tm-Passwort ist gespeichert, falls
  du dich spaeter manuell in der Inbox einloggen willst.

## Dateien

| Datei            | Zweck                                                          |
|------------------|----------------------------------------------------------------|
| `manifest.json`  | MV3 Manifest (Permissions, Content-Script Match, Worker)       |
| `background.js`  | Service-Worker: mail.tm-Client, State, Inbox-Polling, Routing  |
| `content.js`     | Laeuft auf pixverse.ai: Form fuellen, Turnstile, Code-Eingabe  |
| `popup.html/.css/.js` | UI mit Status, Account-Daten, Live-Log                    |

## Permissions Begruendung

- `storage` - Account-Daten + Logs persistieren.
- `tabs`, `activeTab` - Tab finden/oeffnen, Messages an Content-Script.
- `scripting` - reserviert fuer dynamisches Injizieren (aktuell nicht genutzt).
- `alarms` - 6-Sekunden-Inbox-Polling im Service-Worker.
- `notifications` - reserviert fuer optionale Erfolgsmeldung.
- `host_permissions: api.mail.tm + app.pixverse.ai` - Cross-Origin Fetch.

## Status-Werte (Pill im Popup)

`idle` -> `creating-mailbox` -> `mailbox-ready` -> `filling-form` ->
`waiting-turnstile` -> `turnstile-solved` -> `submitted` -> `waiting-mail` ->
`verification-received` -> `entering-code` / `opening-link` -> `code-entered`
-> `done`. Bei Problemen: `error` (siehe Log).

## Bekannte Limitierungen

- mail.tm hat Rate-Limits; wenn die Account-Anlage 429 gibt, kurz warten.
- Wenn PixVerse die Klassen-Namen aendert (z. B. nicht mehr
  `cursor-not-allowed`), greift der `disabled`/`aria-disabled`-Fallback.
- Turnstile **wird hier nicht aktiv geloest** - die Extension wartet nur. Im
  echten Profil reicht das laut deinen Tests.
