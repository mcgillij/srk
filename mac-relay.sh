#!/bin/sh
set -eu

usage() {
    printf '%s\n' 'Usage: ./mac-relay.sh build | check | start' \
        'build  Install build dependencies and build the tiles relay.' \
        'check  Check macOS capture and input permissions.' \
        'start  Run the relay on 127.0.0.1:8080. This is the default.'
}

die() {
    printf 'mac-relay: %s\n' "$*" >&2
    exit 1
}

[ "$#" -le 1 ] || { usage >&2; exit 2; }
action=${1:-start}
case "$action" in
    -h|--help) usage; exit 0 ;;
    build|check|start) ;;
    *) usage >&2; exit 2 ;;
esac

[ "$(uname -s)" = Darwin ] || die 'Run this script in Terminal on the Mac.'
source_dir=${SCREEN_RELAY_SOURCE_DIR:-"$HOME/screen-relay-tiles"}
case "$source_dir" in
    /*) ;;
    *) die 'SCREEN_RELAY_SOURCE_DIR must be an absolute path.' ;;
esac
source_url=https://github.com/Gaurav-Gosain/screen-relay.git
source_commit=eb8fbf4102a9d5c1314384fb9b97fc3bd2e21d0d

if [ "$action" = build ]; then
    command -v brew >/dev/null || die 'Install Homebrew and add it to PATH.'
    xcode-select -p >/dev/null 2>&1 || die 'Run xcode-select --install, then rerun build.'
    if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
        die 'Install Node.js 22 or newer and make sure node and npm are on PATH.'
    fi
    command -v npm >/dev/null || die 'Add npm to PATH.'
    if [ ! -e "$source_dir" ]; then
        git clone --branch tiles --single-branch "$source_url" "$source_dir"
        git -C "$source_dir" checkout --detach "$source_commit"
    fi
    [ -f "$source_dir/Makefile" ] && [ -f "$source_dir/package-lock.json" ] ||
        die "Expected a screen-relay source checkout at $source_dir."
    brew install pkgconf libwebsockets zstd zlib
    zlib_prefix=$(brew --prefix zlib)
    export PKG_CONFIG_PATH="$zlib_prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    cd "$source_dir"
    make BACKENDS=macos X264=0 deps
    make BACKENDS=macos X264=0
    npm ci
    npm run build
    exit 0
fi

[ -x "$source_dir/relay-engine" ] || die 'Run ./mac-relay.sh build first.'
cd "$source_dir"
if [ "$action" = check ]; then
    exec ./relay-engine --backend macos --check
fi

[ -f dist/viewer/index.html ] && [ -f dist/viewer/viewer.js ] ||
    die 'Viewer assets are missing. Run ./mac-relay.sh build.'

umask 077
state_dir="$HOME/.local/state/screen-relay-tiles"
token_file="$state_dir/token"
mkdir -p "$state_dir"
if [ ! -e "$token_file" ]; then
    candidate=$(mktemp "$state_dir/token.XXXXXX")
    trap 'rm -f "$candidate"' 0
    openssl rand -hex 32 > "$candidate"
    # Publish the token only if another start has not created one already.
    if ! ln "$candidate" "$token_file" 2>/dev/null; then
        [ -f "$token_file" ] || die 'Could not create the relay token.'
    fi
    rm -f "$candidate"
    trap - 0
fi
[ -f "$token_file" ] && [ -s "$token_file" ] || die "The token file is empty or invalid at $token_file."

exec ./relay-engine --backend macos --tiles --bind 127.0.0.1 --port 8080 \
    --viewer-dir "$PWD/dist/viewer" --token-file "$token_file"
