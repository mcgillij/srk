#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { TerminalInput } from './input.mjs';
import { applyTiles, encodeInput, Input, keyframePayload, Message, readMessage, writeMessage } from './protocol.mjs';
import { KittyTerminal } from './terminal.mjs';

const help = 'Usage: node client/screen-relay-kitty.mjs [--view-only] [http://127.0.0.1:18080]\n' +
  'Set SCREEN_RELAY_TOKEN for an authenticated relay. Press Ctrl+\\ to exit.';

function options(args, env) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, 'view-only': { type: 'boolean' } },
  });
  if (values.help) return null;
  if (positionals.length > 1) throw new Error(help);
  const url = new URL(positionals[0] ?? 'http://127.0.0.1:18080');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS relay origin without credentials, a path, or a query.');
  }
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new Error('Use HTTPS for a remote relay, or connect through a loopback SSH tunnel.');
  }
  const protocols = ['nsl1'];
  if (env.SCREEN_RELAY_TOKEN) {
    if (!/^[a-f0-9]{64}$/.test(env.SCREEN_RELAY_TOKEN)) throw new Error('Invalid SCREEN_RELAY_TOKEN.');
    protocols.push('bearer.' + env.SCREEN_RELAY_TOKEN);
  }
  const viewOnly = values['view-only'] ?? false;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/stream';
  url.search = viewOnly ? '?view=1&codec=tiles' : '?codec=tiles';
  return { url, protocols, viewOnly };
}

async function run({ url, protocols, viewOnly }) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Open this viewer in Kitty or Ghostty.');
  const terminal = new KittyTerminal(stdin, stdout);
  let socket, startup, resizeTimer;
  let stopped = false, generation = 0, sequence = 0, ready = false;
  let frame, partial = false, replace = false, damage = [];
  let recovering = false, recoveries = 0;
  let cellWidth, cellHeight;
  let work = Promise.resolve();

  const send = (event) => {
    if (viewOnly || !generation || socket?.readyState !== WebSocket.OPEN ||
        (!ready && event.type !== Input.releaseAll)) return;
    if (event.type === Input.move && socket.bufferedAmount > 64 * 1024) return;
    if (event.type !== Input.releaseAll && socket.bufferedAmount > 256 * 1024) {
      void finish(new Error('The relay connection cannot keep up with terminal input.'));
      return;
    }
    socket.send(writeMessage(Message.input, generation, 0, encodeInput(event)));
  };

  const finish = async (error) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(startup);
    clearTimeout(resizeTimer);
    input.dispose();
    stdin.off('data', receiveInput);
    stdout.off('resize', resize);
    try { input.release(); } catch {
      // The relay releases input when the connection closes.
    }
    socket?.close();
    try {
      await terminal.stop();
    } catch {
      // The terminal may already have closed.
    }
    if (error) {
      console.error('screen-relay-kitty: ' + error.message);
      process.exitCode = 1;
    }
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  };

  const enqueue = (action) => {
    work = work.then(() => stopped ? undefined : action()).catch(finish);
  };

  const paint = async (force) => {
    if (!frame || partial) return;
    input.layout = await terminal.show(frame, damage, force || replace);
    damage = [];
    replace = false;
  };

  const input = new TerminalInput({
    send,
    quit: () => { void finish(); },
    cellSize: (width, height) => {
      if (width === cellWidth && height === cellHeight) return;
      cellWidth = width;
      cellHeight = height;
      enqueue(async () => {
        await terminal.updateCellSize(width, height, viewOnly);
        input.pixelMouse = !viewOnly;
        await paint(true);
      });
    },
    graphicsError: (error) => { void finish(new Error('Kitty graphics: ' + error)); },
  });
  const receiveInput = (data) => { if (!stopped) input.push(data); };
  const resize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => enqueue(async () => {
      await terminal.queryCellSize();
      await paint(true);
    }), 30);
  };

  async function receiveFrame(data) {
    const message = readMessage(data);
    if (message.type === Message.cursor) return;
    if (message.type !== Message.tiles) throw new Error('The relay did not send a tiles stream.');
    if ((generation && message.generation !== generation) || message.sequence !== sequence + 1) {
      throw new Error('Unexpected tiles frame sequence.');
    }
    generation = message.generation;
    sequence = message.sequence;

    if (!recovering || keyframePayload(message.payload)) {
      let update;
      try {
        update = applyTiles(message.payload, frame);
      } catch (error) {
        if (++recoveries > 2) throw error;
        recovering = true;
        frame = undefined;
        partial = false;
        replace = false;
        damage = [];
        socket.send(writeMessage(Message.keyframe, generation));
      }
      if (update) {
        recovering = false;
        frame = update.frame;
        partial = update.partial;
        replace ||= update.keyframe;
        if (!replace) damage = damage.concat(update.damage);
        if (!partial) {
          await paint(false);
          recoveries = 0;
          ready = true;
          clearTimeout(startup);
        }
      }
    }
    if (!stopped && socket.readyState === WebSocket.OPEN) {
      socket.send(writeMessage(Message.ack, generation, sequence));
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void finish(); });
  stdout.once('error', (error) => { void finish(error); });
  stdin.once('error', (error) => { void finish(error); });
  stdin.once('end', () => { void finish(); });
  stdin.on('data', receiveInput);
  stdout.on('resize', resize);
  try {
    await terminal.start(viewOnly);
    if (stopped) return;
    socket = new WebSocket(url, protocols);
    socket.binaryType = 'arraybuffer';
    startup = setTimeout(() => { void finish(new Error('Timed out waiting for a tiles frame.')); }, 12000);
    socket.addEventListener('message', ({ data }) => enqueue(() => receiveFrame(data)));
    socket.addEventListener('error', () => {
      void finish(new Error('Connection failed. Check the SSH tunnel, relay token, and tiles support.'));
    });
    socket.addEventListener('close', ({ code, reason }) => {
      void finish(new Error(code === 4001 ? 'Another viewer took control.' :
        'Relay disconnected (' + code + (reason ? ', ' + reason : '') + ').'));
    });
  } catch (error) {
    await finish(error);
  }
}

try {
  const config = options(process.argv.slice(2), process.env);
  if (config) await run(config);
  else console.log(help);
} catch (error) {
  console.error('screen-relay-kitty: ' + error.message);
  process.exitCode = 1;
}
