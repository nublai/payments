#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

: "${TW_PASSWORD:?TW_PASSWORD must be set for non-interactive smoke testing}"

TW_CMD=(bun run src/cli)
ENV_NAME=${TW_ENV:-prod}
PROFILE_NAME=${TW_PROFILE:-}
KEEP_STATE=${TW_SMOKE_KEEP_STATE:-0}
STAMP=$(date +%s)
ALICE="smoke-alice-${STAMP}"
BOB="smoke-bob-${STAMP}"
CHANNEL="smoke-${STAMP}"
MESSAGE="smoke message ${STAMP}"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/wallet-chat-smoke.XXXXXX")
LISTENER_STDOUT="${TMP_DIR}/listener.stdout"
LISTENER_STDERR="${TMP_DIR}/listener.stderr"
LISTENER_PID=""
STREAM_ID=""
SECRET=""

PROFILE_ARGS=()
if [[ -n "$PROFILE_NAME" ]]; then
  PROFILE_ARGS=(--profile "$PROFILE_NAME")
fi

run_tw() {
  if [[ ${#PROFILE_ARGS[@]} -gt 0 ]]; then
    TW_PASSWORD="$TW_PASSWORD" "${TW_CMD[@]}" "$@" --env "$ENV_NAME" "${PROFILE_ARGS[@]}"
  else
    TW_PASSWORD="$TW_PASSWORD" "${TW_CMD[@]}" "$@" --env "$ENV_NAME"
  fi
}

extract_scalar() {
  local input=$1
  local key=$2
  printf '%s\n' "$input" | awk -F': ' -v key="$key" '$1 == key {sub($1 FS, ""); print; exit}'
}

wait_for_file_pattern() {
  local file=$1
  local pattern=$2
  local timeout_seconds=${3:-20}
  local waited=0

  while (( waited < timeout_seconds )); do
    if [[ -f "$file" ]] && grep -q -- "$pattern" "$file"; then
      return 0
    fi
    if [[ -n "$LISTENER_PID" ]] && ! kill -0 "$LISTENER_PID" 2>/dev/null; then
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

cleanup() {
  local exit_code=$?

  if [[ -n "$LISTENER_PID" ]] && kill -0 "$LISTENER_PID" 2>/dev/null; then
    kill -INT "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
  fi

  if [[ "$KEEP_STATE" != "1" ]]; then
    if [[ -n "$BOB" ]]; then
      run_tw session revoke "$BOB" --force >/dev/null 2>&1 || true
    fi
    if [[ -n "$ALICE" ]]; then
      run_tw session revoke "$ALICE" --force >/dev/null 2>&1 || true
    fi
  fi

  if [[ $exit_code -ne 0 ]]; then
    echo "Smoke test failed. Logs kept at: $TMP_DIR" >&2
  elif [[ "$KEEP_STATE" != "1" ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "Smoke test kept state and logs at: $TMP_DIR"
  fi
}

trap cleanup EXIT

echo "Checking wallet profile"
run_tw account status >/dev/null

echo "Creating chat identities: $ALICE, $BOB"
run_tw session create "$ALICE" --agent >/dev/null
run_tw session create "$BOB" --agent >/dev/null

echo "Connecting named channel from Alice"
alice_connect_output=$(run_tw chat connect --from "$ALICE" --channel "$CHANNEL" --to "$BOB")
printf '%s\n' "$alice_connect_output"
STREAM_ID=$(extract_scalar "$alice_connect_output" "streamId")
SECRET=$(extract_scalar "$alice_connect_output" "secret")

if [[ -z "$STREAM_ID" || -z "$SECRET" ]]; then
  echo "Failed to extract streamId or secret from Alice connect output" >&2
  exit 1
fi

echo "Connecting named channel from Bob using shared secret"
bob_connect_output=$(run_tw chat connect --from "$BOB" --channel "$CHANNEL" --secret "$SECRET" --to "$ALICE")
printf '%s\n' "$bob_connect_output"
bob_stream_id=$(extract_scalar "$bob_connect_output" "streamId")

if [[ "$bob_stream_id" != "$STREAM_ID" ]]; then
  echo "Reverse connect returned a different stream id: $bob_stream_id != $STREAM_ID" >&2
  exit 1
fi

echo "Inspecting named channels"
channels_output=$(run_tw chat list --from "$ALICE")
printf '%s\n' "$channels_output"
if ! grep -q -- "name: $CHANNEL" <<<"$channels_output"; then
  echo "chat list output did not include channel $CHANNEL" >&2
  exit 1
fi
if ! grep -q -- "streamId: $STREAM_ID" <<<"$channels_output"; then
  echo "chat list output did not include stream $STREAM_ID" >&2
  exit 1
fi

echo "Starting listener"
if [[ ${#PROFILE_ARGS[@]} -gt 0 ]]; then
  TW_PASSWORD="$TW_PASSWORD" "${TW_CMD[@]}" chat listen --from "$ALICE" --channel "$CHANNEL" --heartbeat-interval 0 --env "$ENV_NAME" "${PROFILE_ARGS[@]}" >"$LISTENER_STDOUT" 2>"$LISTENER_STDERR" &
else
  TW_PASSWORD="$TW_PASSWORD" "${TW_CMD[@]}" chat listen --from "$ALICE" --channel "$CHANNEL" --heartbeat-interval 0 --env "$ENV_NAME" >"$LISTENER_STDOUT" 2>"$LISTENER_STDERR" &
fi
LISTENER_PID=$!

if ! wait_for_file_pattern "$LISTENER_STDERR" '"type":"status","state":"connected"' 30; then
  echo "Listener never reported connected status" >&2
  [[ -f "$LISTENER_STDERR" ]] && cat "$LISTENER_STDERR" >&2
  exit 1
fi

echo "Sending over named channel"
send_output=$(run_tw chat post --from "$BOB" --channel "$CHANNEL" "$MESSAGE")
printf '%s\n' "$send_output"
event_id=$(extract_scalar "$send_output" "eventId")

if [[ -z "$event_id" ]]; then
  echo "Failed to extract eventId from send output" >&2
  exit 1
fi

if ! wait_for_file_pattern "$LISTENER_STDOUT" "\"eventId\":\"$event_id\"" 30; then
  echo "Listener never received event $event_id" >&2
  [[ -f "$LISTENER_STDOUT" ]] && cat "$LISTENER_STDOUT" >&2
  [[ -f "$LISTENER_STDERR" ]] && cat "$LISTENER_STDERR" >&2
  exit 1
fi

if ! grep -q -- "\"content\":\"$MESSAGE\"" "$LISTENER_STDOUT"; then
  echo "Listener output did not include expected message content" >&2
  cat "$LISTENER_STDOUT" >&2
  exit 1
fi

echo "Stopping listener"
kill -INT "$LISTENER_PID"
set +e
wait "$LISTENER_PID"
listener_exit_code=$?
set -e
if [[ $listener_exit_code -ne 130 ]]; then
  echo "Listener exited with unexpected code: $listener_exit_code" >&2
  exit 1
fi
LISTENER_PID=""

echo "Smoke test passed"
echo "streamId: $STREAM_ID"
echo "channel: $CHANNEL"
