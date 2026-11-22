#!/bin/sh
set -eu

usage() {
    printf '%s\n' 'Usage: ./linux-viewer.sh SSH_HOST [--view-only]' \
        'Use the same host or alias you use with ssh.' \
        'SCREEN_RELAY_LOCAL_PORT overrides local port 18080.'
}

die() {
    printf 'linux-viewer: %s\n' "$*" >&2
    exit 1
}

case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    ''|-*) usage >&2; exit 2 ;;
esac
host=$1
shift
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --view-only ]; }; then
    usage >&2
    exit 2
fi

port=${SCREEN_RELAY_LOCAL_PORT:-18080}
case "$port" in
    ''|*[!0-9]*) die 'SCREEN_RELAY_LOCAL_PORT must be a port from 1 to 65535.' ;;
esac
if [ "${#port}" -gt 5 ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die 'SCREEN_RELAY_LOCAL_PORT must be a port from 1 to 65535.'
fi
[ -t 0 ] && [ -t 1 ] || die 'Run this in Kitty or Ghostty.'
command -v ssh >/dev/null || die 'Install the OpenSSH client.'
if ! command -v node >/dev/null ||
    ! node -e 'process.exit(typeof WebSocket === "function" && typeof require("node:zlib").zstdDecompressSync === "function" ? 0 : 1)'; then
    die 'Install Node.js 24 or newer.'
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tunnel_dir=$(mktemp -d /tmp/screen-relay-ssh.XXXXXX)
control="$tunnel_dir/control"
viewer_pid=

cleanup() {
    if [ -n "$viewer_pid" ]; then
        kill -TERM "$viewer_pid" 2>/dev/null || :
        wait "$viewer_pid" 2>/dev/null || :
    fi
    if [ -S "$control" ]; then
        ssh -S "$control" -O exit -- "$host" >/dev/null 2>&1 || :
        rm -f "$control"
    fi
    rmdir "$tunnel_dir" 2>/dev/null || :
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ssh -fNT -M -S "$control" -o ControlPersist=no -o ExitOnForwardFailure=yes \
    -o RemoteCommand=none -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -L "127.0.0.1:$port:127.0.0.1:8080" -- "$host"
[ -S "$control" ] || die 'SSH did not create the tunnel control socket.'
if ! relay_token=$(ssh -T -S "$control" -o ControlMaster=no -o BatchMode=yes -o RemoteCommand=none \
    -- "$host" 'cat "$HOME/.local/state/screen-relay-tiles/token"'); then
    die 'Could not read the token from the Mac. Start the Mac relay and use its SSH account.'
fi
case "$relay_token" in
    *[!a-f0-9]*) die 'The Mac did not return a valid relay token.' ;;
esac
[ "${#relay_token}" -eq 64 ] || die 'The Mac did not return a valid relay token.'

# Keep the viewer on the terminal while the launcher waits and handles signals.
exec 3<&0
SCREEN_RELAY_TOKEN="$relay_token" node "$script_dir/screen-relay-kitty.mjs" \
    "$@" "http://127.0.0.1:$port" <&3 3<&- &
viewer_pid=$!
exec 3<&-
status=0
wait "$viewer_pid" || status=$?
viewer_pid=
exit "$status"
