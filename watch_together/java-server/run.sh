#!/usr/bin/env bash
# WatchTogether — تشغيل سيرفر Java
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d out ]; then
  echo "→ لم يُبنَ المشروع بعد، جارٍ البناء…"
  ./build.sh
fi

PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
echo "→ تشغيل WatchTogether على ${HOST}:${PORT}  (Ctrl+C للإيقاف)"
exec java -Dfile.encoding=UTF-8 -cp out com.watchtogether.Main
