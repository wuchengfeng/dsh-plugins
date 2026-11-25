/**
 * Classic TIFF decoding for clipboard payloads.
 *
 * macOS screenshot tools hand copied screenshots to the pasteboard as TIFF,
 * and one screenshot spanning several displays can be several TIFF documents
 * back to back, so this walks every document in the payload instead of
 * trusting the first one. Only the layouts those writers emit are decoded:
 * 8-bit gray, RGB, RGBA with or without an alpha plane, chunky or planar,
 * uncompressed strips, with or without a horizontal predictor.
 */

import { readU32, tiffHeaderAt } from './signature.js'

/** Tile width accepted for a single decoded raster. */
const MAX_SIDE = 4096

/**
 * Every classic TIFF image inside a payload, in payload order.
 * @param bytes - the clipboard payload.
 * @returns the decodable images; decoding stops at the first layout it does not support.
 */
export function tiffImages(bytes) {
  const images = []
  let offset = 0
  for (;;) {
    if (offset + 8 > bytes.length) break
    const header = tiffHeaderAt(bytes, offset)
    if (header === undefined) break
    const image = tiffImage(bytes, header)
    if (image === undefined) break
    images.push(image)
    offset = image.end
  }
  return images
}

/**
 * Decode one classic TIFF document.
 * @param bytes - the clipboard payload.
 * @param header - the document's byte order and header offset.
 * @returns the RGBA raster and the offset just past the document, or undefined when the layout is unsupported.
 */
function tiffImage(bytes, header) {
  const { start, little } = header
  const u16 = offset => (little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1])
  const u32 = offset => (little
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
    : readU32(bytes, offset))
  // A BigTIFF (version 43) or a document whose header points outside the
  // payload is not something this decoder can walk safely.
  if (u16(start + 2) !== 42) return undefined

  const tags = new Map()
  const ifd = start + u32(start + 4)
  if (ifd + 2 > bytes.length) return undefined
  const count = u16(ifd)
  if (ifd + 2 + count * 12 > bytes.length) return undefined
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12
    tags.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), field: entry + 8 })
  }

  const scalar = (tag) => {
    if (tag === undefined || tag.count !== 1) return undefined
    if (tag.type === 3) return u16(tag.field)
    if (tag.type === 4) return u32(tag.field)
    return undefined
  }
  const values = (tag) => {
    if (tag === undefined) return []
    const wide = tag.type === 4
    const size = wide ? 4 : 2
    const base = tag.count * size > 4 ? start + u32(tag.field) : tag.field
    const out = []
    for (let index = 0; index < tag.count; index += 1) out.push(wide ? u32(base + index * 4) : u16(base + index * 2))
    return out
  }

  const width = scalar(tags.get(256))
  const height = scalar(tags.get(257))
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) return undefined
  const bits = values(tags.get(258))
  const compression = scalar(tags.get(259)) ?? 1
  const photometric = scalar(tags.get(262)) ?? 2
  const samples = scalar(tags.get(277)) ?? 1
  const rowsPerStrip = scalar(tags.get(278)) ?? height
  const planar = scalar(tags.get(284)) ?? 1
  const predictor = scalar(tags.get(317)) ?? 1
  const offsets = values(tags.get(273))
  const byteCounts = values(tags.get(279))
  if (offsets.length === 0 || offsets.length !== byteCounts.length) return undefined
  if (bits.some(value => value !== 8)) return undefined
  if (compression !== 1 && compression !== 8 && compression !== 32946 && compression !== 32773) return undefined
  if (planar !== 1 && planar !== 2) return undefined
  if (predictor < 1 || predictor > 2) return undefined
  if (photometric === 2) {
    if (samples !== 3 && samples !== 4) return undefined
  } else if (photometric === 0 || photometric === 1) {
    if (samples !== 1) return undefined
  } else {
    return undefined
  }
  const planes = planar === 2 ? samples : 1
  if (offsets.length % planes !== 0) return undefined

  // The document ends where its metadata tables and strip data end; a
  // multi-display screenshot puts the next TIFF document right after it.
  let end = start + 8
  for (const tag of tags.values()) {
    const size = tag.type === 4 ? 4 : 2
    const base = tag.count * size > 4 ? start + u32(tag.field) : tag.field
    end = Math.max(end, base + (tag.count * size > 4 ? tag.count * size : 0))
  }
  for (let index = 0; index < offsets.length; index += 1) {
    end = Math.max(end, start + offsets[index] + byteCounts[index])
  }

  const pixels = new Uint8ClampedArray(width * height * 4)
  const stripsPerPlane = offsets.length / planes
  // Plane-major sample storage (planar 2) needs every plane's rows in place
  // before a pixel can be composed, so decoded rows land here first.
  const planeData = planes === 2 ? Array.from({ length: planes }, () => new Uint8Array(width * height)) : []

  for (let plane = 0; plane < planes; plane += 1) {
    for (let strip = 0; strip < stripsPerPlane; strip += 1) {
      const source = start + offsets[plane * stripsPerPlane + strip]
      const stored = Math.max(0, Math.min(byteCounts[plane * stripsPerPlane + strip], bytes.length - source))
      const firstRow = strip * rowsPerStrip
      if (firstRow >= height) break
      const rows = Math.min(rowsPerStrip, height - firstRow)
      const expected = width * rows
      let data = bytes.subarray(source, source + stored)
      if (compression !== 1) {
        // PackBits and Deflate need a decoder step this synchronous strip
        // loop does not carry; browser-written clipboard TIFF is uncompressed.
        return undefined
      }
      if (data === undefined || data.length < expected) return undefined
      if (predictor === 2) {
        const step = planes === 2 ? 1 : samples
        for (let row = 0; row < rows; row += 1) {
          const base = row * width
          for (let index = step; index < width; index += 1) {
            data[base + index] = (data[base + index] + data[base + index - step]) & 0xff
          }
        }
      }
      if (planes === 2) {
        planeData[plane].set(data.subarray(0, expected), firstRow * width)
        continue
      }
      for (let row = 0; row < rows; row += 1) {
        for (let x = 0; x < width; x += 1) {
          const target = ((firstRow + row) * width + x) * 4
          const index = row * width + x
          if (samples === 1) {
            const value = photometric === 0 ? 255 - data[index] : data[index]
            pixels[target] = value
            pixels[target + 1] = value
            pixels[target + 2] = value
            pixels[target + 3] = 255
            continue
          }
          for (let channel = 0; channel < 3; channel += 1) {
            const value = data[index * samples + channel]
            pixels[target + channel] = photometric === 0 ? 255 - value : value
          }
          pixels[target + 3] = samples === 4 ? data[index * samples + 3] : 255
        }
      }
    }
  }

  if (planes === 2) {
    for (let index = 0; index < width * height; index += 1) {
      const target = index * 4
      for (let channel = 0; channel < 3; channel += 1) pixels[target + channel] = planeData[channel][index]
      pixels[target + 3] = samples === 4 ? planeData[3][index] : 255
    }
  }

  const subIFDs = tags.has(330) ? values(tags.get(330)) : []
  const next = subIFDs.length > 0 && subIFDs[0] !== 0 ? start + subIFDs[0] : 0
  return { width, height, pixels, end: Math.max(end, next) }
}
