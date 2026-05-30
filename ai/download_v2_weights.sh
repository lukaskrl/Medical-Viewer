#!/usr/bin/env bash
# Download the TotalSegmentator v2 vertebrae model weights (CT + MRI) used by
# ai/run_v2.py. Idempotent: skips datasets that are already unpacked.
set -euo pipefail

AI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$AI_DIR/models_v2"
BASE="https://github.com/wasserth/TotalSegmentator/releases/download"
mkdir -p "$DEST"

# dataset dir name -> release path of its zip
download() {
  local ds="$1" rel="$2"
  if [ -d "$DEST/$ds" ]; then
    echo "[skip] $ds already present"
    return
  fi
  echo "[get ] $ds"
  curl -fL -o "$DEST/tmp.zip" "$BASE/$rel"
  unzip -oq "$DEST/tmp.zip" -d "$DEST"
  rm -f "$DEST/tmp.zip"
  rm -rf "$DEST/__MACOSX"   # zip ships a macOS resource-fork dir; drop it
}

download "Dataset292_TotalSegmentator_part2_vertebrae_1532subj" \
         "v2.0.0-weights/Dataset292_TotalSegmentator_part2_vertebrae_1532subj.zip"
download "Dataset756_mri_vertebrae_1076subj" \
         "v2.5.0-weights/Dataset756_mri_vertebrae_1076subj.zip"

echo "Done. Models in $DEST"
