@echo off
cd /d "%~dp0"
if not exist .env (
  echo The .env settings file is missing. Copy .env.example, name the copy .env, and fill it in.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing the bot. This only happens the first time...
  call npm install
  if errorlevel 1 (
    echo Install failed. Make sure Node.js 22 or newer is installed from nodejs.org.
    pause
    exit /b 1
  )
)
node --env-file=.env bot.js
pause
