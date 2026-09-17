'use strict';
/**
 * QR rendering — uses the vendored MIT QR encoder (server/qrcode.js, Kazuhiko Arase)
 * and emits self-contained SVG, so the browser never needs an external call.
 */

const qrcode = require('./qrcode');

function svg(text, opts = {}) {
  const scale = opts.scale || 6;
  const margin = opts.margin === undefined ? 4 : opts.margin;
  const dark = opts.dark || '#101828';
  const light = opts.light || '#ffffff';
  const ec = opts.ec || 'M';

  let qr;
  for (const level of [ec, 'L']) {
    try {
      qr = qrcode(0, level);
      qr.addData(String(text));
      qr.make();
      break;
    } catch (err) {
      qr = null;
    }
  }
  if (!qr) throw new Error('QR payload too long to encode');

  const n = qr.getModuleCount();
  const size = (n + margin * 2) * scale;
  const parts = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(row, col)) {
        parts.push(`M${(col + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    `<path d="${parts.join('')}" fill="${dark}"/>`,
    '</svg>'
  ].join('');
}

module.exports = { svg };
