// SPDX-License-Identifier: Apache-2.0
// Tiles decoding adapted from Gaurav-Gosain/screen-relay, tests/e2e/tiles-client.mjs.
import { zstdDecompressSync } from 'node:zlib';

const headerSize = 20;
const maxMessageSize = 8_388_640;
const maxFramebufferSize = 128 * 1024 * 1024;

export const Message = { ack: 2, input: 3, cursor: 6, tiles: 8, keyframe: 9 };
export const Input = {
  keyDown: 1, keyUp: 2, move: 3, buttonDown: 4, buttonUp: 5, wheel: 6, releaseAll: 7, text: 8,
};

export function readMessage(data) {
  const bytes = Buffer.from(data);
  if (bytes.length < headerSize || bytes.length > maxMessageSize ||
      bytes.toString('ascii', 0, 4) !== 'NSL1' || bytes[4] !== 1 ||
      bytes.readUInt32BE(16) !== bytes.length - headerSize || !bytes.readUInt32BE(8)) {
    throw new Error('Invalid screen-relay message');
  }
  return {
    type: bytes[5], generation: bytes.readUInt32BE(8), sequence: bytes.readUInt32BE(12),
    payload: bytes.subarray(headerSize),
  };
}

export function writeMessage(type, generation, sequence = 0, payload = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(headerSize + payload.length);
  bytes.write('NSL1');
  bytes[4] = 1;
  bytes[5] = type;
  bytes.writeUInt32BE(generation, 8);
  bytes.writeUInt32BE(sequence, 12);
  bytes.writeUInt32BE(payload.length, 16);
  payload.copy(bytes, headerSize);
  return bytes;
}

export function encodeInput({ type, code = 0, value = 0, x = 0, y = 0, buttons = 0 }) {
  const input = Buffer.alloc(16);
  input[0] = type;
  input.writeUInt16BE(code, 2);
  input.writeInt32BE(value, 4);
  input.writeUInt16BE(x, 8);
  input.writeUInt16BE(y, 10);
  input.writeUInt16BE(buttons, 12);
  return input;
}

function readOperations(payload, width, height) {
  const blobSize = payload.readUInt32BE(16);
  const operationsEnd = payload.length - blobSize;
  let offset = headerSize;
  let pixelBytes = 0;
  const operations = [];

  const read = (length) => {
    if (offset + length > operationsEnd) throw new Error('Truncated tiles operation');
    const bytes = payload.subarray(offset, offset + length);
    offset += length;
    return bytes;
  };

  const count = payload.readUInt16BE(14);
  for (let i = 0; i < count; i++) {
    const kind = read(1)[0];
    if (kind < 1 || kind > 3) throw new Error('Unknown tiles operation');

    const source = kind === 1 ? read(4) : null;
    const rect = read(8);
    const x = rect.readUInt16BE(0), y = rect.readUInt16BE(2);
    const w = rect.readUInt16BE(4), h = rect.readUInt16BE(6);
    if (!w || !h || x + w > width || y + h > height) {
      throw new Error('Tiles rectangle exceeds the framebuffer');
    }
    const op = { kind, x, y, w, h };
    if (kind === 1) {
      op.sx = source.readUInt16BE(0);
      op.sy = source.readUInt16BE(2);
      if (op.sx + w > width || op.sy + h > height) throw new Error('Invalid tiles copy source');
    } else if (kind === 2) {
      op.pixelOffset = pixelBytes;
      pixelBytes += w * h * 3;
    } else {
      op.color = read(3);
    }
    operations.push(op);
  }

  if (offset !== operationsEnd || !!blobSize !== !!pixelBytes || pixelBytes > maxFramebufferSize) {
    throw new Error('Invalid tiles payload length');
  }
  const pixels = blobSize ? zstdDecompressSync(payload.subarray(operationsEnd), { maxOutputLength: pixelBytes }) : null;
  if (pixels && pixels.length !== pixelBytes) throw new Error('Invalid tiles pixel count');
  return { operations, pixels };
}

function applyCopy(buffer, stride, { x, y, w, h, sx, sy }) {
  const reverse = y > sy;
  for (let row = 0; row < h; row++) {
    const index = reverse ? h - row - 1 : row;
    const source = (sy + index) * stride + sx * 3;
    const target = (y + index) * stride + x * 3;
    buffer.copyWithin(target, source, source + w * 3);
  }
}

export function keyframePayload(payload) {
  return (payload[1] & 1) !== 0;
}

export function applyTiles(payload, frame) {
  if (payload.length < headerSize || payload[0] !== 1 || (payload[1] & ~5)) {
    throw new Error('Invalid tiles frame header');
  }
  const keyframe = keyframePayload(payload);
  const width = payload.readUInt16BE(2), height = payload.readUInt16BE(4);
  if (!width || !height || width * height * 3 > maxFramebufferSize) {
    throw new Error('Unsupported tiles framebuffer size');
  }
  if (!keyframe && (frame?.width !== width || frame.height !== height)) {
    throw new Error('Tiles frame needs a keyframe');
  }

  // Validate all operations before changing the current frame.
  const { operations, pixels } = readOperations(payload, width, height);
  const rgb = keyframe ? Buffer.alloc(width * height * 3) : frame.rgb;
  const stride = width * 3;
  for (const op of operations) {
    if (op.kind === 1) {
      applyCopy(rgb, stride, op);
      continue;
    }
    for (let row = 0; row < op.h; row++) {
      const target = (op.y + row) * stride + op.x * 3;
      const length = op.w * 3;
      if (op.kind === 2) {
        const source = op.pixelOffset + row * length;
        pixels.copy(rgb, target, source, source + length);
      } else {
        rgb.fill(op.color, target, target + length);
      }
    }
  }
  return {
    frame: { width, height, rgb }, keyframe, partial: (payload[1] & 4) !== 0,
    damage: operations.map(({ x, y, w, h }) => ({ x, y, w, h })),
  };
}
