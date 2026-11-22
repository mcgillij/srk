import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { inflateSync, zstdCompressSync } from 'node:zlib';
import { TerminalInput } from './input.mjs';
import { applyTiles, encodeInput, Input, Message, readMessage, writeMessage } from './protocol.mjs';
import { framePlacement, KittyTerminal } from './terminal.mjs';

function framePayload(flags, ops, rgb) {
  const header = Buffer.alloc(20);
  header[0] = 1;
  header[1] = flags;
  header.writeUInt16BE(4, 2);
  header.writeUInt16BE(3, 4);
  header.writeUInt16BE(ops.length, 14);
  const blob = rgb ? zstdCompressSync(rgb) : Buffer.alloc(0);
  header.writeUInt32BE(blob.length, 16);
  return Buffer.concat([header, ...ops.map((op) => Buffer.from(op.replaceAll(' ', ''), 'hex')), blob]);
}

test('tiles keyframes, pixels, fills, and overlapping copies', () => {
  const pixels = Buffer.from(Array.from({ length: 36 }, (_, i) => i + 1));
  const key = framePayload(1, ['02 0000 0000 0004 0003'], pixels);
  const { frame } = applyTiles(key);
  assert.deepEqual(frame.rgb, pixels);
  const copy = '01 0000 0000 0001 0001 0003 0002';
  const fill = '03 0000 0000 0001 0001 ffddee';
  const update = applyTiles(framePayload(4, [copy, fill]), frame);
  assert.equal(update.partial, true);
  assert.deepEqual(frame.rgb.subarray(15, 24), pixels.subarray(0, 9));
  assert.deepEqual(frame.rgb.subarray(27, 36), pixels.subarray(12, 21));
  assert.deepEqual(frame.rgb.subarray(0, 3), Buffer.from('ffddee', 'hex'));
  assert.deepEqual(update.damage, [{ x: 1, y: 1, w: 3, h: 2 }, { x: 0, y: 0, w: 1, h: 1 }]);
  const unchanged = Buffer.from(frame.rgb);
  const invalidCopy = '01 0004 0000 0001 0001 0003 0002';
  assert.throws(() => applyTiles(framePayload(0, [fill, invalidCopy]), frame), /copy source/);
  assert.deepEqual(frame.rgb, unchanged);
});

test('screen-relay input envelope carries signed wheel delta and coordinates', () => {
  const data = writeMessage(Message.input, 7, 0, encodeInput({
    type: Input.wheel, code: 1, value: -120, x: 123, y: 65535, buttons: 1,
  }));
  const message = readMessage(data);
  assert.equal(message.generation, 7);
  assert.equal(message.sequence, 0);
  assert.equal(message.type, Message.input);
  assert.equal(message.payload.toString('hex'), '06000001ffffff88007bffff00010000');
  assert.throws(() => readMessage(data.subarray(0, 32)), /Invalid screen-relay message/);
});

test('terminal input sends Unicode, shortcuts, arrow keys, mouse, and focus release', () => {
  const events = [];
  let quit = false;
  const input = new TerminalInput({
    send: (event) => events.push(event), quit: () => { quit = true; },
    cellSize: () => {}, graphicsError: assert.fail,
  });
  const unicode = Buffer.from('é');
  input.push(unicode.subarray(0, 1));
  input.push(unicode.subarray(1));
  input.push(Buffer.from('\x1b[99;9u\x1b[1;5C\x1b[92;5u'));
  assert.equal(quit, true);
  assert.deepEqual(events.splice(0), [
    { type: Input.text, value: 233 },
    { type: Input.keyDown, code: 227 }, { type: Input.keyDown, code: 6 },
    { type: Input.keyUp, code: 6 }, { type: Input.keyUp, code: 227 },
    { type: Input.keyDown, code: 224 }, { type: Input.keyDown, code: 79 },
    { type: Input.keyUp, code: 79 }, { type: Input.keyUp, code: 224 },
  ]);
  input.layout = { left: 0, top: 20, width: 101, height: 101, cellWidth: 10, cellHeight: 20 };
  input.pixelMouse = true;
  input.push(Buffer.from('\x1b[<0;51;'));
  input.push(Buffer.from('71M\x1b[<32;101;121M\x1b[<0;101;121m\x1b[<64;51;71M\x1b[O'));
  assert.deepEqual(events, [
    { type: Input.buttonDown, code: 1, x: 32768, y: 32768, buttons: 1 },
    { type: Input.move, x: 65535, y: 65535, buttons: 1 },
    { type: Input.buttonUp, code: 1, x: 65535, y: 65535, buttons: 0 },
    { type: Input.wheel, code: 0, value: -120, x: 32768, y: 32768, buttons: 0 },
    { type: Input.releaseAll },
  ]);
  input.dispose();
});

test('unmodified Kitty keyboard text can omit the modifier field', () => {
  const events = [];
  const input = new TerminalInput({
    send: (event) => events.push(event),
    quit: assert.fail, cellSize: assert.fail, graphicsError: assert.fail,
  });
  input.push(Buffer.from('\x1b[97;;97u\x1b[97;:2;97u\x1b[97;:3u'));
  input.push(Buffer.from('\x1b[97:65;2;65u\x1b[32;;32u\x1b[127u'));
  assert.deepEqual(events, [
    { type: Input.text, value: 97 },
    { type: Input.text, value: 97 },
    { type: Input.text, value: 65 },
    { type: Input.text, value: 32 },
    { type: Input.keyDown, code: 42 },
    { type: Input.keyUp, code: 42 },
  ]);
  input.dispose();
});

test('Kitty uploads a chunked RGB image and applies a single-escape pixel edit', async () => {
  let sent = '';
  const output = { columns: 80, rows: 30, write(data, done) { sent += data; done(); } };
  const input = { isRaw: false, setRawMode(raw) { this.isRaw = raw; }, resume() {}, pause() {} };
  const terminal = new KittyTerminal(input, output, { TERM: 'xterm-kitty' });
  await terminal.start(false);
  await terminal.updateCellSize(10, 20, false);
  const frame = { width: 64, height: 64, rgb: randomBytes(64 * 64 * 3) };
  const placement = framePlacement(frame, 80, 30, 10, 20);
  assert.equal(placement.extent, 'r=30');
  assert.equal(placement.left, 100);
  await terminal.show(frame, []);
  const commands = [...sent.matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/g)];
  assert.ok(commands.length > 1);
  assert.match(commands[0][1], /a=T,f=24,o=z/);
  assert.match(commands.at(-1)[1], /m=0/);
  assert.ok(commands.every((command) => command[2].length <= 4096));
  assert.deepEqual(inflateSync(Buffer.from(commands.map((command) => command[2]).join(''), 'base64')), frame.rgb);
  sent = '';
  frame.rgb.set([3, 5, 7], 0);
  await terminal.show(frame, [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.match(sent, /\x1b_Ga=f,r=1,X=1,[^;]+;AwUH\x1b\\/);
  await terminal.stop();
  assert.equal(input.isRaw, false);
  assert.ok(sent.endsWith('\x1b[?1049l'));
});

test('Ghostty gets complete images', async () => {
  let sent = '';
  const input = { setRawMode() {}, resume() {}, pause() {} };
  const output = { columns: 80, rows: 24, write(data, done) { sent += data; done(); } };
  const terminal = new KittyTerminal(input, output, { TERM: 'xterm-ghostty' });
  await terminal.start(true);
  const frame = { width: 2, height: 2, rgb: Buffer.alloc(12) };
  await terminal.show(frame, []);
  sent = '';
  frame.rgb[0] = 42;
  await terminal.show(frame, [{ x: 0, y: 0, w: 1, h: 1 }]);
  assert.match(sent, /\x1b_Ga=T,/);
  assert.doesNotMatch(sent, /\x1b_Ga=f,/);
  await terminal.stop();
  assert.doesNotMatch(sent, /\x1b\[\?100[346]l/);
});
