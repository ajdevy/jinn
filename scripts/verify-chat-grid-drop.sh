#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OPERATOR_HOME="$HOME"
HELPER="${JINN_SANDBOX_HELPER:-$OPERATOR_HOME/.jinn/skills/jinn-sandbox/scripts/jinn-sandbox.sh}"
PORT="${JINN_VERIFY_PORT:-8060}"
TMP_BASE="${JINN_VERIFY_TMP_ROOT:-/tmp}"
INSTANCE="chat-grid-drop-verification"

PNPM_BIN="$(command -v pnpm || true)"
if [[ -z "$PNPM_BIN" ]]; then echo "pnpm is required" >&2; exit 2; fi
NODE_BIN="${JINN_VERIFY_NODE_BIN:-$(dirname "$PNPM_BIN")/node}"
if [[ ! -x "$NODE_BIN" ]]; then echo "Node beside pnpm not found: $NODE_BIN" >&2; exit 2; fi
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 8060 )) || [[ "$PORT" == "7777" || "$PORT" == "7788" ]]; then
  echo "JINN_VERIFY_PORT must be an integer at or above 8060 and cannot be 7777 or 7788" >&2
  exit 2
fi
if [[ ! -x "$HELPER" ]]; then echo "Sandbox helper not found: $HELPER" >&2; exit 2; fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "Candidate port $PORT is already in use" >&2
  exit 2
fi

VERIFY_ROOT="$(mktemp -d "$TMP_BASE/jinn-chat-grid-drop.XXXXXX")"
HOST_HOME="$VERIFY_ROOT/host"
SANDBOX_HOME="$HOST_HOME/.jinn-$INSTANCE"
ARTIFACTS="$SANDBOX_HOME/sandbox-artifacts/pla-174"
BASE_URL="http://127.0.0.1:$PORT"
STARTED=0

cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$STARTED" -eq 1 ]]; then
    env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" stop "$INSTANCE" >/dev/null 2>&1 || status=3
    for _ in {1..20}; do
      if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
      sleep 0.25
    done
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "Sandbox listener remains on port $PORT" >&2
      status=3
    fi
    env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" destroy "$INSTANCE" --yes >/dev/null 2>&1 || status=3
  fi
  if [[ "$VERIFY_ROOT" == "$TMP_BASE"/jinn-chat-grid-drop.* && -d "$VERIFY_ROOT" ]]; then
    rm -rf "$VERIFY_ROOT"
  else
    echo "Refusing cleanup outside the current verification root: $VERIFY_ROOT" >&2
    status=3
  fi
  echo "Destroyed PLA-174 sandbox and removed $VERIFY_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$HOST_HOME"
env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" create "$INSTANCE" --port "$PORT" --build --seed
STARTED=1
env HOME="$HOST_HOME" JINN_REPO="$REPO" "$HELPER" start "$INSTANCE"

export JINN_VERIFY_HOME="$SANDBOX_HOME"
export JINN_VERIFY_BASE_URL="$BASE_URL"
export JINN_VERIFY_ARTIFACTS="$ARTIFACTS"
mkdir -p "$ARTIFACTS"

cd "$REPO"
pnpm exec playwright test --config playwright.chat-grid-drop.config.ts
