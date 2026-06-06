#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting LiveCue local ASR helper..."
echo "Relay URL: http://127.0.0.1:17395/asr"
echo

node asr-relay.mjs
