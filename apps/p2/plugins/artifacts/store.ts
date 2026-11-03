import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
// JSON can escape each content byte as six ASCII bytes, plus bounded metadata.
const MAX_SERIALIZED_BYTES = MAX_ARTIFACT_BYTES * 6 + 4096;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPES = ["html", "svg", "markdown", "text"] as const;

export type ArtifactType = (typeof TYPES)[number];
export type ArtifactInfo = { name: string; title: string; type: ArtifactType; version: number };
export type ArtifactInput = { name: string; title: string; type: ArtifactType; content: string };

const DIAGNOSTIC_BOOTSTRAP = `<script>(()=>{const channel="p2-artifact-diagnostic";const send=(level,args)=>{try{parent.postMessage({channel,level,message:args.map(value=>{try{return typeof value==="string"?value:JSON.stringify(value)}catch{return String(value)}}).join(" ").slice(0,4000)},"*")}catch{}};for(const level of ["error","warn"]){const original=console[level];console[level]=(...args)=>{send(level,args);original.apply(console,args)}}addEventListener("error",event=>send("error",[event.message,event.filename&&(event.filename+":"+event.lineno+":"+event.colno)].filter(Boolean)));addEventListener("unhandledrejection",event=>send("error",[event.reason?.stack||event.reason||"Unhandled promise rejection"]));addEventListener("securitypolicyviolation",event=>send("csp",[event.violatedDirective,event.blockedURI||"blocked"]));addEventListener("webglcontextlost",event=>send("webgl",["WebGL context lost"]),true);send("ready",["Preview diagnostics connected"]);})();</script>`;

/** Add a diagnostics bridge without changing the immutable stored source. */
export function instrumentArtifact(info: ArtifactInfo, content: string): string {
	if (info.type === "html") {
		const head = /<head(?:\s[^>]*)?>/i.exec(content);
		if (head)
			return `${content.slice(0, head.index + head[0].length)}${DIAGNOSTIC_BOOTSTRAP}${content.slice(head.index + head[0].length)}`;
		return `${DIAGNOSTIC_BOOTSTRAP}${content}`;
	}
	if (info.type === "svg") {
		const root = /<svg(?:\s[^>]*)?>/i.exec(content);
		if (root)
			return `${content.slice(0, root.index + root[0].length)}${DIAGNOSTIC_BOOTSTRAP}${content.slice(root.index + root[0].length)}`;
	}
	return content;
}

export class ArtifactError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ArtifactError";
		this.status = status;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validName(name: unknown): name is string {
	return typeof name === "string" && name.trim() === name && NAME.test(name);
}

function validVersion(version: unknown): version is number {
	return typeof version === "number" && Number.isSafeInteger(version) && version > 0;
}

function validTitle(title: unknown): title is string {
	return (
		typeof title === "string" &&
		title.length > 0 &&
		title.length <= 200 &&
		title.trim() === title &&
		title.isWellFormed() &&
		!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)
	);
}

function validType(type: unknown): type is ArtifactType {
	return TYPES.some((candidate) => candidate === type);
}

function validateInput(value: unknown): ArtifactInput {
	if (!record(value) || Object.keys(value).sort().join(",") !== "content,name,title,type")
		throw new ArtifactError(400, "Invalid artifact fields");
	if (!validName(value.name)) throw new ArtifactError(400, "Invalid artifact name");
	if (!validTitle(value.title)) throw new ArtifactError(400, "Invalid artifact title (1–200 characters)");
	if (!validType(value.type)) throw new ArtifactError(400, "Invalid artifact type");
	if (typeof value.content !== "string" || !value.content.isWellFormed())
		throw new ArtifactError(400, "Invalid artifact content");
	if (Buffer.byteLength(value.content, "utf8") > MAX_ARTIFACT_BYTES)
		throw new ArtifactError(413, "Artifact content exceeds 2 MiB");
	return { name: value.name, title: value.title, type: value.type, content: value.content };
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
	if (create) {
		try {
			await mkdir(path, { mode: 0o700 });
		} catch (error) {
			if (!record(error) || error.code !== "EEXIST") throw error;
		}
	}
	const stat = await lstat(path);
	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("Invalid private directory");
}

/** Private immutable versions. Locators do not authorize access; callers must authorize the session.
 * The configured data directory and local filesystem writers are trusted, not a tool sandbox.
 */
export class Artifacts {
	readonly directory: string;
	private readonly dataDirectory: string;
	constructor(dataDirectory: string) {
		this.dataDirectory = dataDirectory;
		this.directory = join(dataDirectory, "artifacts");
	}

	async save(sessionId: string, input: ArtifactInput): Promise<ArtifactInfo> {
		if (typeof sessionId !== "string" || sessionId.length !== 36 || !SESSION.test(sessionId))
			throw new ArtifactError(400, "Invalid session");
		const value = validateInput(input);
		const session = join(this.directory, sessionId);
		const artifact = join(session, value.name);
		let temporary: string | undefined;
		try {
			await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
			await privateDirectory(this.dataDirectory, false);
			await privateDirectory(this.directory, true);
			await privateDirectory(session, true);
			await privateDirectory(artifact, true);
			let version = 1;
			let folder: string;
			// Exclusive directory creation claims a number across stores/processes. Never reuse
			// abandoned claims: an interrupted version stays absent from readable history.
			for (;;) {
				folder = join(artifact, String(version));
				try {
					await mkdir(folder, { mode: 0o700 });
					break;
				} catch (error) {
					if (!record(error) || error.code !== "EEXIST") throw error;
					if (version === Number.MAX_SAFE_INTEGER) throw new Error("Version limit reached");
					version++;
				}
			}
			const info: ArtifactInfo = { name: value.name, title: value.title, type: value.type, version };
			const serialized = JSON.stringify({ info, content: value.content });
			if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_BYTES) throw new Error("Invalid serialized size");
			temporary = join(folder, `.version-${randomUUID()}.tmp`);
			const output = await open(temporary, "wx", 0o600);
			try {
				await output.writeFile(serialized, "utf8");
				await output.sync();
			} finally {
				await output.close();
			}
			// One atomic publication point: metadata and content cannot be observed separately.
			await rename(temporary, join(folder, "version.json"));
			temporary = undefined;
			return info;
		} catch {
			throw new ArtifactError(500, "Could not save artifact");
		} finally {
			if (temporary) await rm(temporary, { force: true }).catch(() => {});
		}
	}

	async read(sessionId: string, name: string, version: number): Promise<{ info: ArtifactInfo; content: string }> {
		if (
			typeof sessionId !== "string" ||
			sessionId.length !== 36 ||
			!SESSION.test(sessionId) ||
			!validName(name) ||
			!validVersion(version)
		)
			throw new ArtifactError(404, "Artifact not found");
		try {
			const session = join(this.directory, sessionId);
			const artifact = join(session, name);
			const folder = join(artifact, String(version));
			for (const path of [this.dataDirectory, this.directory, session, artifact, folder])
				await privateDirectory(path, false);
			const file = await open(
				join(folder, "version.json"),
				constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
			);
			let parsed: unknown;
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > MAX_SERIALIZED_BYTES || (stat.mode & 0o077) !== 0)
					throw new Error("Invalid artifact file");
				const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_SERIALIZED_BYTES + 1));
				let size = 0;
				for (;;) {
					const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
					if (!bytesRead) break;
					size += bytesRead;
					if (size === buffer.length) throw new Error("Artifact file changed or exceeds limit");
				}
				const text = buffer.subarray(0, size).toString("utf8");
				if (!buffer.subarray(0, size).equals(Buffer.from(text, "utf8"))) throw new Error("Invalid UTF-8");
				parsed = JSON.parse(text);
			} finally {
				await file.close();
			}
			if (
				!record(parsed) ||
				Object.keys(parsed).sort().join(",") !== "content,info" ||
				!record(parsed.info) ||
				Object.keys(parsed.info).sort().join(",") !== "name,title,type,version" ||
				parsed.info.name !== name ||
				parsed.info.version !== version
			)
				throw new Error("Invalid artifact metadata");
			const value = validateInput({
				name: parsed.info.name,
				title: parsed.info.title,
				type: parsed.info.type,
				content: parsed.content,
			});
			return { info: { name, title: value.title, type: value.type, version }, content: value.content };
		} catch {
			throw new ArtifactError(404, "Artifact not found");
		}
	}
}
