// The launcher's actions (p2-tui-port.md sections 3.1-3.5, P5): clipboard, browser, downloads, external editor,
// job control, the dev channel and sign-out. Every one runs under a grant: the visitor's own privileged key (K) or a
// confirmation in the launcher-drawn consent screen of exactly the data used (C). Worker payloads are validated here;
// URLs are built from the launcher's fixed origin; credentials never enter a URL, a child process or the worker.
import { spawn } from "node:child_process";
import {
	closeSync,
	constants,
	createReadStream,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClipboardImage,
	copyToClipboard,
	openBrowser,
	readClipboardFilePaths,
	readClipboardImage,
	readClipboardText,
} from "./tui-clipboard.ts";
import { configDirectory, connectionHeaders, type TuiCredentials } from "./tui-config.ts";
import type { LauncherAction, LauncherActionContext } from "./tui-grants.ts";
import { applyPrefsPatch, prefsDiff, readPrefsFile, validatePrefsPatch, writePrefsFile } from "./tui-prefs-save.ts";
import type { ConsentRequest } from "./tui-trusted-ui.ts";

export const MAX_COPY = 1024 * 1024;
export const MAX_DOWNLOAD = 25 * 1024 * 1024;
const MAX_EDITOR = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type LauncherActionOptions = {
	url: URL;
	credentials: TuiCredentials;
	role: "owner" | "guest";
	/** Download folder (launcher-only preference; default ~/Downloads/p2). */
	downloads?: string;
	/** External editor argv (launcher-only: pi's `externalEditor`, else $VISUAL/$EDITOR); never sent to the worker. */
	editor?: readonly string[];
	/** Injectable for tests. */
	clipboard?: (text: string, writeTerminal: (data: string) => void) => Promise<void>;
	openBrowser?: (url: string) => void;
	runEditor?: (argv: readonly string[], file: string) => Promise<number | null>;
	/** Clipboard readers for Ctrl+V (injectable for tests). */
	readClipboard?: {
		files(): Promise<string[] | null>;
		image(): Promise<ClipboardImage | null>;
		text(): Promise<string | null>;
	};
	/** Where the launcher's file picker starts (default: the launcher's working directory). */
	pickerStart?: string;
	/** The directory of p2's own `prefs.json` (default: `P2_TUI_CONFIG_DIR` or `~/.pi/p2-tui`). */
	prefsDirectory?: string;
	/** Stops this process group (SIGTSTP) and resolves on SIGCONT. */
	suspendProcess?: () => Promise<void>;
	platform?: string;
	/** Called after a successful sign-out of this device's cookie (the launcher forgets it). */
	onSignedOut?: (all: boolean) => void;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const count = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");
/** One line of worker-supplied text for a fact, marked as the server's. */
const reported = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? `${value.trim().slice(0, 120)} (server-reported)` : undefined;
function firstLine(text: string): string {
	const line = text.split(/\r?\n/).find((value) => value.trim()) ?? "";
	return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** Splits an editor command into argv without a shell (quotes group words; nothing is expanded). */
export const MAX_UPLOAD = 25 * 1024 * 1024;
export type UploadedFile = { id: string; name: string; size: number; mimeType?: string };
const IMAGE_EXTENSIONS: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};
const sizeText = (bytes: number) =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1024 * 1024
			? `${(bytes / 1024).toFixed(1)} KiB`
			: `${(bytes / 1048576).toFixed(1)} MiB`;

/** A local path as typed or dropped: quotes, `file://` URLs, backslash escapes and `~/` resolved on this computer. */
export function localPath(value: string): string | undefined {
	let path = value.trim();
	if (!path || path.length > 4096 || path.includes("\0")) return undefined;
	if (/^(['"]).*\1$/.test(path)) path = path.slice(1, -1);
	if (path.startsWith("file://")) {
		try {
			path = fileURLToPath(path);
		} catch {
			return undefined;
		}
	} else path = path.replace(/\\(.)/g, "$1");
	if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
	return resolve(path);
}

/**
 * Section 3.3 step 7: open without following a final symlink, check the opened descriptor is a regular file within the
 * limit; everything after reads through that descriptor.
 */
export function openLocalFile(path: string): { fd: number; size: number; name: string; mimeType?: string } {
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("Not a regular file");
		if (stat.size > MAX_UPLOAD) throw new Error(`Larger than 25 MiB (${sizeText(stat.size)})`);
		const name = uploadName(basename(path));
		const mimeType = IMAGE_EXTENSIONS[extname(name).slice(1).toLowerCase()];
		return { fd, size: stat.size, name, ...(mimeType ? { mimeType } : {}) };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}
/** The upload name: the local base name without controls or separators, at most 255 characters (section 3.4). */
export function uploadName(value: string): string {
	return safeFileName(value).slice(0, 255);
}

export function editorArgv(command: string | undefined): string[] | undefined {
	if (!command?.trim()) return undefined;
	const argv: string[] = [];
	for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) argv.push(match[1] ?? match[2] ?? match[3]!);
	return argv.length ? argv : undefined;
}

/** A local file name from a server-supplied one: base name only, no controls, separators or leading dots. */
export function safeFileName(value: string | undefined): string {
	const name = basename((value ?? "").replace(/\\/g, "/"))
		// biome-ignore lint/suspicious/noControlCharactersInRegex: file names never carry controls.
		.replace(/[\x00-\x1f\x7f-\x9f/:*?"<>|]/g, "_")
		.replace(/^[.\s]+/, "")
		.trim();
	let result = name || "download";
	while (Buffer.byteLength(result) > 200) result = result.slice(0, -1);
	return result;
}

/** Content-Disposition's filename* (RFC 5987) or filename. */
function dispositionName(header: string | null): string | undefined {
	if (!header) return undefined;
	const star = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
	if (star) {
		try {
			return decodeURIComponent(star);
		} catch {}
	}
	return /filename="([^"]*)"/i.exec(header)?.[1];
}

/** Section 3.5: only these fixed-origin paths open in the browser. */
export function originPath(url: URL, path: unknown): URL | undefined {
	if (typeof path !== "string" || path.length > 512 || !path.startsWith("/") || path.startsWith("//"))
		return undefined;
	let target: URL;
	try {
		target = new URL(path, url);
	} catch {
		return undefined;
	}
	if (target.origin !== url.origin || target.hash || target.username || target.password) return undefined;
	const query = [...target.searchParams.keys()];
	const only = (...keys: string[]) => query.every((key) => keys.includes(key)) && new Set(query).size === query.length;
	const session = target.searchParams.get("session") ?? "";
	if (/^\/s\/[0-9a-f-]{36}$/i.test(target.pathname) && UUID.test(target.pathname.slice(3)) && query.length === 0)
		return target;
	if (
		target.pathname === "/artifact" &&
		only("session", "name", "version", "download") &&
		UUID.test(session) &&
		ARTIFACT.test(target.searchParams.get("name") ?? "") &&
		/^\d{1,6}$/.test(target.searchParams.get("version") ?? "")
	)
		return target;
	if (
		target.pathname === "/download" &&
		only("session", "id") &&
		UUID.test(session) &&
		UUID.test(target.searchParams.get("id") ?? "")
	)
		return target;
	return undefined;
}

/** Saves a response body into `folder` under a fresh name (never overwrites), bounded and abortable. */
async function saveBounded(response: Response, folder: string, name: string, signal: AbortSignal): Promise<string> {
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	const extension = extname(name);
	const stem = name.slice(0, name.length - extension.length) || "download";
	let fd: number | undefined;
	let path = "";
	for (let index = 0; index < 1000 && fd === undefined; index++) {
		path = join(folder, index ? `${stem} (${index})${extension}` : name);
		try {
			fd = openSync(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	if (fd === undefined) throw new Error("No free file name in the download folder");
	let size = 0;
	try {
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Empty response");
		try {
			while (true) {
				if (signal.aborted) throw new Error("Download cancelled");
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_DOWNLOAD) throw new Error("Download exceeds 25 MiB");
				writeSync(fd, value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		closeSync(fd);
		fd = undefined;
		return path;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		rmSync(path, { force: true });
		throw error;
	}
}

function spawnEditor(argv: readonly string[], file: string): Promise<number | null> {
	return new Promise((resolve) => {
		const [command, ...args] = argv;
		const child = spawn(command!, [...args, file], { stdio: "inherit" });
		child.on("error", () => resolve(null));
		child.on("close", (code) => resolve(code));
	});
}

/** Coding-agent's Ctrl+Z: keep the loop alive, ignore SIGINT while stopped, resume on SIGCONT. */
function suspendThisProcess(): Promise<void> {
	return new Promise((resolve, reject) => {
		const keepAlive = setInterval(() => {}, 2 ** 30);
		const ignore = () => {};
		process.on("SIGINT", ignore);
		process.once("SIGCONT", () => {
			clearInterval(keepAlive);
			process.removeListener("SIGINT", ignore);
			resolve();
		});
		try {
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(keepAlive);
			process.removeListener("SIGINT", ignore);
			reject(error);
		}
	});
}

export function launcherActions(options: LauncherActionOptions): Record<string, LauncherAction> {
	const { url } = options;
	const platform = options.platform ?? process.platform;
	const headers = connectionHeaders(url, options.credentials);
	const clipboard = options.clipboard ?? ((text, write) => copyToClipboard(text, write));
	const open = options.openBrowser ?? ((target) => openBrowser(target));
	const folder = options.downloads ?? join(homedir(), "Downloads", "p2");
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.protocol === "http:";
	const request = (path: string, init: RequestInit & { signal: AbortSignal }) =>
		fetch(new URL(path, url), { ...init, headers: { ...headers, ...init.headers }, redirect: "error" });
	const copyText = (value: unknown): string | undefined => {
		const text = record(value)?.text;
		return typeof text === "string" && text.length > 0 && Buffer.byteLength(text) <= MAX_COPY ? text : undefined;
	};
	const copied = async (text: string, context: LauncherActionContext) => {
		await clipboard(text, context.writeTerminal);
		await context.ui.notice(`Copied ${count(text.length)} characters: ${firstLine(text)}`);
	};
	const prefsDirectory = options.prefsDirectory ?? configDirectory();
	const reader = options.readClipboard ?? {
		files: readClipboardFilePaths,
		image: () => readClipboardImage(),
		text: () => readClipboardText(),
	};
	/**
	 * Section 3.4: fixed URL, exact Origin and the launcher's cookie, no redirects, 60 s, at most 25 MiB counted while
	 * streaming, a bounded `{id}` answer. Errors stay in the launcher.
	 */
	const upload = async (
		session: string,
		name: string,
		body: Uint8Array | { fd: number; size: number },
		signal: AbortSignal,
	): Promise<UploadedFile> => {
		const query = new URLSearchParams({ session, name });
		let sent = 0;
		const stream =
			body instanceof Uint8Array
				? undefined
				: (async function* () {
						for await (const chunk of createReadStream("", { fd: body.fd, autoClose: false })) {
							sent += (chunk as Buffer).length;
							if (sent > MAX_UPLOAD) throw new Error("Larger than 25 MiB");
							yield chunk as Buffer;
						}
					})();
		if (body instanceof Uint8Array && body.byteLength > MAX_UPLOAD) throw new Error("Larger than 25 MiB");
		const response = await fetch(new URL(`/upload?${query}`, url), {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/octet-stream" },
			body:
				body instanceof Uint8Array
					? Buffer.from(body)
					: (stream as AsyncIterable<Uint8Array> as unknown as BodyInit),
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
			...(stream ? { duplex: "half" } : {}),
		} as RequestInit);
		const text = (await response.text()).slice(0, 8192);
		let value: Record<string, unknown> | undefined;
		try {
			value = record(JSON.parse(text));
		} catch {}
		if (!response.ok) throw new Error(`The server refused the upload (${response.status})`);
		const id = value?.id;
		if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid upload response");
		const mimeType = typeof value?.mimeType === "string" ? value.mimeType.slice(0, 100) : undefined;
		return {
			id,
			name: typeof value?.name === "string" ? value.name.slice(0, 255) : name,
			size: typeof value?.size === "number" ? value.size : body instanceof Uint8Array ? body.byteLength : body.size,
			...(mimeType ? { mimeType } : {}),
		};
	};
	/** A local file: facts first (path, size, type, session), the upload only after Enter or y. */
	const attachLocal = async (path: string, context: LauncherActionContext): Promise<UploadedFile | undefined> => {
		const session = context.grant.target?.session;
		if (!session) throw new Error("Open a session to attach files");
		const file = openLocalFile(path);
		try {
			const confirmed = await context.ui.confirm({
				action: "Upload a local file to this session",
				facts: [
					["File", path],
					["Size", sizeText(file.size)],
					["Type", file.mimeType ?? "file"],
					["Session", session],
				],
				confirmLabel: "upload",
			});
			if (!confirmed) return undefined;
			return await upload(session, file.name, file, context.grant.signal);
		} finally {
			closeSync(file.fd);
		}
	};
	const attached = async (file: UploadedFile | undefined, context: LauncherActionContext) => {
		if (file) await context.ask("attached", file);
	};
	const actions: Record<string, LauncherAction> = {
		/**
		 * C (`/attach [path]`): a dropped or typed path is shown with its facts before upload; without a path the
		 * launcher's own file picker chooses. Payload `{path?}`; result `{id, name, size, mimeType?}`.
		 */
		attach: {
			kind: "C",
			consent: (payload, { target }) => {
				const value = record(payload);
				if (!value || !target || (value.path !== undefined && typeof value.path !== "string")) return undefined;
				const path = typeof value.path === "string" ? localPath(value.path) : undefined;
				if (value.path !== undefined && !path) return undefined;
				return {
					action: path
						? "Show this local file for upload (the next screen has its size and type)"
						: "Choose a local file to upload (in the launcher's file picker)",
					facts: path ? [["File", path]] : [],
					confirmLabel: path ? "continue" : "open the picker",
				};
			},
			run: async (payload, context) => {
				const value = record(payload);
				const path =
					typeof value?.path === "string"
						? localPath(value.path)
						: await context.ui.pick("Choose a file to upload", options.pickerStart ?? process.cwd());
				if (!path) return null;
				return (await attachLocal(path, context)) ?? null;
			},
		},
		/** K (p2.attach, unbound by default): the launcher's file picker, then the facts, then the upload. */
		"attach.key": {
			kind: "K",
			key: "p2.attach",
			run: async (context) => {
				const path = await context.ui.pick("Choose a file to upload", options.pickerStart ?? process.cwd());
				if (path) await attached(await attachLocal(path, context), context);
			},
		},
		/**
		 * K (Ctrl+V, pi's app.clipboard.pasteImage): copied files (macOS) and images upload after a confirmation; plain
		 * text is pasted into the worker as a bracketed paste (the visitor's own paste key).
		 */
		"paste.key": {
			kind: "K",
			key: "app.clipboard.pasteImage",
			run: async (context) => {
				const files = await reader.files();
				if (files?.length) {
					for (const path of files.slice(0, 10))
						await attached(await attachLocal(resolve(path), context), context);
					return;
				}
				const image = await reader.image();
				if (image) {
					const session = context.grant.target?.session;
					if (!session) throw new Error("Open a session to attach images");
					const extension = image.mimeType.split("/")[1] === "jpeg" ? "jpg" : image.mimeType.split("/")[1];
					const name = `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
					const confirmed = await context.ui.confirm({
						action: "Upload the clipboard image to this session",
						facts: [
							["Image", `${image.mimeType}, ${sizeText(image.bytes.byteLength)}`],
							["Name", name],
							["Session", session],
						],
						confirmLabel: "upload",
					});
					if (confirmed) await attached(await upload(session, name, image.bytes, context.grant.signal), context);
					return;
				}
				const text = await reader.text();
				// biome-ignore lint/suspicious/noControlCharactersInRegex: pasted text keeps only newlines and tabs.
				const clean = text?.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
				if (clean) context.sendInput(`\x1b[200~${clean}\x1b[201~`);
			},
		},
		/** K (Ctrl+X): the worker supplies the selection or last answer; the launcher writes and says what it copied. */
		"copy.key": {
			kind: "K",
			key: "app.message.copy",
			run: async (context) => {
				const text = copyText(await context.ask("copyText"));
				if (text === undefined) await context.ui.notice("Nothing to copy");
				else await copied(text, context);
			},
		},
		/**
		 * pi-tui's copy-on-select (pi's `fullscreenCopyOnSelect`): the worker's TuiAltScreen hands the selected text to
		 * its `copySelection` callback, which requests this. Accepted only right after the launcher itself saw the
		 * mouse release ending a drag or multi-click in the raw input (one copy per gesture); no consent screen.
		 * pi-tui then flashes "Copied!" (or the failure) from the answer.
		 */
		"copy.selection": {
			kind: "gesture",
			gesture: "selection",
			accept: (payload) => copyText(payload) !== undefined,
			run: async (payload, context) => {
				await clipboard(copyText(payload)!, context.writeTerminal);
				return null;
			},
		},
		/** C: `/copy`, a login URL, a share link. Payload `{text, label?}`; the screen shows the full text. */
		copy: {
			kind: "C",
			consent: (payload) => {
				const text = copyText(payload);
				if (text === undefined) return undefined;
				const label = reported(record(payload)?.label);
				return {
					action: `Copy ${count(text.length)} characters to the clipboard`,
					facts: label ? [["What", label]] : [],
					preview: text,
					confirmLabel: "copy",
				};
			},
			run: async (payload, context) => {
				await copied(copyText(payload)!, context);
				return null;
			},
		},
		/** C: `{kind: "external", url}` (https only) or `{kind: "origin", path}` (allowlisted paths on this origin). */
		openUrl: {
			kind: "C",
			consent: (payload, { target }) => {
				const value = record(payload);
				const resolved = resolveOpen(value, target?.session);
				if (!resolved) return undefined;
				return {
					action: resolved.external
						? "Open this external page in your browser"
						: "Open this page of the server in your browser",
					facts: resolved.external
						? []
						: [
								[
									"Note",
									"The browser needs its own sign-in (an owner link or a share link); nothing is passed on.",
								],
							],
					preview: resolved.url.href,
					confirmLabel: "open",
				};
			},
			run: async (payload, context) => {
				const resolved = resolveOpen(record(payload), context.grant.target?.session);
				if (!resolved) throw new Error("Invalid URL");
				open(resolved.url.href);
				return null;
			},
		},
		/** C: `{kind: "file", session, id, name?}` (sent files) or `{kind: "artifact", session, name, version}`. */
		download: {
			kind: "C",
			consent: (payload, { target }) => {
				const resolved = resolveDownload(record(payload), target?.session);
				if (!resolved) return undefined;
				const label = reported(resolved.label);
				const facts: ConsentRequest["facts"] = [
					...(label ? ([["File", label]] as const) : []),
					["Folder", folder],
					["Limit", "25 MiB; an existing file is never overwritten"],
				];
				return { action: "Download a file from the server to this computer", facts, confirmLabel: "download" };
			},
			run: async (payload, context) => {
				const resolved = resolveDownload(record(payload), context.grant.target?.session);
				if (!resolved) throw new Error("Invalid download");
				const signal = AbortSignal.any([context.grant.signal, AbortSignal.timeout(60_000)]);
				const response = await request(resolved.path, { signal });
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					throw new Error(`The server refused the download (${response.status})`);
				}
				const length = Number(response.headers.get("content-length"));
				if (length > MAX_DOWNLOAD) {
					await response.body?.cancel().catch(() => {});
					throw new Error("Download exceeds 25 MiB");
				}
				const name = safeFileName(
					dispositionName(response.headers.get("content-disposition")) ?? resolved.fallback,
				);
				const path = await saveBounded(response, folder, name, signal);
				// The local path stays in the launcher: the worker learns only that it was saved.
				await context.ui.notice(`Saved ${path}`, 2500);
				return { saved: true };
			},
		},
		/** K (Ctrl+G): edit the editor's text in the visitor's editor; the result goes back only if the grant holds. */
		"editor.external": {
			kind: "K",
			key: "app.editor.external",
			run: async (context) => {
				const argv = options.editor;
				if (!argv?.length) {
					await context.ui.notice(
						"No external editor: set externalEditor in pi's settings.json, $VISUAL or $EDITOR",
						3000,
					);
					return;
				}
				const value = record(await context.ask("editorText"));
				const text = value?.text;
				if (typeof text !== "string" || Buffer.byteLength(text) > MAX_EDITOR) {
					await context.ui.notice("Nothing to edit here");
					return;
				}
				const directory = mkdtempSync(join(tmpdir(), "p2-editor-"));
				const file = join(directory, "prompt.md");
				let result: string | undefined;
				try {
					await writeFile(file, text, { mode: 0o600 });
					const code = await context.releaseTerminal(() => (options.runEditor ?? spawnEditor)(argv, file));
					if (code === 0) {
						const edited = await readFile(file, "utf8");
						if (Buffer.byteLength(edited) <= MAX_EDITOR)
							result = edited.replace(/^\uFEFF/, "").replace(/\n$/, "");
					}
				} finally {
					rmSync(directory, { recursive: true, force: true });
				}
				if (result === undefined) await context.ui.notice("The editor failed; the text is unchanged");
				// `ask` refuses once the grant ended (navigation or a worker swap): the result is dropped.
				else await context.ask("editorResult", { text: result });
			},
		},
		/** K (Ctrl+Z): job control; modes are undone first and restored on resume. */
		suspend: {
			kind: "K",
			key: "app.suspend",
			run: async (context) => {
				if (platform === "win32") {
					await context.ui.notice("Suspend to background is not supported on Windows");
					return;
				}
				await context.releaseTerminal(() => (options.suspendProcess ?? suspendThisProcess)());
			},
		},
		/**
		 * C (`/settings`, theme picker, `/keybindings`): `{patch}` for p2's own `prefs.json`. Refused before anything is
		 * shown when it touches launcher-owned bindings or anything but keybindings, theme and whitelisted settings (the
		 * editor command, the mouse policy, the download folder). The screen shows the change as a diff of the file.
		 */
		savePrefs: {
			kind: "C",
			consent: (payload) => {
				const checked = validatePrefsPatch(record(payload)?.patch);
				if ("error" in checked) return undefined;
				let current: Record<string, unknown>;
				try {
					current = readPrefsFile(prefsDirectory);
				} catch {
					return undefined;
				}
				const diff = prefsDiff(current, applyPrefsPatch(current, checked.patch));
				if (!diff.length) return undefined;
				return {
					action: "Save your TUI preferences on this computer",
					facts: [["File", join(prefsDirectory, "prefs.json")]],
					preview: diff.join("\n"),
					confirmLabel: "save",
				};
			},
			run: async (payload) => {
				const checked = validatePrefsPatch(record(payload)?.patch);
				if ("error" in checked) throw new Error(checked.error);
				// Re-read: the file may have changed while the screen was up; the patch applies to what is there now.
				writePrefsFile(prefsDirectory, applyPrefsPatch(readPrefsFile(prefsDirectory), checked.patch));
				return { saved: true };
			},
		},
		/** C (owner): `{action: "reload"}` on the dev channel `/__p2_dev`, with the launcher's own sign-in. */
		devCommand: {
			kind: "C",
			consent: (payload) =>
				options.role === "owner" &&
				record(payload)?.action === "reload" &&
				Object.keys(record(payload)!).length === 1
					? { action: "Reload the server's changed plugins (dev server)", confirmLabel: "reload" }
					: undefined,
			run: async (_payload, context) => {
				const response = await request("/__p2_dev", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "reload" }),
					signal: AbortSignal.any([context.grant.signal, AbortSignal.timeout(120_000)]),
				});
				const text = (await response.text()).slice(0, 2000);
				let message = "";
				try {
					const value = record(JSON.parse(text));
					if (typeof value?.message === "string") message = value.message;
				} catch {}
				if (!response.ok) throw new Error(message || `The server refused (${response.status})`);
				return { message };
			},
		},
		/** C (owner): `{all}` signs out this device's cookie, or every owner device. The cookie is then forgotten. */
		signOut: {
			kind: "C",
			consent: (payload) => {
				const all = record(payload)?.all;
				if (options.role !== "owner" || typeof all !== "boolean") return undefined;
				// Loopback is the device owner by address; it has no cookie to end.
				if (!all && (loopback || !options.credentials.cookie)) return undefined;
				return {
					action: all ? "Sign out ALL owner devices, this one included" : "Sign out this device",
					facts: all
						? [["Effect", "Every owner cookie stops working; each device needs a new owner link."]]
						: [["Effect", "This launcher's sign-in ends; it asks for an owner link again."]],
					confirmLabel: "sign out",
				};
			},
			run: async (payload, context) => {
				const all = record(payload)?.all === true;
				const response = await request(all ? "/owner/logout-all" : "/owner/logout", {
					method: "POST",
					signal: AbortSignal.any([context.grant.signal, AbortSignal.timeout(10_000)]),
				});
				await response.body?.cancel().catch(() => {});
				if (!response.ok) throw new Error(`The server refused (${response.status})`);
				options.onSignedOut?.(all);
				return null;
			},
		},
	};
	function resolveOpen(value: Record<string, unknown> | undefined, session: string | undefined) {
		if (value?.kind === "external" && typeof value.url === "string" && value.url.length <= 2048) {
			let target: URL;
			try {
				target = new URL(value.url);
			} catch {
				return undefined;
			}
			return target.protocol === "https:" && !target.username && !target.password
				? { url: target, external: true }
				: undefined;
		}
		if (value?.kind !== "origin") return undefined;
		const target = originPath(url, value.path);
		// Session content opens only for the session the worker is bound to; any session's page may open.
		const content = target && target.pathname !== "/" && !target.pathname.startsWith("/s/");
		if (!target || (content && target.searchParams.get("session") !== session)) return undefined;
		return { url: target, external: false };
	}
	function resolveDownload(value: Record<string, unknown> | undefined, session: string | undefined) {
		if (!value || typeof value.session !== "string" || value.session !== session || !UUID.test(value.session))
			return undefined;
		const query = new URLSearchParams({ session: value.session });
		if (value.kind === "file" && typeof value.id === "string" && UUID.test(value.id)) {
			query.set("id", value.id);
			return {
				path: `/download?${query}`,
				label: value.name,
				fallback: typeof value.name === "string" ? value.name : undefined,
			};
		}
		if (
			value.kind === "artifact" &&
			typeof value.name === "string" &&
			ARTIFACT.test(value.name) &&
			typeof value.version === "number" &&
			Number.isInteger(value.version) &&
			value.version >= 0 &&
			value.version < 1_000_000
		) {
			query.set("name", value.name);
			query.set("version", String(value.version));
			query.set("download", "1");
			return { path: `/artifact?${query}`, label: `${value.name} v${value.version}`, fallback: value.name };
		}
		return undefined;
	}
	return actions;
}
