/**
 * Minimal PNG encoder for the clipboard repair: arbitrary RGBA pixels become
 * a valid PNG without a compressor. Rasters land on the page's canvas as
 * ImageData, so the encoder is only the canvas fallback and stays dependency
 * free by emitting stored (uncompressed) Deflate blocks inside a zlib stream.
 */

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * Encode an RGBA raster as PNG bytes.
 * @param width - pixel width.
 * @param height - pixel height.
 * @param pixels - RGBA bytes, `width * height * 4` long.
 * @returns the PNG file bytes.
 */
export function encodePNG(width, height, pixels) {
  const stride = width * 4
  // Every scanline is prefixed with filter type 0 (None).
  const raw = new Uint8Array((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8
  ihdr[9] = 6
  return concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** A zlib stream of stored Deflate blocks (adler32 trailer included). */
function zlibStored(data) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535))
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4)
  out[0] = 0x78
  out[1] = 0x01
  let write = 2
  let read = 0
  for (let block = 0; block < blocks; block += 1) {
    const size = Math.min(65535, data.length - read)
    out[write] = block === blocks - 1 ? 1 : 0
    out[write + 1] = size & 0xff
    out[write + 2] = (size >>> 8) & 0xff
    out[write + 3] = ~size & 0xff
    out[write + 4] = (~size >>> 8) & 0xff
    write += 5
    out.set(data.subarray(read, read + size), write)
    write += size
    read += size
  }
  let low = 1
  let high = 0
  for (let index = 0; index < data.length; index += 1) {
    low = (low + data[index]) % 65521
    high = (high + low) % 65521
  }
  out[write] = (high >>> 8) & 0xff
  out[write + 1] = high & 0xff
  out[write + 2] = (low >>> 8) & 0xff
  out[write + 3] = low & 0xff
  return out
}
