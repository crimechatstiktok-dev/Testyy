@echo off
REM ===================================================================
REM Startet Chrome mit Debug-Port fuer Skript-Anbindung
REM Dein normales Chrome bleibt offen - dies ist ein separates Fenster!
REM ===================================================================

REM Erstelle separates Profil-Verzeichnis (wird nicht mit deinem normalen Chrome kollidieren)
set CHROME_PROFILE=%TEMP%\chrome-pixverse-debug

echo Starte Chrome mit Debug-Port 9222...
echo Profil: %CHROME_PROFILE%
echo.
echo WICHTIG: Lass dieses Chrome-Fenster offen!
echo Starte dann pixverse_cdp.py in einem anderen Terminal.
echo.

REM Suche Chrome installation
set CHROME_EXE=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set CHROME_EXE="C:\Program Files\Google\Chrome\Application\chrome.exe"
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set CHROME_EXE="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    set CHROME_EXE="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
)

if "%CHROME_EXE%"=="" (
    echo FEHLER: Chrome nicht gefunden!
    pause
    exit /b 1
)

REM Starte Chrome mit Debug-Port
%CHROME_EXE% ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%CHROME_PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  https://app.pixverse.ai/register

pause
