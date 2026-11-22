# Screen Relay Kitty

View a Mac desktop from Linux in Kitty or Ghostty. The Mac sends changed pixels over SSH. The viewer renders the stream and forwards keyboard and mouse events.

## Unpack on both machines

```sh
tar -xzf screen-relay-kitty.tar.gz
cd screen-relay-kitty
```

## Mac setup

1. Install [Homebrew](https://brew.sh), Node.js 22 or newer, and the Xcode Command Line Tools. If needed, run `xcode-select --install`.
2. Open Terminal from the logged-in Mac desktop. Run the build and permission check there.

   ```sh
   ./mac-relay.sh build
   ./mac-relay.sh check
   ```

   The build installs its Homebrew libraries and builds the tiles fork in `$HOME/screen-relay-tiles`. It reuses that directory if a checkout is already there.

3. If the check reports missing permissions, open **System Settings → Privacy & Security**. Enable Terminal in **Screen & System Audio Recording** and **Accessibility**. Quit and reopen Terminal, then run the check again from the extracted folder. [macOS relay notes]
4. Enable **Remote Login** under **System Settings → General → Sharing**. Allow the same Mac account that runs the relay. [Apple Remote Login instructions](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac)
5. Start the relay. Leave the Terminal window open and the Mac awake. Keep a display active. On a MacBook, leave the lid open for the first test.

   ```sh
   ./mac-relay.sh start
   ```

## Connect from Linux

Install Kitty or Ghostty, plus OpenSSH and Node.js 24 or newer. Open your terminal, go to the extracted folder, and run:

```sh
./linux-viewer.sh mac-user@mac.local
```

Substitute the same destination you normally use with `ssh`, such as `mac`. The launcher opens a loopback SSH tunnel, reads the token from the Mac, and closes the tunnel on exit. Press **Ctrl+\\** to exit the viewer. Use `--view-only` after the host to watch without taking input control.

## Fix common problems

- If SSH fails, test `ssh mac-user@mac.local` with your own destination. Use the account that started the relay.
- If local port `18080` is busy, stop the old tunnel or run `SCREEN_RELAY_LOCAL_PORT=18081 ./linux-viewer.sh mac`.
- If the viewer cannot connect, look for `Relay listening on 127.0.0.1:8080` in Terminal on the Mac. Close any other viewer that owns input, or add `--view-only`.
- If the desktop appears and input has no effect, rerun `./mac-relay.sh check` on the Mac. Check Accessibility for the Terminal app that launched the relay.

## Source and tests

The viewer uses a tiles decoder adapted from the fork's test client. [Screen Relay fork source](https://github.com/Gaurav-Gosain/screen-relay/blob/eb8fbf4102a9d5c1314384fb9b97fc3bd2e21d0d/tests/e2e/tiles-client.mjs)

Run the viewer tests from this folder with `node --test --test-isolation=none client.test.mjs`.
