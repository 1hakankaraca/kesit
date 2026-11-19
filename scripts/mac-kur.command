#!/bin/zsh
# Kesit App'i bu Mac'te derleyip Uygulamalar klasörüne kurar.
# Finder'da çift tıkla ya da Terminal'de çalıştır: ~/Documents/kesit/scripts/mac-kur.command
# Ayarlar, klipler ve kayıtlar yerinde kalır; yalnız uygulamanın kendisi yenilenir.
set -e
command -v npm >/dev/null 2>&1 || source ~/.zshrc 2>/dev/null || true
cd "$(dirname "$0")/.."

echo "› Kesit App derleniyor (birkaç dakika sürebilir)…"
npm run desktop:dist

APP="$(ls -d desktop/release/mac*/"Kesit App.app" 2>/dev/null | head -1)"
if [ -z "$APP" ]; then
  echo "Derlenen uygulama bulunamadı (desktop/release)." >&2
  exit 1
fi

if pgrep -xq "Kesit App"; then
  echo "› Açık olan Kesit App kapatılıyor…"
  osascript -e 'quit app "Kesit App"' >/dev/null 2>&1 || true
  for i in {1..20}; do pgrep -xq "Kesit App" || break; sleep 0.5; done
fi

echo "› Uygulamalar klasörüne kuruluyor…"
rm -rf "/Applications/Kesit App.app"
ditto "$APP" "/Applications/Kesit App.app"
open "/Applications/Kesit App.app"
echo "✓ Kuruldu: Kesit App $(defaults read "/Applications/Kesit App.app/Contents/Info" CFBundleShortVersionString)"
