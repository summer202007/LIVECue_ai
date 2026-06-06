#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting LiveCue local ASR helper..."
echo "Relay URL: http://127.0.0.1:17395/asr"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo "Please install Node.js 20 or newer from https://nodejs.org/ and run this script again."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required. Current version: $(node -v)"
  echo "Please update Node.js from https://nodejs.org/ and run this script again."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

node relay/asr-relay.mjs
