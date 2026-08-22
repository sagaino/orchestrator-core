/**
 * P7.2 deterministic PNG comparison and evidence composition.
 *
 * The implementation intentionally supports the PNG formats emitted by
 * Playwright (8-bit RGB/RGBA) plus the small grayscale variants used by
 * deterministic fixtures. No external image service is involved.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterRow(filtered, previous, bytesPerPixel, filterType) {
  const row = Buffer.alloc(filtered.length);
  for (let index = 0; index < filtered.length; index += 1) {
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
    const above = previous?.[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? (previous?.[index - bytesPerPixel] ?? 0) : 0;
    const value = filtered[index];
    if (filterType === 0) row[index] = value;
    else if (filterType === 1) row[index] = (value + left) & 0xff;
    else if (filterType === 2) row[index] = (value + above) & 0xff;
    else if (filterType === 3) row[index] = (value + Math.floor((left + above) / 2)) & 0xff;
    else if (filterType === 4) row[index] = (value + paeth(left, above, upperLeft)) & 0xff;
    else throw new Error(`PNG filter type ${filterType} tidak didukung.`);
  }
  return row;
}

function parsePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("PNG signature tidak valid.");
  let offset = 8;
  let header;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") header = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!header || idat.length === 0) throw new Error("PNG IHDR/IDAT tidak lengkap.");
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  const channelCount = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!width || !height || bitDepth !== 8 || !channelCount || interlace !== 0) throw new Error("PNG harus 8-bit non-interlaced RGB/RGBA/grayscale.");
  const bytesPerPixel = channelCount;
  const rowBytes = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < height * (rowBytes + 1)) throw new Error("PNG scanline data tidak lengkap.");
  const pixels = Buffer.alloc(width * height * 4);
  let rawOffset = 0;
  let previous = null;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[rawOffset];
    const filtered = raw.subarray(rawOffset + 1, rawOffset + 1 + rowBytes);
    rawOffset += rowBytes + 1;
    const row = unfilterRow(filtered, previous, bytesPerPixel, filterType);
    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const target = (y * width + x) * 4;
      if (colorType === 6) {
        pixels[target] = row[source]; pixels[target + 1] = row[source + 1]; pixels[target + 2] = row[source + 2]; pixels[target + 3] = row[source + 3];
      } else if (colorType === 2) {
        pixels[target] = row[source]; pixels[target + 1] = row[source + 1]; pixels[target + 2] = row[source + 2]; pixels[target + 3] = 255;
      } else if (colorType === 4) {
        pixels[target] = row[source]; pixels[target + 1] = row[source]; pixels[target + 2] = row[source]; pixels[target + 3] = row[source + 1];
      } else {
        pixels[target] = row[source]; pixels[target + 1] = row[source]; pixels[target + 2] = row[source]; pixels[target + 3] = 255;
      }
    }
    previous = row;
  }
  return { width, height, pixels };
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

export function encodeRgbaPng({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("PNG dimensions tidak valid.");
  if (!pixels || pixels.length !== width * height * 4) throw new Error("RGBA pixel buffer tidak valid.");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    Buffer.from(pixels).copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

export function readPng(filePath) {
  return parsePng(fs.readFileSync(filePath));
}

function writePng(filePath, image) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, encodeRgbaPng(image), { mode: 0o600 });
  return filePath;
}

function composeSideBySide(actual, reference) {
  const image = { width: actual.width + reference.width, height: Math.max(actual.height, reference.height), pixels: Buffer.alloc((actual.width + reference.width) * Math.max(actual.height, reference.height) * 4) };
  for (let y = 0; y < actual.height; y += 1) for (let x = 0; x < actual.width; x += 1) {
    const source = (y * actual.width + x) * 4;
    const target = (y * image.width + x) * 4;
    actual.pixels.copy(image.pixels, target, source, source + 4);
  }
  for (let y = 0; y < reference.height; y += 1) for (let x = 0; x < reference.width; x += 1) {
    const source = (y * reference.width + x) * 4;
    const target = (y * image.width + actual.width + x) * 4;
    reference.pixels.copy(image.pixels, target, source, source + 4);
  }
  return image;
}

function composeOverlay(actual, reference) {
  const image = { width: Math.max(actual.width, reference.width), height: Math.max(actual.height, reference.height), pixels: Buffer.alloc(Math.max(actual.width, reference.width) * Math.max(actual.height, reference.height) * 4) };
  for (let y = 0; y < image.height; y += 1) for (let x = 0; x < image.width; x += 1) {
    const target = (y * image.width + x) * 4;
    const actualIndex = (y * actual.width + x) * 4;
    const referenceIndex = (y * reference.width + x) * 4;
    const hasActual = x < actual.width && y < actual.height;
    const hasReference = x < reference.width && y < reference.height;
    for (let channel = 0; channel < 4; channel += 1) {
      const actualValue = hasActual ? actual.pixels[actualIndex + channel] : 0;
      const referenceValue = hasReference ? reference.pixels[referenceIndex + channel] : 0;
      image.pixels[target + channel] = hasActual && hasReference ? Math.round((actualValue + referenceValue) / 2) : (hasActual ? actualValue : referenceValue);
    }
  }
  return image;
}

function unknownComparison(reason, notes = []) {
  return { status: "UNKNOWN", method: "pixel-diff-v1", score: null, mismatchPixels: null, notes: [reason, ...notes], diagnostics: { reason, artifacts: null } };
}

export function compareVisualArtifacts({ actualPath, referencePath, comparisonRoot, evidenceId, pixelThreshold = 16, maxMismatchRatio = 0.01 } = {}) {
  if (!actualPath || !fs.existsSync(actualPath)) return { comparison: unknownComparison("ACTUAL_CAPTURE_UNAVAILABLE") };
  if (!referencePath || !fs.existsSync(referencePath)) return { comparison: unknownComparison("REFERENCE_UNAVAILABLE") };
  let actual;
  let reference;
  try {
    actual = readPng(actualPath);
    reference = readPng(referencePath);
  } catch (error) {
    return { comparison: unknownComparison("REFERENCE_DECODE_FAILED", [error.message]) };
  }
  const sideBySidePath = path.join(comparisonRoot, `${evidenceId}-side-by-side.png`);
  const overlayPath = path.join(comparisonRoot, `${evidenceId}-overlay.png`);
  writePng(sideBySidePath, composeSideBySide(actual, reference));
  writePng(overlayPath, composeOverlay(actual, reference));
  const totalPixels = Math.max(actual.width * actual.height, reference.width * reference.height);
  let mismatchPixels = 0;
  const comparableWidth = Math.min(actual.width, reference.width);
  const comparableHeight = Math.min(actual.height, reference.height);
  for (let y = 0; y < comparableHeight; y += 1) for (let x = 0; x < comparableWidth; x += 1) {
    const actualIndex = (y * actual.width + x) * 4;
    const referenceIndex = (y * reference.width + x) * 4;
    let different = false;
    for (let channel = 0; channel < 4; channel += 1) if (Math.abs(actual.pixels[actualIndex + channel] - reference.pixels[referenceIndex + channel]) > pixelThreshold) different = true;
    if (different) mismatchPixels += 1;
  }
  mismatchPixels += totalPixels - comparableWidth * comparableHeight;
  const score = totalPixels === 0 ? 0 : Number((1 - mismatchPixels / totalPixels).toFixed(6));
  const dimensionMismatch = actual.width !== reference.width || actual.height !== reference.height;
  const status = !dimensionMismatch && mismatchPixels / totalPixels <= maxMismatchRatio ? "PASS" : "FAIL";
  return {
    comparison: {
      status,
      method: "pixel-diff-v1",
      score,
      mismatchPixels,
      notes: status === "PASS" ? ["Screenshot sesuai reference dalam threshold yang ditetapkan."] : [dimensionMismatch ? "Viewport capture mismatch: dimensi actual dan reference berbeda." : "Pixel mismatch melewati threshold."],
      diagnostics: {
        pixelThreshold,
        maxMismatchRatio,
        mismatchRatio: Number((mismatchPixels / totalPixels).toFixed(6)),
        dimensions: { actual: { width: actual.width, height: actual.height }, reference: { width: reference.width, height: reference.height } },
        artifacts: { sideBySidePath, overlayPath },
      },
    },
    dimensions: { actual: { width: actual.width, height: actual.height }, reference: { width: reference.width, height: reference.height } },
  };
}

