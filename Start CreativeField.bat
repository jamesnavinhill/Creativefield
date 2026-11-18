@echo off
setlocal EnableExtensions
rem Double-click to start CreativeField. The first start installs what it needs; later starts take a few seconds.
rem Self-healing: a missing or too old Node.js is installed by itself (winget, or a private copy inside this folder).
cd /d "%~dp0"
title CreativeField

rem A private Node.js copy from an earlier start comes first.
if exist ".comfyfield\node\node.exe" set "PATH=%CD%\.comfyfield\node;%PATH%"

call :node_ok
if errorlevel 1 call :get_node
call :node_ok
if errorlevel 1 (
  echo.
  echo Node.js could not be installed automatically.
  echo Install it from https://nodejs.org ^(the LTS button^), then double-click this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)

echo Starting CreativeField. Your browser opens when it is ready. Keep this window open while you work.
call npm start
if errorlevel 1 (
  echo.
  echo CreativeField stopped with an error. The lines above say why.
)
pause
exit /b

:node_ok
rem Node.js 22 or newer on the PATH.
where node >nul 2>nul || exit /b 1
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do if %%v GEQ 22 exit /b 0
exit /b 1

:get_node
echo Node.js 22 or newer is missing. Installing it now, this takes a minute...
where winget >nul 2>nul
if not errorlevel 1 (
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  rem winget does not refresh this window's PATH; add the usual install folder ourselves.
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  call :node_ok
  if not errorlevel 1 exit /b 0
)
rem No winget, or it failed: a private copy inside this folder, used only by CreativeField.
echo Downloading a private copy of Node.js for CreativeField...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12';" ^
  "$list=Invoke-RestMethod https://nodejs.org/dist/index.json;" ^
  "$v=($list | Where-Object { $_.lts -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge 22 } | Select-Object -First 1).version;" ^
  "if (-not $v) { throw 'No Node.js release found' };" ^
  "$zip=Join-Path $env:TEMP ('node-'+$v+'.zip');" ^
  "Invoke-WebRequest ('https://nodejs.org/dist/'+$v+'/node-'+$v+'-win-x64.zip') -OutFile $zip;" ^
  "Expand-Archive $zip -DestinationPath '.comfyfield\node-tmp' -Force;" ^
  "New-Item -ItemType Directory -Force '.comfyfield' | Out-Null;" ^
  "if (Test-Path '.comfyfield\node') { Remove-Item -Recurse -Force '.comfyfield\node' };" ^
  "Move-Item (Get-ChildItem '.comfyfield\node-tmp' | Select-Object -First 1).FullName '.comfyfield\node';" ^
  "Remove-Item -Recurse -Force '.comfyfield\node-tmp'; Remove-Item $zip"
if exist ".comfyfield\node\node.exe" set "PATH=%CD%\.comfyfield\node;%PATH%"
exit /b 0
