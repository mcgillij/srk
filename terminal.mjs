import { randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { deflate } from 'node:zlib';

const compress = promisify(deflate);
const csi = '\x1b[';
const syncStart = csi + '?2026h';
const syncEnd = csi + '?2026l';
const chunkSize = 4096;
const patchPixels = chunkSize / 4;
const maxPatchBytes = 96 * 1024;

function graphics(parameters, payload = '') {
  return '\x1b_G' + parameters + ';' + payload + '\x1b\\';
}

export function framePlacement(frame, columns, rows, cellWidth, cellHeight) {
  const availableWidth = columns * cellWidth;
  const availableHeight = rows * cellHeight;
  const byWidth = availableWidth / frame.width <= availableHeight / frame.height;
  const scale = byWidth ? availableWidth / frame.width : availableHeight / frame.height;
  const width = frame.width * scale, height = frame.height * scale;
  const column = Math.max(0, Math.floor((availableWidth - width) / (2 * cellWidth)));
  const row = Math.max(0, Math.floor((availableHeight - height) / (2 * cellHeight)));
  return {
    width, height, cellWidth, cellHeight, left: column * cellWidth, top: row * cellHeight,
    cursor: csi + (row + 1) + ';' + (column + 1) + 'H',
    extent: byWidth ? 'c=' + columns : 'r=' + rows,
  };
}

function upload(image, frame, placement, compressed) {
  const data = compressed.toString('base64');
  let output = placement.cursor;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const continuation = offset + chunkSize < data.length ? 1 : 0;
    const first = offset === 0
      ? 'a=T,f=24,o=z,i=' + image + ',p=1,s=' + frame.width + ',v=' + frame.height + ',C=1,' + placement.extent + ','
      : '';
    output += graphics(first + 'q=1,m=' + continuation, data.slice(offset, offset + chunkSize));
  }
  return output;
}

function patch(image, frame, rect) {
  const pixels = Buffer.allocUnsafe(rect.w * rect.h * 3);
  for (let row = 0; row < rect.h; row++) {
    const source = ((rect.y + row) * frame.width + rect.x) * 3;
    frame.rgb.copy(pixels, row * rect.w * 3, source, source + rect.w * 3);
  }
  return graphics(
    'a=f,r=1,X=1,f=24,q=2,i=' + image + ',x=' + rect.x + ',y=' + rect.y +
    ',s=' + rect.w + ',v=' + rect.h, pixels.toString('base64'),
  );
}

function patches(image, frame, damage) {
  let output = '';
  for (const rect of damage) {
    const stripWidth = Math.min(rect.w, patchPixels);
    const stripHeight = Math.floor(patchPixels / stripWidth);
    for (let y = 0; y < rect.h; y += stripHeight) {
      for (let x = 0; x < rect.w; x += stripWidth) {
        output += patch(image, frame, {
          x: rect.x + x, y: rect.y + y, w: Math.min(stripWidth, rect.w - x),
          h: Math.min(stripHeight, rect.h - y),
        });
      }
    }
  }
  return output;
}

export class KittyTerminal {
  #image = randomInt(1, 0x7fffffff);
  #displayed;
  #cellWidth = 8;
  #cellHeight = 16;
  #pixelMouse = false;
  #active = false;
  #viewOnly = false;

  constructor(input, output, env = process.env) {
    this.input = input;
    this.output = output;
    this.animation = env.TERM === 'xterm-kitty' && !env.TMUX;
    this.wasRaw = input.isRaw;
  }

  write(data) {
    return new Promise((resolve, reject) => {
      this.output.write(data, (error) => error ? reject(error) : resolve());
    });
  }

  start(viewOnly) {
    this.input.setRawMode(true);
    this.#active = true;
    this.#viewOnly = viewOnly;
    this.input.resume();
    const mouse = viewOnly ? '' : csi + '?1003h' + csi + '?1006h' + csi + '?1004h' + csi + '?2004h';
    return this.write(csi + '?1049h' + csi + '?25l' + csi + '>29u' + mouse + csi + '16t' +
      csi + '2J' + csi + 'H' + 'Connecting to screen-relay. Ctrl+\\ exits.');
  }

  queryCellSize() {
    return this.write(csi + '16t');
  }

  async updateCellSize(width, height, viewOnly) {
    this.#cellWidth = width;
    this.#cellHeight = height;
    if (!viewOnly && !this.#pixelMouse) {
      this.#pixelMouse = true;
      await this.write(csi + '?1016h');
    }
  }

  async show(frame, damage, force = false) {
    const next = framePlacement(frame, Math.max(1, this.output.columns || 80),
      Math.max(1, this.output.rows || 24), this.#cellWidth, this.#cellHeight);
    const state = [frame.width, frame.height, next.cursor, next.extent];
    const replace = force || !this.#displayed || state.some((value, i) => this.#displayed[i] !== value);
    if (!replace && !damage.length) return next;

    const area = damage.reduce((sum, rect) => sum + rect.w * rect.h * 3, 0);
    const canPatch = this.animation && !replace && damage.length <= 64 && area <= maxPatchBytes;
    let update;
    if (canPatch) {
      update = patches(this.#image, frame, damage);
    } else {
      const full = await compress(frame.rgb, { level: 1 });
      update = (replace ? csi + '2J' : '') + upload(this.#image, frame, next, full);
    }
    if (!this.#active) return next;
    await this.write(syncStart + update + syncEnd);
    this.#displayed = state;
    return next;
  }

  stop() {
    if (!this.#active) return Promise.resolve();
    this.#active = false;
    this.input.setRawMode(this.wasRaw ?? false);
    this.input.pause();
    const mouse = this.#viewOnly ? '' :
      csi + '?2004l' + (this.#pixelMouse ? csi + '?1016l' : '') + csi + '?1006l' + csi + '?1003l' + csi + '?1004l';
    return this.write(graphics('a=d,d=I,q=2,i=' + this.#image) +
      csi + '?2026l' + mouse + csi + '<u' + csi + '?25h' + csi + '?1049l');
  }
}
