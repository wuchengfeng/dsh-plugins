# Clipboard image repair

Some applications put a screenshot or a copied image on the system clipboard as **TIFF**, or without declaring a media type at all. This build of DSH picks an image's format from the type the browser declares, so pasting such an image into the message box ends in *"Only PNG, JPG, WebP, and GIF images are supported"* even though the picture itself is fine. (macOS writes these pasteboard entries itself; the 知音楼/Yach desktop client is one app that produces them when you copy its screenshots.)

The same mismatch also affects **WebP**: the composer treats WebP as an image, but the attachment service behind it does not accept WebP, so a pasted WebP is uploaded as an ordinary file and the model never receives the picture. This plugin converts those pastes to PNG as well.

This plugin repairs the clipboard payload instead of trusting its declared type: it decodes the TIFF, re-encodes it as PNG, and replays the same paste with the repaired file, so the composer, the attachment rail, the upload, and the submission all behave exactly as they do for an ordinary PNG paste.

## What happens on a paste

1. A `paste` gesture whose files are declared `image/tiff` or `image/webp`, or carry no media type at all, and that targets a DSH composer is taken by the plugin.
2. The plugin reads the file bytes. PNG, JPEG, or GIF bytes are left alone. TIFF bytes are decoded (`lib/tiff.js`) and re-encoded as PNG — through the page canvas, with a stored-block PNG encoder (`lib/png.js`) as the fallback — and WebP bytes are drawn by the browser's own decoder and re-encoded as PNG.
3. The same paste is dispatched again with the repaired files. The shipped composer then handles it as an ordinary image paste; the repaired file is named like the image it is (`pasted-image.png`), so the upload, the rail thumbnail, and the message all show a PNG.
4. If the payload cannot be decoded, or the composer cannot take it, the shipped toast reports it.

Every other paste, drag-and-drop, and the file picker go through the shipped code path untouched: a paste of text, of a PNG/JPEG/GIF, or of any other file is never intercepted.

## Supported TIFF layouts

- 8-bit grayscale, RGB, RGBA, with or without a separate alpha plane
- chunky (one plane of interleaved samples) or planar (one plane per strip run)
- uncompressed strip data, with or without a horizontal predictor
- several TIFF documents back to back, as a screenshot spanning several displays is written; the first usable image is used

Deflate- and LZW-compressed strips, 16-bit samples, and BigTIFF are reported as unconvertible rather than uploaded wrongly; save such an image as PNG first. A screenshot of up to 4096 px per side is accepted.

## Behaviour notes

- Decoding happens off the main thread in a worker, so a large screenshot never blocks typing; a payload that takes longer than four seconds is reported as unconvertible rather than freezing the message box.
- The plugin only takes the gesture for the three cases above: a TIFF paste, a WebP paste (which the model would otherwise never see), and a paste with no declared type. Every other paste keeps the shipped path and its claim.
- Nothing outside the message box changes. There is no settings page and no persistent UI.

## Updating an installed copy

The profile links this directory, but the browser keeps the module generation it loaded at page boot. After changing `client.js`, raise `version` in `package.json` and reinstall the bundle (Plugin Manager reports `already-installed` otherwise: remove the bundle, then install it again), then reload the page.

## Install

This directory is a DSH bundle package: install it from **Plugins → Add plugin** with this folder, or run the `plugin_manager` `install_bundle` action with the absolute path. The profile links this directory, so edits take effect after a page reload.

## Files

| Path | Purpose |
| --- | --- |
| `package.json` | Bundle manifest (`dsh.bundle.patch`, `dsh.client`) |
| `cordis.patch.yml` | Inserts the `paste-image-compat` row |
| `index.js` | Host half; the repair lives in the browser, so it registers nothing |
| `src/client.js` | Client source: paste repair, locale strings, composer hook |
| `build.js` | Wraps `src/client.js` into the shipped Client bundle format and inlines the worker |
| `client.js` | Built browser half (generated; run `node build.js` after editing `src/` or `lib/`) |
| `lib/signature.js` | Clipboard signature matching |
| `lib/tiff.js` | TIFF decoding |
| `lib/png.js` | PNG encoder fallback |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title, description, and detail document |
| `icon.svg` | Plugin icon |
