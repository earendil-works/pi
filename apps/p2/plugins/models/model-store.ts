// Small locked catalog store, adapted from Pi's models-store.ts (MIT).
// See third-party/pi.LICENSE. Provider code owns catalog refresh/publication.
import { statSync } from "node:fs";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";
import { LockedFile, normalizePath, stripBom } from "@p2/app/v1/node";

type Catalogs = Record<string, ModelsStoreEntry>;
function parseCatalogs(content: string | undefined): Catalogs {
	let value: unknown;
	try {
		value = JSON.parse(stripBom(content ?? "{}"));
	} catch {
		throw new Error("Invalid cached model catalogs");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cached model catalogs");
	for (const entry of Object.values(value)) {
		if (!entry || typeof entry !== "object" || !("models" in entry) || !Array.isArray(entry.models))
			throw new Error("Invalid cached model catalogs");
		for (const model of entry.models) {
			if (
				!model ||
				typeof model !== "object" ||
				!["id", "name", "api", "provider", "baseUrl"].every(
					(key) => typeof (model as Record<string, unknown>)[key] === "string",
				)
			)
				throw new Error("Invalid cached model catalogs");
		}
	}
	return value as Catalogs;
}

export class FileModelsStore implements ModelsStore {
	private readonly file: LockedFile;
	private readonly path: string;
	private cached: Catalogs = {};
	private revision: string | undefined;
	private loading: Promise<void> | undefined;
	constructor(path: string) {
		this.path = normalizePath(path);
		this.file = new LockedFile(this.path);
	}
	fingerprint(): string {
		try {
			const info = statSync(this.path, { bigint: true });
			return `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing";
			throw new Error("Could not read cached model catalogs");
		}
	}
	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		if (this.revision !== this.fingerprint()) {
			this.loading ??= this.file
				.withLockAsync(
					async (content) => ({ result: { data: parseCatalogs(content), revision: this.fingerprint() } }),
					options,
				)
				.then((snapshot) => {
					this.cached = snapshot.data;
					this.revision = snapshot.revision;
				})
				.finally(() => {
					this.loading = undefined;
				});
			await this.loading;
		}
		options?.signal?.throwIfAborted();
		return structuredClone(Object.hasOwn(this.cached, providerId) ? this.cached[providerId] : undefined);
	}
	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		const data = await this.file.withLockAsync(async (content) => {
			const next = parseCatalogs(JSON.stringify({ ...parseCatalogs(content), [providerId]: entry }));
			return { result: next, next: JSON.stringify(next) };
		}, options);
		this.cached = data;
		this.revision = undefined;
	}
	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		const data = await this.file.withLockAsync(async (content) => {
			const next = parseCatalogs(content);
			delete next[providerId];
			return { result: next, next: JSON.stringify(next) };
		}, options);
		this.cached = data;
		this.revision = undefined;
	}
	close(): Promise<void> {
		return this.file.close();
	}
}
