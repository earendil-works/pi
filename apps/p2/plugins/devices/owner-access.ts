import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { cookieValue } from "@p2/app/v1/server";

export const ownerCookieName = (port: number): string => `p2_owner_${port}`;
const TOKEN_LIFETIME = 10 * 60_000;
const COOKIE_LIFETIME = 30 * 24 * 60 * 60_000;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Atomically replace private state; a failed write never truncates the previous key or revocations. */
async function privateWrite(path: string, content: string): Promise<void> {
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Browser cookies are distinct signed devices, not the installation key. Invitations stay single-use in memory. */
export class OwnerAccess {
	private key: string;
	private readonly directory: string;
	private readonly now: () => number;
	private readonly invitations = new Map<string, number>();
	private revoked: Record<string, number>;
	private operations: Promise<void> = Promise.resolve();

	private constructor(directory: string, key: string, revoked: Record<string, number>, now: () => number) {
		this.directory = directory;
		this.key = key;
		this.revoked = revoked;
		this.now = now;
	}

	static async open(directory: string, now: () => number = () => Date.now()): Promise<OwnerAccess> {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, "owner-key");
		let key: string;
		try {
			key = (await readFile(path, "utf8")).trim();
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			key = randomBytes(32).toString("hex");
			await writeFile(path, key, { mode: 0o600, flag: "wx" });
		}
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid owner key");
		await chmod(path, 0o600);
		// The previous cookie WAS the owner key. Rotate it once before using a private signing key,
		// otherwise an old device could manufacture signed cookies after the format change.
		const schemePath = join(directory, "owner-cookie-version");
		let scheme: string | undefined;
		try {
			scheme = (await readFile(schemePath, "utf8")).trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (scheme === undefined) {
			key = randomBytes(32).toString("hex");
			await privateWrite(path, key);
			await privateWrite(schemePath, "signed-v1\n");
		} else if (scheme !== "signed-v1") throw new Error("Invalid owner cookie version");
		let revoked: Record<string, number> = {};
		try {
			const value: unknown = JSON.parse(await readFile(join(directory, "owner-revoked.json"), "utf8"));
			if (
				!value ||
				typeof value !== "object" ||
				Array.isArray(value) ||
				Object.entries(value).some(([id, expires]) => !/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(expires))
			)
				throw new Error("Invalid owner revocations");
			revoked = value as Record<string, number>;
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
				throw new Error("Cannot read owner revocations");
		}
		const access = new OwnerAccess(directory, key, revoked, now);
		// Every startup has a fresh headless invitation. Never log it or put it in a query/path.
		await privateWrite(join(directory, "owner-token.txt"), `${access.issueToken()}\n`);
		return access;
	}

	issueToken(): string {
		for (const [id, expires] of this.invitations) if (expires <= this.now()) this.invitations.delete(id);
		if (this.invitations.size >= 32) this.invitations.delete(this.invitations.keys().next().value ?? "");
		const token = randomBytes(32).toString("hex");
		this.invitations.set(hash(token), this.now() + TOKEN_LIFETIME);
		return token;
	}

	claim(token: unknown): boolean {
		if (typeof token !== "string") return false;
		const id = hash(token.trim());
		const expires = this.invitations.get(id);
		this.invitations.delete(id);
		return expires !== undefined && expires > this.now();
	}

	private signature(port: number, payload: string): string {
		return createHmac("sha256", this.key).update(`${port}:${payload}`).digest("hex");
	}

	cookie(port: number, secure: boolean): string {
		const payload = `${randomBytes(16).toString("hex")}.${this.now() + COOKIE_LIFETIME}`;
		return `${ownerCookieName(port)}=${payload}.${this.signature(port, payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;
	}

	clearCookie(port: number, secure: boolean): string {
		return `${ownerCookieName(port)}=; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax; Path=/; Max-Age=0`;
	}

	device(request: IncomingMessage, port: number): { id: string; expires: number } | undefined {
		const value = cookieValue(request, ownerCookieName(port));
		const match = value && /^([a-f0-9]{32})\.(\d+)\.([a-f0-9]{64})$/.exec(value);
		if (!match) return undefined;
		const [, id, expiry, signature] = match;
		const expires = Number(expiry);
		if (!Number.isSafeInteger(expires) || expires <= this.now() || (this.revoked[id!] ?? 0) > this.now())
			return undefined;
		if (!timingSafeEqual(Buffer.from(signature!, "hex"), Buffer.from(this.signature(port, `${id}.${expiry}`), "hex")))
			return undefined;
		return { id: id!, expires };
	}

	authorized(request: IncomingMessage, port: number): boolean {
		return this.device(request, port) !== undefined;
	}

	logout(device: { id: string; expires: number }): Promise<void> {
		const operation = this.operations.then(async () => {
			this.revoked = Object.fromEntries(Object.entries(this.revoked).filter(([, expires]) => expires > this.now()));
			this.revoked[device.id] = device.expires;
			await privateWrite(join(this.directory, "owner-revoked.json"), JSON.stringify(this.revoked));
		});
		this.operations = operation.catch(() => {});
		return operation;
	}

	rotate(): Promise<void> {
		const operation = this.operations.then(async () => {
			const next = randomBytes(32).toString("hex");
			await privateWrite(join(this.directory, "owner-key"), next);
			this.key = next;
			this.invitations.clear();
			this.revoked = {};
			await privateWrite(join(this.directory, "owner-revoked.json"), "{}");
			await privateWrite(join(this.directory, "owner-token.txt"), `${this.issueToken()}\n`);
		});
		this.operations = operation.catch(() => {});
		return operation;
	}

	async close(): Promise<void> {
		this.invitations.clear();
		await this.operations;
	}
}
