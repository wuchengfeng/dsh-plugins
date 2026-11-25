/**
 * Build the browser half of `@local/paste-image-compat`.
 *
 * The shipped Client bundle format is one `window.__ModuleLoader__` factory
 * whose module id is the package name. This script wraps `src/client.js` in
 * that factory, inlines the TIFF decoder from `lib/` as a worker source so the
 * repair never blocks the page, and writes the result to `client.js`.
 *
 * Run with `node build.js` after changing `src/client.js` or `lib/`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/** Indent every non-empty line of a block of script text. */
function indent(text, prefix) {
  return text.split('\n').map(line => (line === '' ? line : prefix + line)).join('\n')
}

/** One library module as worker-scope script text (its imports are inlined). */
function library(file) {
  return readFileSync(join(root, 'lib', file), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '')
    .trim()
}

const worker = [
  '"use strict";',
  library('signature.js'),
  library('tiff.js'),
  'self.onmessage = (event) => {',
  '  const image = tiffImages(new Uint8Array(event.data.bytes))',
  '    .find((candidate) => candidate.width >= 2 && candidate.height >= 2);',
  '  self.postMessage(image === undefined ? undefined : { width: image.width, height: image.height, pixels: image.pixels });',
  '};',
].join('\n')

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'src/client.js'), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  .replace('__PASTE_REPAIR_WORKER__', () => JSON.stringify(worker))

const output = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory(require) {
    const React = require('react');
${indent(source.trim(), '    ')}
    return { apply };
  },
});
`

writeFileSync(join(root, 'client.js'), output)
console.log(`client.js written (${output.length} bytes)`)
