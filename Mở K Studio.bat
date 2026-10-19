@echo off
setlocal
cd /d "%~dp0"
echo Dang mo K Studio...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-K-Studio.ps1"
if errorlevel 1 (
  echo.
  echo Khong the mo K Studio. Hay kiem tra Node.js va thu muc du an.
  pause
)
endlocal
