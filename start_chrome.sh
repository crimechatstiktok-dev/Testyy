#!/bin/bash
# ===================================================================
# Startet Chrome mit Debug-Port fuer Skript-Anbindung (Mac/Linux)
# Dein normales Chrome bleibt offen - dies ist ein separates Fenster!
# ===================================================================

CHROME_PROFILE="/tmp/chrome-pixverse-debug"

echo "Starte Chrome mit Debug-Port 9222..."
echo "Profil: $CHROME_PROFILE"
echo ""
echo "WICHTIG: Lass dieses Chrome-Fenster offen!"
echo "Starte dann pixverse_cdp.py in einem anderen Terminal."
echo ""

# Suche Chrome
if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v google-chrome &> /dev/null; then
    CHROME="google-chrome"
elif command -v chromium &> /dev/null; then
    CHROME="chromium"
else
    echo "FEHLER: Chrome nicht gefunden!"
    exit 1
fi

"$CHROME" \
    --remote-debugging-port=9222 \
    --user-data-dir="$CHROME_PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    https://app.pixverse.ai/register
