@echo off
setlocal
cd /d "%~dp0"
set "KSTUDIO_PACKAGE=%~dp0package.json"
for /f %%V in ('powershell.exe -NoProfile -Command "(Get-Content -Raw -LiteralPath $env:KSTUDIO_PACKAGE | ConvertFrom-Json).version"') do set "KSTUDIO_VERSION=%%V"
echo K Studio v%KSTUDIO_VERSION%
echo Dang mo K Studio...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-K-Studio.ps1"
if errorlevel 1 (
  echo.
  echo Khong the mo K Studio. Hay kiem tra Node.js va thu muc du an.
  pause
)
endlocal