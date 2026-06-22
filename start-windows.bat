@echo off
rem BoardBuilder launcher (Windows). Installs dependencies on first run, starts the
rem local dev server, and opens your browser. Close this window to stop it.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required but was not found on PATH.
  echo Install it from https://nodejs.org/ then double-click this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first run only, ~30s^)...
  call npm install --no-fund --no-audit || (echo. & echo Install failed. & pause & exit /b 1)
)

echo.
echo Starting BoardBuilder - a browser tab will open when it is ready.
echo Leave this window open while you use it; close it to stop.
echo.
call npm run dev -- --open
