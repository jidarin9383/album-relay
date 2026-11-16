#!/bin/sh
set -eu
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
for i in 1 2 3 4 5 6 7 8 9 10; do [ -S /tmp/.X11-unix/X99 ] && break; sleep 1; done
x11vnc -display :99 -localhost -forever -shared -nopw -quiet &
websockify --web=/usr/share/novnc 0.0.0.0:7900 localhost:5900 &
socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9222 &
CHROME=$(find /ms-playwright -type f \( -path '*/chrome-linux/chrome' -o -path '*/chrome-linux64/chrome' \) | head -n 1)
[ -n "$CHROME" ] || { echo 'Chromium executable not found' >&2; exit 1; }
exec "$CHROME" --no-sandbox --disable-dev-shm-usage --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/browser-data about:blank
