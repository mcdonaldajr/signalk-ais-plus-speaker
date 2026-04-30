#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPER_VERSION="2023.11.14-2"
PIPER_ARCHIVE="piper_linux_x86_64.tar.gz"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${PIPER_ARCHIVE}"
VOICE_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"

VOICES=(
  "en/en_GB/alan/medium/en_GB-alan-medium"
  "en/en_GB/alan/low/en_GB-alan-low"
  "en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium"
  "en/en_GB/semaine/medium/en_GB-semaine-medium"
  "en/en_GB/southern_english_female/low/en_GB-southern_english_female-low"
)

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "This installer currently targets Lubuntu on x86_64/amd64."
  echo "Detected: $(uname -m)"
  echo "Piper upstream Linux release archives have historically been unreliable for some non-x86_64 builds."
  exit 1
fi

echo "Installing system packages..."
sudo apt update
sudo apt install -y curl tar nodejs npm alsa-utils

cd "$ROOT_DIR"

echo "Installing Node dependencies..."
npm install --omit=dev

if [[ ! -x "$ROOT_DIR/piper/piper" ]]; then
  echo "Downloading Piper ${PIPER_VERSION}..."
  tmpdir="$(mktemp -d)"
  curl -L "$PIPER_URL" -o "$tmpdir/$PIPER_ARCHIVE"
  tar -xzf "$tmpdir/$PIPER_ARCHIVE" -C "$ROOT_DIR"
  rm -rf "$tmpdir"
fi

mkdir -p "$ROOT_DIR/voices"

download_voice_file() {
  local voice_path="$1"
  local filename
  filename="$(basename "$voice_path")"
  if [[ ! -f "$ROOT_DIR/voices/${filename}.onnx" ]]; then
    echo "Downloading ${filename}.onnx..."
    curl -L "${VOICE_BASE}/${voice_path}.onnx" -o "$ROOT_DIR/voices/${filename}.onnx"
  fi
  if [[ ! -f "$ROOT_DIR/voices/${filename}.onnx.json" ]]; then
    echo "Downloading ${filename}.onnx.json..."
    curl -L "${VOICE_BASE}/${voice_path}.onnx.json" -o "$ROOT_DIR/voices/${filename}.onnx.json"
  fi
}

for voice in "${VOICES[@]}"; do
  download_voice_file "$voice"
done

if [[ ! -f "$ROOT_DIR/config.json" ]]; then
  cp "$ROOT_DIR/config.example.json" "$ROOT_DIR/config.json"
fi

chmod +x "$ROOT_DIR/src/server.js"

echo
echo "Install complete."
echo "Edit config.json if Signal K is not at http://localhost:3000."
echo "Run with:"
echo "  cd $ROOT_DIR"
echo "  npm start"
echo
echo "Then open:"
echo "  http://localhost:3420"
