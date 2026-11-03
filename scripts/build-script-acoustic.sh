#!/usr/bin/env bash
# Explicit experimental build; uses an already downloaded upstream checkout.
# Never downloads models or installs/replaces the running application.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_WHISPER_SOURCE="${1:-$ROOT/src-tauri/target/script-whisper-source}"
SCRIPT_WHISPER_BUILD="$ROOT/src-tauri/target/script-whisper-build"
EXPECTED_COMMIT="51c6961c7b64b406833f4b6a4a20e67142f69225"
if [[ "$(git -C "$SCRIPT_WHISPER_SOURCE" rev-parse HEAD)" != "$EXPECTED_COMMIT" ]]; then
  echo "Expected official whisper.cpp v1.7.5 ($EXPECTED_COMMIT)" >&2
  exit 1
fi
if [[ -n "$(git -C "$SCRIPT_WHISPER_SOURCE" status --porcelain --untracked-files=no)" ]]; then
  echo "Upstream source has modifications; use an unmodified checkout" >&2
  exit 1
fi
cmake -S "$SCRIPT_WHISPER_SOURCE" -B "$SCRIPT_WHISPER_BUILD" \
  -DWHISPER_BUILD_EXAMPLES=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_COREML=OFF \
  -DGGML_METAL=ON -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build "$SCRIPT_WHISPER_BUILD" -j 4
c++ -std=c++17 -O2 "$ROOT/scripts/script-acoustic-score.cpp" \
  -I "$SCRIPT_WHISPER_SOURCE/include" -I "$SCRIPT_WHISPER_SOURCE/ggml/include" \
  -I "$SCRIPT_WHISPER_SOURCE/examples" -L "$SCRIPT_WHISPER_BUILD/src" -lwhisper \
  -Wl,-rpath,"$SCRIPT_WHISPER_BUILD/src" -o "$SCRIPT_WHISPER_BUILD/script-acoustic-score"
echo "$SCRIPT_WHISPER_BUILD/script-acoustic-score"
