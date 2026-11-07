// Content-addressed shot store.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ShotRecord {
	id: string;
	path: string;
	width: number;
	height: number;
	bytes: number;
	sha256: string;
	format: string;
	createdAt: number;
}

export function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

export class ShotStore {
	readonly root: string;
	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true });
		mkdirSync(join(root, "shots"), { recursive: true });
		mkdirSync(join(root, "baselines"), { recursive: true });
	}

	save(buf: Buffer, meta: { width: number; height: number; format: string }): ShotRecord {
		const sha = sha256(buf);
		const ext = meta.format === "webp" ? "webp" : "png";
		const id = sha.slice(0, 32);
		const path = join(this.root, "shots", `${id}.${ext}`);
		if (!existsSync(path)) writeFileSync(path, buf);
		return {
			id,
			path,
			width: meta.width,
			height: meta.height,
			bytes: buf.length,
			sha256: sha,
			format: meta.format,
			createdAt: Date.now(),
		};
	}

	read(path: string): Buffer {
		return readFileSync(path);
	}

	baselinePath(name: string): string {
		return join(this.root, "baselines", `${name.replace(/[^a-zA-Z0-9_-]+/g, "_")}.webp`);
	}

	saveBaseline(name: string, buf: Buffer): string {
		const p = this.baselinePath(name);
		writeFileSync(p, buf);
		return p;
	}

	readBaseline(name: string): Buffer | null {
		const p = this.baselinePath(name);
		return existsSync(p) ? readFileSync(p) : null;
	}
}
