/**
 * Host half of `@local/paste-image-compat`.
 *
 * The repair happens in the browser (the clipboard payload and the composer
 * live there), so the Host registers nothing and exists only to give the
 * bundle a plugin row.
 */
export function apply() {}
