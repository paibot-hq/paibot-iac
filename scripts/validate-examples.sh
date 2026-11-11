#!/bin/sh
# Generates every example and runs `validate` with tofu and terraform (whichever are installed).
# Needs network access the first time to download providers.
set -eu
cd "$(dirname "$0")/.."
: "${TF_PLUGIN_CACHE_DIR:=${TMPDIR:-/tmp}/paibot-iac-plugin-cache}"
export TF_PLUGIN_CACHE_DIR
mkdir -p "$TF_PLUGIN_CACHE_DIR"

fail=0
for def in examples/*/infra.*; do
  ex=$(dirname "$def")
  node src/cli.ts gen "$def" -o "$ex/out" >/dev/null
  for engine in tofu terraform; do
    command -v "$engine" >/dev/null || continue
    for dir in "$ex"/out/*/; do
      work="$ex/.validate/$engine/$(basename "$dir")"
      mkdir -p "$work"
      cp "$dir/main.tf.json" "$work/"
      if "$engine" -chdir="$work" init -input=false -no-color >/dev/null 2>&1 &&
        "$engine" -chdir="$work" validate -no-color >/dev/null 2>&1; then
        echo "ok    $engine $work"
      else
        echo "FAIL  $engine $work"
        "$engine" -chdir="$work" validate -no-color || true
        fail=1
      fi
    done
  done
done
exit $fail
