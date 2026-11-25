/** Media-type checks for clipboard payloads the page can hand over. */

/** PNG signature (the eight bytes every PNG starts with). */
export function isPNG(bytes) {
  return bytes.length > 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

/** GIF87a / GIF89a signature. */
export function isGIF(bytes) {
  return bytes.length > 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
}

/** JPEG start-of-image marker. */
export function isJPEG(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

/** Home of a classic TIFF document inside a payload: its byte order and IFD offset. */
export function tiffHeaderAt(bytes, offset) {
  const first = bytes[offset]
  const classic = bytes[offset + 2] === 42 || bytes[offset + 3] === 42
  if (classic && first === 0x49 && bytes[offset + 1] === 0x49) return { start: offset, little: true }
  if (classic && first === 0x4d && bytes[offset + 1] === 0x4d) return { start: offset, little: false }
  return undefined
}

/** Unsigned big-endian 32-bit integer. */
export function readU32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
