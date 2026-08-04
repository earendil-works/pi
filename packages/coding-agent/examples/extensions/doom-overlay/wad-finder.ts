import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// Get the bundled WAD path (relative to this module)
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_WAD = join(__dirname, "doom1.wad");
const WAD_URL = "https://www.gamers.org/pub/idgames/idstuff/doom/doom-1.8.wad.gz";

const DEFAULT_WAD_PATHS = ["./doom1.wad", "./DOOM1.WAD", "~/doom1.wad", "~/.doom/doom1.wad"];

export function findWadFile(customPath?: string): string | null {
	if (customPath) {
		const resolved = resolve(customPath.replace(/^~/, process.env.HOME || ""));
		if (existsSync(resolved)) return resolved;
		return null;
	}

	// Check bundled WAD first
	if (existsSync(BUNDLED_WAD)) {
		return BUNDLED_WAD;
	}

	// Fall back to default paths
	for (const p of DEFAULT_WAD_PATHS) {
		const resolved = resolve(p.replace(/^~/, process.env.HOME || ""));
		if (existsSync(resolved)) return resolved;
	}

	return null;
}

/** Download the shareware WAD if not present. Returns path or null on failure. */
export async function ensureWadFile(): Promise<string | null> {
	// Check if already exists
	const existing = findWadFile();
	if (existing) return existing;

	// Download to bundled location
	try {
		const response = await fetch(WAD_URL);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const wad = gunzipSync(Buffer.from(await response.arrayBuffer()));
		if (wad.subarray(0, 4).toString("ascii") !== "IWAD") {
			throw new Error("Downloaded file is not a valid IWAD");
		}
		writeFileSync(BUNDLED_WAD, wad);
		return BUNDLED_WAD;
	} catch {
		return null;
	}
}
