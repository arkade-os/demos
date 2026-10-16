#!/usr/bin/env bash
# Build the Arkade compiler WASM package into playground/pkg so the playground
# works offline. Requires an arkade-os/compiler checkout and wasm-pack
# (npm exec wasm-pack works fine).
#
# usage: ./build.sh /path/to/arkade-os/compiler
set -euo pipefail

COMPILER="${1:-${ARKADE_COMPILER_DIR:-}}"
if [ -z "$COMPILER" ] || [ ! -f "$COMPILER/Cargo.toml" ]; then
    echo "usage: ./build.sh /path/to/arkade-os/compiler (or set ARKADE_COMPILER_DIR)" >&2
    exit 1
fi

OUT="$(cd "$(dirname "$0")" && pwd)/pkg"
(cd "$COMPILER" && npm exec --yes wasm-pack -- build --target web --out-dir "$OUT" -- --features wasm)
echo "WASM package written to $OUT"
