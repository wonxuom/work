#!/bin/sh
set -eu

[ "$(uname -s)" = "Darwin" ] || exit 0

project_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
source_app="$project_dir/src-tauri/target/release/bundle/macos/Trace.app"
target_app="/Applications/Trace.app"

[ -d "$source_app" ] || { echo "Trace.app 빌드를 찾을 수 없습니다." >&2; exit 1; }

/usr/bin/pkill -f '^/Applications/Trace[.]app/Contents/MacOS/trace$' 2>/dev/null || true
attempt=0
while /usr/bin/pgrep -f '^/Applications/Trace[.]app/Contents/MacOS/trace$' >/dev/null 2>&1; do
  [ "$attempt" -lt 50 ] || { echo "Trace가 아직 종료 중입니다. 잠시 후 다시 업데이트해 주세요." >&2; exit 1; }
  sleep 0.1
  attempt=$((attempt + 1))
done
/usr/bin/ditto "$source_app" "$target_app"
/usr/bin/open "$target_app"

echo "Trace.app 업데이트 완료"
