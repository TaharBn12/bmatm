#!/usr/bin/env bash
# WatchTogether — بناء سيرفر Java (JDK 11+ فقط، بدون Maven/Gradle)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v javac >/dev/null 2>&1; then
  echo "✗ لم يتم العثور على javac — ثبّت JDK 11 أو أحدث (مثال: sudo apt install default-jdk)" >&2
  exit 1
fi

echo "→ إصدار Java:"; javac -version 2>&1 || true
rm -rf out && mkdir -p out

echo "→ ترجمة المصادر…"
javac -encoding UTF-8 -d out $(find src -name '*.java')

echo "→ إنشاء JAR قابل للتشغيل…"
cat > out/manifest.mf <<MANIFEST
Manifest-Version: 1.0
Main-Class: com.watchtogether.Main
MANIFEST
jar cfm watchtogether.jar out/manifest.mf -C out com
rm -f out/manifest.mf

echo "✓ تم البناء: java-server/out  و  java-server/watchtogether.jar"
echo "  التشغيل: ./run.sh    أو    java -jar watchtogether.jar"
