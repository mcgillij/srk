#!/bin/sh
set -eu

client_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output_dir="$client_dir/../dist"
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
staging=$(mktemp -d "$output_dir/.screen-relay-kitty.XXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

package="$staging/screen-relay-kitty"
mkdir "$package"
for file in LICENSE README.md mac-relay.sh linux-viewer.sh screen-relay-kitty.mjs \
    input.mjs protocol.mjs terminal.mjs client.test.mjs; do
    cp "$client_dir/$file" "$package/"
done
chmod 755 "$package/mac-relay.sh" "$package/linux-viewer.sh"
tar -czf "$staging/archive.tar.gz" -C "$staging" screen-relay-kitty
archive="$output_dir/screen-relay-kitty.tar.gz"
mv "$staging/archive.tar.gz" "$archive"
printf '%s\n' "$archive"
