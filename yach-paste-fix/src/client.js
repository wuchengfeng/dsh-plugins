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

import { isGIF, isJPEG, isPNG, isTIFF } from './lib/signature.js'
import { tiffImages } from './lib/tiff.js'
import { encodePNG } from './lib/png.js'
/**
 * Set at build time so the browser bundle can host its decoder as a worker and
 * the shipped paste gesture can be answered before it is dispatched. Without
 * it the contract is the same, only slower for very large screenshots.
 */
const WORKER_SOURCE = __PASTE_REPAIR_WORKER__

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
export function apply(ctx) {
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
