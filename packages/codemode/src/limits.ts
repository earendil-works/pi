/** Limits of what one script may keep in the store and produce as output. */

/** Characters of JSON one `store()` value may have. */
export const MAX_STORE_VALUE_CHARS = 256 * 1024;

/** Characters of keys and JSON values the whole store may hold. */
export const MAX_STORE_TOTAL_CHARS = 1024 * 1024;

/**
 * Output one script may produce with `text()`, `image()`, and `console.*`: characters of text and
 * base64 image data, and items. The host keeps all output until the script ends, so without a
 * limit a script that prints in a loop grows the host's memory until it crashes. The item limit
 * covers loops that print empty strings.
 */
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
export const MAX_OUTPUT_ITEMS = 100_000;
