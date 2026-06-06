@echo off
setlocal

cd /d "%~dp0"

echo Starting LiveCue local ASR helper...
echo Relay URL: http://127.0.0.1:17395/asr
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Please install Node.js 20 or newer from https://nodejs.org/ and run this script again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set NODE_MAJOR=%%v
set NODE_MAJOR=%NODE_MAJOR:v=%
if "%NODE_MAJOR%"=="" (
  echo Could not read Node.js version.
  echo Please install Node.js 20 or newer from https://nodejs.org/ and run this script again.
  echo.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or newer is required. Current version:
  node -v
  echo Please update Node.js from https://nodejs.org/ and run this script again.
  echo.
  pause
  exit /b 1
)

node relay\asr-relay.mjs

pause
