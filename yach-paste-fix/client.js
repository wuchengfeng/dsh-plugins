window.__ModuleLoader__.load({
  id: "@local/paste-image-compat",
  factory(require) {
    const React = require('react');
    /**
     * Paste-image compatibility for this DSH build.
     *
     * Some clipboard producers (an Electron client writing its own screenshot to
     * the system pasteboard, for example) hand an image over as TIFF or with no
     * media type. This build decides an image's format from the type the browser
     * declares, so such a paste is refused with a format message although the
     * picture is fine.
     *
     * This plugin repairs the payload instead of trusting that declared type: it
     * takes such a paste after the composer has declined it, decodes the TIFF,
     * re-encodes it as PNG, and replays the same gesture with the repaired file,
     * so the composer bar, the draft rail, uploads, and submission all run exactly
     * as they do for an ordinary PNG paste. The composer and the Host name image
     * uploads after their media type, so the repaired file also carries the `.png`
     * extension the image really has.
     *
     * The same repair also converts WebP. This build's composer treats WebP as an
     * image while its attachment service does not accept WebP, so a WebP paste is
     * uploaded as a plain file and the model never sees the picture.
     */




    /**
     * Set at build time so the browser bundle can host its decoder as a worker and
     * the shipped paste gesture can be answered before it is dispatched. Without
     * it the contract is the same, only slower for very large screenshots.
     */
    const WORKER_SOURCE = "\"use strict\";\n/** Media-type checks for clipboard payloads the page can hand over. */\n\n/** PNG signature (the eight bytes every PNG starts with). */\nfunction isPNG(bytes) {\n  return bytes.length > 8\n    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47\n    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;\n}\n\n/** GIF87a / GIF89a signature. */\nfunction isGIF(bytes) {\n  return bytes.length > 6\n    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;\n}\n\n/** JPEG start-of-image marker. */\nfunction isJPEG(bytes) {\n  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;\n}\n\n/** Home of a classic TIFF document inside a payload: its byte order and IFD offset. */\nfunction tiffHeaderAt(bytes, offset) {\n  const first = bytes[offset]\n  const classic = bytes[offset + 2] === 42 || bytes[offset + 3] === 42\n  if (classic && first === 0x49 && bytes[offset + 1] === 0x49) return { start: offset, little: true }\n  if (classic && first === 0x4d && bytes[offset + 1] === 0x4d) return { start: offset, little: false }\n  return undefined\n}\n\n/** Unsigned big-endian 32-bit integer. */\nfunction readU32(bytes, offset) {\n  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;\n}\n/**\n * Classic TIFF decoding for clipboard payloads.\n *\n * macOS screenshot tools hand copied screenshots to the pasteboard as TIFF,\n * and one screenshot spanning several displays can be several TIFF documents\n * back to back, so this walks every document in the payload instead of\n * trusting the first one. Only the layouts those writers emit are decoded:\n * 8-bit gray, RGB, RGBA with or without an alpha plane, chunky or planar,\n * uncompressed strips, with or without a horizontal predictor.\n */\n\n\n\n/** Tile width accepted for a single decoded raster. */\nconst MAX_SIDE = 4096\n\n/**\n * Every classic TIFF image inside a payload, in payload order.\n * @param bytes - the clipboard payload.\n * @returns the decodable images; decoding stops at the first layout it does not support.\n */\nfunction tiffImages(bytes) {\n  const images = []\n  let offset = 0\n  for (;;) {\n    if (offset + 8 > bytes.length) break\n    const header = tiffHeaderAt(bytes, offset)\n    if (header === undefined) break\n    const image = tiffImage(bytes, header)\n    if (image === undefined) break\n    images.push(image)\n    offset = image.end\n  }\n  return images\n}\n\n/**\n * Decode one classic TIFF document.\n * @param bytes - the clipboard payload.\n * @param header - the document's byte order and header offset.\n * @returns the RGBA raster and the offset just past the document, or undefined when the layout is unsupported.\n */\nfunction tiffImage(bytes, header) {\n  const { start, little } = header\n  const u16 = offset => (little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1])\n  const u32 = offset => (little\n    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0\n    : readU32(bytes, offset))\n  // A BigTIFF (version 43) or a document whose header points outside the\n  // payload is not something this decoder can walk safely.\n  if (u16(start + 2) !== 42) return undefined\n\n  const tags = new Map()\n  const ifd = start + u32(start + 4)\n  if (ifd + 2 > bytes.length) return undefined\n  const count = u16(ifd)\n  if (ifd + 2 + count * 12 > bytes.length) return undefined\n  for (let index = 0; index < count; index += 1) {\n    const entry = ifd + 2 + index * 12\n    tags.set(u16(entry), { type: u16(entry + 2), count: u32(entry + 4), field: entry + 8 })\n  }\n\n  const scalar = (tag) => {\n    if (tag === undefined || tag.count !== 1) return undefined\n    if (tag.type === 3) return u16(tag.field)\n    if (tag.type === 4) return u32(tag.field)\n    return undefined\n  }\n  const values = (tag) => {\n    if (tag === undefined) return []\n    const wide = tag.type === 4\n    const size = wide ? 4 : 2\n    const base = tag.count * size > 4 ? start + u32(tag.field) : tag.field\n    const out = []\n    for (let index = 0; index < tag.count; index += 1) out.push(wide ? u32(base + index * 4) : u16(base + index * 2))\n    return out\n  }\n\n  const width = scalar(tags.get(256))\n  const height = scalar(tags.get(257))\n  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) return undefined\n  const bits = values(tags.get(258))\n  const compression = scalar(tags.get(259)) ?? 1\n  const photometric = scalar(tags.get(262)) ?? 2\n  const samples = scalar(tags.get(277)) ?? 1\n  const rowsPerStrip = scalar(tags.get(278)) ?? height\n  const planar = scalar(tags.get(284)) ?? 1\n  const predictor = scalar(tags.get(317)) ?? 1\n  const offsets = values(tags.get(273))\n  const byteCounts = values(tags.get(279))\n  if (offsets.length === 0 || offsets.length !== byteCounts.length) return undefined\n  if (bits.some(value => value !== 8)) return undefined\n  if (compression !== 1 && compression !== 8 && compression !== 32946 && compression !== 32773) return undefined\n  if (planar !== 1 && planar !== 2) return undefined\n  if (predictor < 1 || predictor > 2) return undefined\n  if (photometric === 2) {\n    if (samples !== 3 && samples !== 4) return undefined\n  } else if (photometric === 0 || photometric === 1) {\n    if (samples !== 1) return undefined\n  } else {\n    return undefined\n  }\n  const planes = planar === 2 ? samples : 1\n  if (offsets.length % planes !== 0) return undefined\n\n  // The document ends where its metadata tables and strip data end; a\n  // multi-display screenshot puts the next TIFF document right after it.\n  let end = start + 8\n  for (const tag of tags.values()) {\n    const size = tag.type === 4 ? 4 : 2\n    const base = tag.count * size > 4 ? start + u32(tag.field) : tag.field\n    end = Math.max(end, base + (tag.count * size > 4 ? tag.count * size : 0))\n  }\n  for (let index = 0; index < offsets.length; index += 1) {\n    end = Math.max(end, start + offsets[index] + byteCounts[index])\n  }\n\n  const pixels = new Uint8ClampedArray(width * height * 4)\n  const stripsPerPlane = offsets.length / planes\n  // Plane-major sample storage (planar 2) needs every plane's rows in place\n  // before a pixel can be composed, so decoded rows land here first.\n  const planeData = planes === 2 ? Array.from({ length: planes }, () => new Uint8Array(width * height)) : []\n\n  for (let plane = 0; plane < planes; plane += 1) {\n    for (let strip = 0; strip < stripsPerPlane; strip += 1) {\n      const source = start + offsets[plane * stripsPerPlane + strip]\n      const stored = Math.max(0, Math.min(byteCounts[plane * stripsPerPlane + strip], bytes.length - source))\n      const firstRow = strip * rowsPerStrip\n      if (firstRow >= height) break\n      const rows = Math.min(rowsPerStrip, height - firstRow)\n      const expected = width * rows\n      let data = bytes.subarray(source, source + stored)\n      if (compression !== 1) {\n        // PackBits and Deflate need a decoder step this synchronous strip\n        // loop does not carry; browser-written clipboard TIFF is uncompressed.\n        return undefined\n      }\n      if (data === undefined || data.length < expected) return undefined\n      if (predictor === 2) {\n        const step = planes === 2 ? 1 : samples\n        for (let row = 0; row < rows; row += 1) {\n          const base = row * width\n          for (let index = step; index < width; index += 1) {\n            data[base + index] = (data[base + index] + data[base + index - step]) & 0xff\n          }\n        }\n      }\n      if (planes === 2) {\n        planeData[plane].set(data.subarray(0, expected), firstRow * width)\n        continue\n      }\n      for (let row = 0; row < rows; row += 1) {\n        for (let x = 0; x < width; x += 1) {\n          const target = ((firstRow + row) * width + x) * 4\n          const index = row * width + x\n          if (samples === 1) {\n            const value = photometric === 0 ? 255 - data[index] : data[index]\n            pixels[target] = value\n            pixels[target + 1] = value\n            pixels[target + 2] = value\n            pixels[target + 3] = 255\n            continue\n          }\n          for (let channel = 0; channel < 3; channel += 1) {\n            const value = data[index * samples + channel]\n            pixels[target + channel] = photometric === 0 ? 255 - value : value\n          }\n          pixels[target + 3] = samples === 4 ? data[index * samples + 3] : 255\n        }\n      }\n    }\n  }\n\n  if (planes === 2) {\n    for (let index = 0; index < width * height; index += 1) {\n      const target = index * 4\n      for (let channel = 0; channel < 3; channel += 1) pixels[target + channel] = planeData[channel][index]\n      pixels[target + 3] = samples === 4 ? planeData[3][index] : 255\n    }\n  }\n\n  const subIFDs = tags.has(330) ? values(tags.get(330)) : []\n  const next = subIFDs.length > 0 && subIFDs[0] !== 0 ? start + subIFDs[0] : 0\n  return { width, height, pixels, end: Math.max(end, next) }\n}\nself.onmessage = (event) => {\n  const image = tiffImages(new Uint8Array(event.data.bytes))\n    .find((candidate) => candidate.width >= 2 && candidate.height >= 2);\n  self.postMessage(image === undefined ? undefined : { width: image.width, height: image.height, pixels: image.pixels });\n};"

    const PNG = 'image/png'
    /** The names a browser gives a pasted bitmap when the source declared none. */
    const GENERATED_NAME = /^image\.[a-z0-9]+$/
    /** Browsers report tiny placeholder bitmaps for some clipboard flavors. */
    const MIN_SIDE = 2
    /** Marks the composer card this plugin repairs pastes for. */
    const MARKER = 'data-dsh-paste-image-compat'

    /** How long a very large payload may keep the paste gesture waiting. */
    const WORKER_TIMEOUT_MS = 4000
    /** Renders nothing, so the shipped neighbour keeps the cell's render slot. */
    const SHADOWED_PRIORITY = 1

    /** Localized notice keys this plugin raises besides the composer's own rejection copy. */
    const NOTICES = {
      unsupported: 'pasteImageCompat.unsupported',
      composerUnavailable: 'pasteImageCompat.composerUnavailable',
      failed: 'pasteImageCompat.failed',
    }

    function bytesOf(value) {
      return value instanceof Uint8Array ? value : new Uint8Array(value)
    }

    /** A clipboard payload neither this plugin nor the composer can accept. */
    class PasteImageUnsupported extends Error {}

    /** Media type of bytes this build handles itself, if any. */
    function displayableType(bytes) {
      if (isPNG(bytes)) return PNG
      if (isJPEG(bytes)) return 'image/jpeg'
      if (isGIF(bytes)) return 'image/gif'
      return undefined
    }

    /** WebP bytes, which this build's attachment service does not accept as an image. */
    function isWebP(bytes) {
      return bytes.length > 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    }

    /** Draw an RGBA raster on a canvas and read it back as PNG bytes. */
    function canvasToPNG(width, height, pixels) {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0)
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob === null) reject(new Error('canvas.toBlob returned null'))
          else blob.arrayBuffer().then(buffer => resolve(bytesOf(buffer)), reject)
        }, PNG)
      })
    }

    /**
     * PNG bytes for a clipboard payload this build cannot handle as is.
     * @param bytes - the clipboard payload.
     * @returns PNG bytes, or undefined when the payload cannot be repaired.
     */
    async function convertToPNG(bytes) {
      const raster = tiffImages(bytes).find(image => image.width >= MIN_SIDE && image.height >= MIN_SIDE) ?? await repairInWorker({ bytes })
      if (raster === undefined) return undefined
      try {
        const encoded = await canvasToPNG(raster.width, raster.height, raster.pixels)
        if (isPNG(encoded)) return encoded
      } catch {
        // The stored-block encoder below is the fallback for a canvas that will
        // not hand back a PNG; a canvas refusal is no reason to drop the image.
      }
      return encodePNG(raster.width, raster.height, raster.pixels)
    }

    /** Draw WebP bytes on a canvas and read them back as PNG bytes. */
    function webpToPNG(source) {
      const image = new Image()
      const url = URL.createObjectURL(source)
      return new Promise((resolve, reject) => {
        image.onload = () => {
          URL.revokeObjectURL(url)
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          canvas.getContext('2d').drawImage(image, 0, 0)
          canvas.toBlob((blob) => {
            if (blob === null) reject(new Error('canvas.toBlob returned null'))
            else blob.arrayBuffer().then(buffer => resolve(bytesOf(buffer)), reject)
          }, PNG)
        }
        image.onerror = () => {
          URL.revokeObjectURL(url)
          reject(new Error('the browser could not decode WebP'))
        }
        image.src = url
      })
    }

    /** Name for the repaired file: pasted bitmaps get a readable name. */
    function repairedName(file) {
      const base = file.name === '' || GENERATED_NAME.test(file.name) ? 'pasted-image' : file.name.replace(/\.[^.]*$/, '')
      return `${base}.png`
    }

    /**
     * The PNG the composer should receive in place of one clipboard file.
     * @param file - one clipboard file.
     * @returns the repaired file, or undefined when the reader keeps it.
     * @throws PasteImageUnsupported when the reader cannot use the payload either.
     */
    async function repairedFile(file) {
      const bytes = bytesOf(await file.arrayBuffer())
      if (displayableType(bytes) !== undefined) return undefined
      const converted = isWebP(bytes) ? await webpToPNG(file) : await convertToPNG(bytes)
      if (converted === undefined || !isPNG(converted)) throw new PasteImageUnsupported()
      return new File([converted], repairedName(file), { type: PNG })
    }

    /**
     * Run the repair off the main thread, so a large screenshot never blocks
     * typing and the paste gesture can wait for its result.
     * @param message - one clipboard file as plain data.
     * @returns the decoded raster, or undefined when the payload is not a usable TIFF.
     */
    async function repairInWorker(message) {
      if (WORKER_SOURCE === undefined) return undefined
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
      const worker = new Worker(url)
      try {
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), WORKER_TIMEOUT_MS)
          worker.onmessage = (event) => {
            clearTimeout(timer)
            resolve(event.data)
          }
          worker.onerror = () => {
            clearTimeout(timer)
            resolve(undefined)
          }
          worker.postMessage(message)
        })
      } finally {
        worker.terminate()
        URL.revokeObjectURL(url)
      }
    }

    /** The composer card a paste targets, found from the event's own DOM path. */
    function composerCardOf(event) {
      for (const entry of event.composedPath()) {
        if (entry instanceof HTMLElement && entry.hasAttribute(MARKER)) return entry
      }
      return null
    }

    /** Clipboard files of one paste, in clipboard order. */
    function clipboardFiles(data) {
      const files = []
      for (const item of data.items) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file !== null) files.push(file)
      }
      return files
    }

    /**
     * Whether this paste is one whose declared type this build mishandles and this
     * plugin can repair: a TIFF, an image pasted without any media type, or a WebP
     * the attachment service would never admit as an image.
     * @param files - the paste's clipboard files.
     * @returns whether the plugin takes the gesture over.
     */
    function needsRepair(files) {
      return files.some(file => file.type === 'image/tiff' || file.type === 'image/webp' || file.type === '')
    }

    /**
     * Install the paste repair for one apply lifetime.
     * @param onNotice - reports one localized notice.
     * @returns the cleanup.
     */
    function installPasteRepair(onNotice) {
      const onPaste = (event) => {
        const data = event.clipboardData
        if (data === null || event.defaultPrevented) return
        const files = clipboardFiles(data)
        if (!needsRepair(files)) return
        if (composerCardOf(event) === null) return
        // The composer's own paste handling sits on a child node this document
        // listener runs after, so claiming the gesture here cancels it before it
        // sees the payload. The repair needs the file bytes first, which no paste
        // handler can wait for, so the payload is repaired and the same gesture is
        // dispatched again with the repaired files; every shipped handler then
        // behaves exactly as it would have without this plugin.
        event.preventDefault()
        void (async () => {
          const repaired = []
          for (const file of files) {
            const replacement = await repairedFile(file)
            if (replacement === undefined) throw new PasteImageUnsupported()
            repaired.push(replacement)
          }
          const replay = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: replayData(repaired) })
          event.target.dispatchEvent(replay)
          // A dispatch that throws (an engine refusing a synthetic clipboard
          // payload) or that nobody consumes leaves the draft empty.
          if (!replay.defaultPrevented) onNotice('composerUnavailable')
        })().catch((error) => {
          onNotice(error instanceof PasteImageUnsupported ? 'unsupported' : 'failed')
        })
      }
      // No capture phase: this listener runs after the composer's own paste
      // listeners, so cancelling the gesture here is what stops them from also
      // receiving the original files.
      document.addEventListener('paste', onPaste)
      return () => document.removeEventListener('paste', onPaste)
    }

    /**
     * Clipboard contents carrying only repaired files, so the replayed paste
     * reaches the composer as an ordinary file paste with nothing to repair.
     * @param files - the repaired files.
     * @returns the DataTransfer to dispatch with.
     */
    function replayData(files) {
      const data = new DataTransfer()
      for (const file of files) data.items.add(file)
      return data
    }

    /**
     * The bundle's Client plugin.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      const locale = ctx.get('locale')
      const slots = ctx.get('slots')
      if (locale === undefined || slots === undefined) return

      ctx.effect(() => [
        locale.register('pasteImageCompat', 'zh', {
          'pasteImageCompat.unsupported': '这张剪贴板图片的格式无法转换，请另存为 PNG 后再粘贴',
          'pasteImageCompat.composerUnavailable': '当前窗口收不到这张图片，请点击输入框后重新粘贴',
          'pasteImageCompat.failed': '这张剪贴板图片处理失败，请另存为 PNG 后再粘贴',
        }),
        locale.register('pasteImageCompat', 'en', {
          'pasteImageCompat.unsupported': 'This clipboard image could not be converted; save it as PNG and paste again',
          'pasteImageCompat.composerUnavailable': 'This window cannot take the image here; click the message box and paste again',
          'pasteImageCompat.failed': 'The clipboard image could not be processed; save it as PNG and paste again',
        }),
      ])
      const t = locale.bind('pasteImageCompat')

      slots.inject('conversation.composer.bar', () => {
        const removeIntake = installPasteRepair((key) => {
          slots.notice(NOTICES[key] === undefined ? key : t(NOTICES[key]))
        })
        // A second occupant of the resident composer bar renders nothing. It is
        // registered at a higher priority so the shipped bar keeps the cell (the
        // lowest live entry renders); its inject face stamps the composer card,
        // which is how a paste finds the message box it happened in. Going
        // through the slot instead of a DOM query keeps the plugin working if the
        // shipped card markup changes.
        const registration = slots.register({
          name: 'conversation.composer.bar',
          priority: SHADOWED_PRIORITY,
          inject: () => ({
            attach: (card) => {
              if (card === null) return () => {}
              card.setAttribute(MARKER, '')
              return () => card.removeAttribute(MARKER)
            },
          }),
        }, function PasteImageCompat() {
          return null
        })
        return [registration, removeIntake]
      })
    }
    return { apply };
  },
});
