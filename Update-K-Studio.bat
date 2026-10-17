@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-K-Studio.ps1"
if errorlevel 1 (
  echo.
  echo Cap nhat K Studio chua hoan tat. Xem thong bao loi phia tren.
  pause
)
endlocal
