import { StringDecoder } from 'node:string_decoder';
import { Input } from './protocol.mjs';

const control = 4;
const modifiers = [[1, 225], [2, 226], [4, 224], [8, 227]];
const terminalKeys = {
  A: 82, B: 81, C: 79, D: 80, H: 74, F: 77, P: 58, Q: 59, R: 60, S: 61, Z: 43,
};
const tildeKeys = {
  1: 74, 2: 73, 3: 76, 4: 77, 5: 75, 6: 78, 7: 74, 8: 77,
  11: 58, 12: 59, 13: 60, 14: 61, 15: 62, 17: 63, 18: 64, 19: 65,
  20: 66, 21: 67, 23: 68, 24: 69,
};
const punctuation = {
  ' ': 44, '-': 45, '=': 46, '[': 47, ']': 48, '\\': 49, ';': 51, "'": 52,
  '\x60': 53, ',': 54, '.': 55, '/': 56,
};
const specialKeys = {
  9: 43, 13: 40, 27: 41, 127: 42,
  57348: 73, 57349: 76, 57350: 80, 57351: 79, 57352: 82, 57353: 81,
  57354: 75, 57355: 78, 57356: 74, 57357: 77,
  57409: 99, 57410: 84, 57411: 85, 57412: 86, 57413: 87, 57414: 88, 57415: 103,
};

function keyUsage(key) {
  if (key >= 65 && key <= 90) return key - 65 + 4;
  if (key >= 97 && key <= 122) return key - 97 + 4;
  if (key >= 49 && key <= 57) return key - 49 + 30;
  if (key === 48) return 39;
  if (key >= 57376 && key <= 57387) return key - 57376 + 104;
  if (key >= 57399 && key <= 57408) return key === 57399 ? 98 : key - 57400 + 89;
  return specialKeys[key] ?? (key < 128 ? punctuation[String.fromCodePoint(key)] : undefined);
}

function printable(code) {
  return code >= 32 && (code < 127 || code >= 160) && code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff);
}

const escape = '\x1b';
const pasteEnd = escape + '[201~';

export class TerminalInput {
  #decoder = new StringDecoder('utf8');
  #pending = '';
  #escapeTimer;
  #pasting = false;
  #buttons = 0;
  layout;
  pixelMouse = false;

  constructor({ send, quit, cellSize, graphicsError }) {
    this.send = send;
    this.quit = quit;
    this.cellSize = cellSize;
    this.graphicsError = graphicsError;
  }

  dispose() {
    clearTimeout(this.#escapeTimer);
  }

  release() {
    this.#buttons = 0;
    this.send({ type: Input.releaseAll });
  }

  #withModifiers(mask, action) {
    const held = modifiers.filter(([bit]) => mask & bit);
    for (const [, code] of held) this.send({ type: Input.keyDown, code });
    action();
    for (const [, code] of held.reverse()) this.send({ type: Input.keyUp, code });
  }

  #tap(code, mask = 0) {
    if (!code) return;
    this.#withModifiers(mask, () => {
      this.send({ type: Input.keyDown, code });
      this.send({ type: Input.keyUp, code });
    });
  }

  #text(code) {
    if (printable(code) || code === 9 || code === 10) this.send({ type: Input.text, value: code });
  }

  #legacy(code, mask = 0) {
    if (code === 28) return this.quit(); // Ctrl+backslash
    if (code === 13 || code === 10) return this.#tap(40, mask);
    if (code === 9) return this.#tap(43, mask);
    if (code === 127 || code === 8) return this.#tap(42, mask);
    if (code >= 1 && code <= 26) return this.#tap(code + 3, mask | control);
    if (mask) return this.#tap(keyUsage(code), mask);
    this.#text(code);
  }

  #key(parameters, final) {
    const [keys, modifier = '1', text = ''] = parameters.split(';');
    const [bits, event] = modifier.split(':');
    if (Number(event) === 3) return;
    const mask = (Number(bits || '1') - 1) & 15;
    if (final === 'u') {
      const [key, shifted, base] = keys.split(':').map(Number);
      if ((key === 92 || base === 92) && mask === control) return this.quit();
      if (!(mask & ~1)) {
        const characters = text ? text.split(':').map(Number) :
          key < 57344 || key > 63743 ? [(mask & 1 ? shifted : 0) || key] : [];
        if (characters.length && characters.every(printable)) {
          for (const character of characters) this.#text(character);
          return;
        }
      }
      this.#tap(keyUsage(base || key) ?? keyUsage(key), mask);
    } else if (final === '~') {
      this.#tap(tildeKeys[keys], mask);
    } else {
      this.#tap(terminalKeys[final], mask | (final === 'Z' ? 1 : 0));
    }
  }

  #mouse(parameters, release) {
    if (!this.layout) return;
    const [button, column, row] = parameters.slice(1).split(';').map(Number);
    if (!Number.isInteger(button) || column < 1 || row < 1 || (button & 128)) return;
    const { left, top, width, height, cellWidth, cellHeight } = this.layout;
    const px = (column - 1) * (this.pixelMouse ? 1 : cellWidth) + (this.pixelMouse ? 0 : cellWidth / 2) - left;
    const py = (row - 1) * (this.pixelMouse ? 1 : cellHeight) + (this.pixelMouse ? 0 : cellHeight / 2) - top;
    const outside = px < 0 || px >= width || py < 0 || py >= height;
    if (outside && !this.#buttons) return;
    const normalize = (value, size) => Math.round(Math.max(0, Math.min(1, value / Math.max(1, size - 1))) * 65535);
    const x = normalize(px, width), y = normalize(py, height);
    const code = (button & 3) + 1;
    const mask = (button >> 2) & 7;
    let input;
    if (button & 64) {
      if (release || outside) return;
      input = { type: Input.wheel, code: code >= 3 ? 1 : 0, value: code % 2 ? -120 : 120 };
    } else if (button & 32) {
      input = { type: Input.move };
    } else if (code <= 3) {
      const bit = 1 << (code - 1);
      if (release ? !(this.#buttons & bit) : outside) return;
      this.#buttons = release ? this.#buttons & ~bit : this.#buttons | bit;
      input = { type: release ? Input.buttonUp : Input.buttonDown, code };
    } else {
      return;
    }
    this.#withModifiers(mask, () => this.send({ ...input, x, y, buttons: this.#buttons }));
  }

  #csi(parameters, final) {
    if ((final === 'M' || final === 'm') && /^<\d+;\d+;\d+$/.test(parameters)) {
      this.#mouse(parameters, final === 'm');
    } else if (final === 't' && /^6;\d+;\d+$/.test(parameters)) {
      const [, height, width] = parameters.split(';').map(Number);
      if (width && height && width <= 1024 && height <= 1024) this.cellSize(width, height);
    } else if (final === 'O' && !parameters) {
      this.release();
    } else if (final === '~' && parameters === '200') {
      this.#pasting = true;
    } else if ('u~ABCDHFPQRSZ'.includes(final) && /^[\d;:]*$/.test(parameters)) {
      this.#key(parameters, final);
    }
  }

  push(bytes) {
    clearTimeout(this.#escapeTimer);
    this.#pending += this.#decoder.write(bytes);
    while (this.#pending) {
      if (this.#pasting) {
        const end = this.#pending.indexOf(pasteEnd);
        const length = end === -1 ? Math.max(0, this.#pending.length - pasteEnd.length) : end;
        if (end === -1 && !length) break;
        const cut = end === -1 && /[\uD800-\uDBFF]/.test(this.#pending[length - 1]) ? length - 1 : length;
        if (end === -1 && !cut) break;
        for (const character of this.#pending.slice(0, cut)) {
          this.#text(character === '\r' ? 10 : character.codePointAt(0));
        }
        this.#pending = this.#pending.slice(cut + (end === -1 ? 0 : pasteEnd.length));
        this.#pasting = end === -1;
        continue;
      }

      const code = this.#pending.codePointAt(0);
      if (code !== 27) {
        this.#pending = this.#pending.slice(code > 65535 ? 2 : 1);
        this.#legacy(code);
        continue;
      }
      if (this.#pending.length === 1) {
        this.#escapeTimer = setTimeout(() => { this.#pending = ''; this.#tap(41); }, 35);
        break;
      }
      const introducer = this.#pending[1];
      if (introducer === '[') {
        const match = /^\x1b\[([ -?]*)([@-~])/.exec(this.#pending);
        if (!match && this.#pending.length <= 256) break;
        this.#pending = this.#pending.slice(match ? match[0].length : 2);
        if (match) this.#csi(match[1], match[2]);
      } else if (introducer === 'O') {
        if (this.#pending.length < 3) break;
        this.#tap(terminalKeys[this.#pending[2]]);
        this.#pending = this.#pending.slice(3);
      } else if ('_^P]'.includes(introducer)) {
        const end = this.#pending.indexOf(escape + '\\', 2);
        if (end < 0 && this.#pending.length <= 8192) break;
        const sequence = this.#pending.slice(2, end);
        this.#pending = end < 0 ? '' : this.#pending.slice(end + 2);
        if (introducer === '_' && sequence.startsWith('G')) {
          const separator = sequence.indexOf(';');
          if (separator > 0 && sequence.slice(separator + 1) !== 'OK') {
            this.graphicsError(sequence.slice(separator + 1));
          }
        }
      } else {
        const altKey = this.#pending.codePointAt(1);
        this.#pending = this.#pending.slice(altKey > 65535 ? 3 : 2);
        this.#legacy(altKey, 2);
      }
    }
  }
}
