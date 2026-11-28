// LEGACY (one release, `docs/slices.md`): a process holding a lock as the previous release did, for the legacy check's
// tests. `legacy-holder.ts <name>` listens on the old socket file, prints `held` and its path, `accepted` per
// connection, and on SIGUSR2 stops listening (keeping what it accepted) and prints `closed`. It states the old path
// rule itself, so a wrong rule in `lock.ts` fails the tests: `$TMPDIR/chord-lock-<key>.sock`, or the same file in
// `/tmp/chord-lock-<uid>` when that path does not fit sun_path.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = createHash("sha256")
	.update(process.argv[2] ?? "")
	.digest("hex")
	.slice(0, 32);
const file = `chord-lock-${key}.sock`;
const preferred = join(tmpdir(), file);
const fallback = `/tmp/chord-lock-${process.getuid?.() ?? 0}`;
const fits = Buffer.byteLength(preferred) <= 103;
if (!fits) mkdirSync(fallback, { mode: 0o700, recursive: true });
const path = fits ? preferred : join(fallback, file);
const server = createServer(() => console.log("accepted")).listen(path, () => console.log(`held\n${path}`));
process.on("SIGUSR2", () => {
	server.close();
	console.log("closed");
});
