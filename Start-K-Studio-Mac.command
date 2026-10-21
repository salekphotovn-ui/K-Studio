#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "K Studio cho Mac này được chuẩn bị cho Apple Silicon (arm64)."
  echo "Máy hiện tại: $(uname -m)"
  read -r -p "Nhấn Enter để đóng..."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Chưa tìm thấy Node.js. Cài Node.js LTS bản macOS ARM64, rồi mở lại file này."
  open "https://nodejs.org/en/download"
  read -r -p "Nhấn Enter để đóng..."
  exit 1
fi

if [[ ! -d node_modules/playwright-core ]]; then
  echo "Đang cài thư viện K Studio..."
  npm ci
fi

if [[ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && ! -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  echo "Chưa tìm thấy Google Chrome. Hãy cài Chrome cho Apple Silicon rồi chạy lại K Studio."
  open "https://www.google.com/chrome/"
  read -r -p "Nhấn Enter để đóng..."
  exit 1
fi

# If K Studio is already serving, reuse it instead of starting a second server
# that would try to open the same persistent Muse Chrome profile.
if curl -fsS --max-time 2 http://127.0.0.1:4173/api/version 2>/dev/null | grep -q '"appVersion"'; then
  echo "K Studio đã chạy; mở lại giao diện hiện tại."
  open -a "Google Chrome" "http://127.0.0.1:4173/"
  exit 0
fi
if lsof -nP -iTCP:4173 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Cổng 4173 đang được tiến trình khác sử dụng. Không khởi chạy thêm K Studio để tránh khóa trùng profile Muse."
  read -r -p "Nhấn Enter để đóng..."
  exit 1
fi

node server.js &
server_pid=$!
sleep 2
open -a "Google Chrome" "http://127.0.0.1:4173/"
echo "K Studio đang chạy. Đóng cửa sổ này hoặc nhấn Ctrl+C để dừng."
wait "$server_pid"
