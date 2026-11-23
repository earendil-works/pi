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

/**
 * Fuel the VM uses per second of pure computation, about: measured with a tight loop on an Apple M-series laptop
 * (djs 0.2.0). Built-ins run natively and cost little: sorting 1e6 numbers takes about 1.2e8, a 10 MB JSON round trip
 * 3e6, a thousand tool calls 1e6.
 */
export const FUEL_PER_SECOND = 500_000_000;

/**
 * The CPU budget of a run that names none: about a minute of pure computation. Only computing counts, never waiting on
 * tools, and a saved run carries what it used, so a runaway script ends also after a restart.
 */
export const DEFAULT_FUEL = 60 * FUEL_PER_SECOND;

/** The CPU budget on Cloudflare, where a request's own CPU limit (30 s by default) must not be reached first. */
export const DEFAULT_CLOUDFLARE_FUEL = 2 * FUEL_PER_SECOND;
