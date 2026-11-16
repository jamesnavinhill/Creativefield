@echo off
rem Double-click to start CreativeField. The first start installs what it needs; later starts take a few seconds.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is missing. Install it from https://nodejs.org ^(the LTS button^), then double-click this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo First start: installing CreativeField. This takes a few minutes...
  call npm install
  if errorlevel 1 ( echo Installing failed. Read the lines above. & pause & exit /b 1 )
)
echo Starting CreativeField. Your browser opens in a moment. Keep this window open while you work.
start "" cmd /c "timeout /t 8 >nul & start "" http://127.0.0.1:8787"
call npm start
pause
