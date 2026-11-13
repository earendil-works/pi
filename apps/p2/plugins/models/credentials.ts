// CredentialStore semantics and validation adapted from earendil-works/pi
// auth-storage.ts (MIT); see third-party/pi.LICENSE. Locking lives in LockedFile.
import { statSync } from "node:fs";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { LockedFile, normalizePath, stripBom } from "@p2/app/v1/node";
import { resolveConfigValueUncached } from "./config-value.ts";

type Credentials = Record<string, Credential>;
function parseCredentials(content: string | undefined): Credentials {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(content ?? "{}"));
	} catch {
		throw new Error("Invalid auth.json syntax");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Invalid auth.json: expected object");
	for (const credential of Object.values(parsed)) {
		if (!credential || typeof credential !== "object" || Array.isArray(credential))
			throw new Error("Invalid auth.json credential");
		const value = credential as Record<string, unknown>;
		if (value.type === "api_key") {
			const key = value.key === undefined || typeof value.key === "string";
			const env =
				value.env === undefined ||
				(value.env !== null &&
					typeof value.env === "object" &&
					!Array.isArray(value.env) &&
					Object.values(value.env).every((entry) => typeof entry === "string"));
			if (key && env) continue;
		} else if (
			value.type === "oauth" &&
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires)
		)
			continue;
		throw new Error("Invalid auth.json credential");
	}
	return parsed as Credentials;
}

export class FileCredentials implements CredentialStore {
	private readonly file: LockedFile;
	private readonly path: string;
	private lastGood: Credentials | undefined;
	private fileRevision: string | undefined;
	constructor(path: string) {
		this.path = normalizePath(path);
		this.file = new LockedFile(this.path);
	}

	get revision(): string | undefined {
		return this.fileRevision;
	}
	close(): Promise<void> {
		return this.file.close();
	}

	async reload(options?: AuthOperationOptions): Promise<void> {
		const snapshot = await this.file.withLockAsync(async (content) => {
			const data = parseCredentials(content);
			const info = statSync(this.path, { bigint: true });
			return { result: { data, revision: `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}` } };
		}, options);
		this.lastGood = snapshot.data;
		this.fileRevision = snapshot.revision;
	}

	private async latest(options?: AuthOperationOptions): Promise<Credentials> {
		try {
			await this.reload(options);
		} catch (error) {
			options?.signal?.throwIfAborted();
			if (this.lastGood === undefined) throw error; // Fail closed on invalid startup auth.
		}
		options?.signal?.throwIfAborted();
		return this.lastGood ?? {};
	}

	storedSnapshot(providerId: string): Credential | undefined {
		return structuredClone(
			this.lastGood && Object.hasOwn(this.lastGood, providerId) ? this.lastGood[providerId] : undefined,
		);
	}

	metadata(): CredentialInfo[] {
		return Object.entries(this.lastGood ?? {}).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const data = await this.latest(options);
		const stored = Object.hasOwn(data, providerId) ? data[providerId] : undefined;
		if (!stored) return undefined;
		const credential = structuredClone(stored);
		if (credential.type !== "api_key" || credential.key === undefined) return credential;
		const key = resolveConfigValueUncached(credential.key, credential.env);
		if (key === undefined) throw new Error("Could not resolve stored API key");
		return { ...credential, key };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		await this.latest(options);
		return this.metadata(); // Never executes key commands or exposes key/env/token values.
	}

	modify(
		providerId: string,
		update: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const operation = this.file
			.withLockAsync(async (content) => {
				const data = parseCredentials(content);
				const current = Object.hasOwn(data, providerId) ? data[providerId] : undefined;
				const candidate = await update(structuredClone(current));
				const next =
					candidate === undefined ? data : parseCredentials(JSON.stringify({ ...data, [providerId]: candidate }));
				return {
					result: { data: next, credential: Object.hasOwn(next, providerId) ? next[providerId] : undefined },
					...(candidate === undefined ? {} : { next: JSON.stringify(next, null, 2) }),
				};
			}, options)
			.then((result) => {
				this.lastGood = result.data;
				return structuredClone(result.credential);
			});
		// Caller cancellation stops waiting, not ownership: the underlying file
		// callback retains its lock until it settles, and cannot write after abort.
		return raceWithAbortSignal(operation, options?.signal);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		const data = await this.file.withLockAsync(async (content) => {
			const next = parseCredentials(content);
			delete next[providerId];
			return { result: next, next: JSON.stringify(next, null, 2) };
		}, options);
		this.lastGood = data;
	}
}

function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) {
		void operation.catch(() => {});
		return Promise.reject(signal.reason);
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(signal.reason);
		};

		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
