#!/bin/sh
# Renders scripts/og-image.html to og-image.png (1200 by 630) with the Chrome already on the Mac.
cd "$(dirname "$0")/.." || exit 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1200,630 --screenshot="$PWD/og-image.png" "file://$PWD/scripts/og-image.html" 2>/dev/null
echo "wrote og-image.png"
