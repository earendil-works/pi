// Trusted launcher transport. Downloaded code sees opaque chord frames, not the socket, URL or sign-in cookie.
import { createHash } from "node:crypto";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import type { TuiLocalPreferences } from "../tui/preferences.ts";
import type { TuiCredentials } from "./tui-config.ts";
import { MAX_TERMINAL_FRAME } from "./tui-filter.ts";
import {
	type Grant,
	Grants,
	type GrantTarget,
	type LauncherAction,
	type LauncherActionContext,
	PrivilegedKeys,
	parseTarget,
} from "./tui-grants.ts";
import { launcherCapabilities } from "./tui-local-preferences.ts";
import { type MousePolicy, TerminalModes } from "./tui-modes.ts";
import { SelectionGesture } from "./tui-mouse.ts";
import { MAX_TUI_BUNDLE, requireTuiNode, TuiSandbox } from "./tui-sandbox.ts";
import { colorFgBgScheme, TerminalColorProbe } from "./tui-terminal-colors.ts";
import { cookieTransport, MAX_LINK_FRAME, type TuiSocket, type TuiTransport } from "./tui-transport.ts";
import { TrustedUi, visibleText } from "./tui-trusted-ui.ts";

/** How long after the launcher saw a selection gesture pi-tui's copy request is accepted. */
const GESTURE_WINDOW_MS = 2000;
/** The server no longer admits this sign-in (401/403): a revoked or reset share, an archived session, a logout. */
export class TuiAccessEnded extends Error {
	constructor() {
		super("Access to this server ended");
	}
}
async function readBounded(response: Response, limit: number): Promise<string> {
	if (response.status === 401 || response.status === 403) {
		await response.body?.cancel().catch(() => {});
		throw new TuiAccessEnded();
	}
	if (!response.ok || !response.body) throw new Error("Cannot fetch admitted TUI code; check URL and sign-in");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("TUI download exceeds its size limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
export type TuiClient = {
	readonly version: string;
	readonly connected: boolean;
	readonly sandbox: TuiSandbox | undefined;
	reload(): Promise<void>;
	snapshot(): Promise<unknown>;
	close(): Promise<void>;
};
export async function startTuiClient(options: {
	terminal: Pick<Terminal, "start" | "stop" | "write" | "columns" | "rows"> &
		Partial<Pick<Terminal, "kittyProtocolActive" | "setTitle" | "setProgress" | "setProgramStatus">>;
	/** Launcher actions by name (section 3.2): K actions fire on the visitor's own privileged key, C after consent. */
	actions?: Readonly<Record<string, LauncherAction>>;
	/** The visitor's mouse policy (launcher-only preference): which mouse modes worker output may enable. */
	mouse?: MousePolicy;
	/** Who the launcher was admitted as: the TUI starts with that role, so owner views hold before `Access` answers. */
	role?: "owner" | "guest";
	url: URL;
	/** The visitor's validated local preferences (section 4.2) and their change feed; sent to every worker as data. */
	preferences?: {
		current: TuiLocalPreferences;
		subscribe?(listener: (next: TuiLocalPreferences) => void): () => void;
	};
	capabilities?: ReturnType<typeof launcherCapabilities>;
	colorQueryMs?: number;
	credentials?: TuiCredentials;
	/** How requests reach the server; default: directly to `url` with `credentials`. */
	transport?: TuiTransport;
	reconnectMs?: number;
	pollMs?: number;
	onExit?: () => void;
	onFailure?: (message: string) => void;
	/** The server stopped admitting these credentials while running (section 4.1 revocation); the client closes. */
	onAccessEnded?: () => void;
}): Promise<TuiClient> {
	requireTuiNode();
	const transport = options.transport ?? cookieTransport(options.url, options.credentials ?? {});
	let sandbox: TuiSandbox | undefined;
	let preparing: TuiSandbox | undefined;
	let closing: Promise<void> | undefined;
	let socket: TuiSocket | undefined;
	let version = "";
	let connected = false;
	let closed = false;
	let retry: NodeJS.Timeout | undefined;
	let polling: NodeJS.Timeout | undefined;
	let loading: Promise<void> | undefined;
	let started = false;
	/** The real terminal is lent to a local program (editor, suspend): worker IO is suspended. */
	let paused = false;
	let releaseTerminal: <T>(run: () => Promise<T>) => Promise<T> = (run) => run();
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let preferences = options.preferences?.current;
	const capabilities = options.capabilities ?? launcherCapabilities();
	const actions = options.actions ?? {};
	const keyActions = new Map<string, [name: string, action: Extract<LauncherAction, { kind: "K" }>]>();
	for (const [name, action] of Object.entries(actions))
		if (action.kind === "K") keyActions.set(action.key, [name, action]);
	const privilegedKeys = () =>
		new PrivilegedKeys(preferences?.keybindings ?? {}, capabilities, [...keyActions.keys()]);
	let privileged = privilegedKeys();
	const stopPreferences = options.preferences?.subscribe?.((next) => {
		preferences = next;
		privileged = privilegedKeys();
		sandbox?.post({ kind: "preferences", preferences });
	});
	const modes = new TerminalModes(options.mouse);
	const selection = new SelectionGesture();
	/** When the launcher last saw a selection-ending release; consumed by the copy it permits. */
	let gestureAt: number | undefined;
	const ui = new TrustedUi(options.terminal, options.url.origin);
	const grants = new Grants(options.url.origin);
	/** Per worker: the session/conversation it last reported, and whether it suspended privileged keys (rule 3). */
	const targets = new WeakMap<TuiSandbox, GrantTarget>();
	let suspendPrivileged = false;
	/** One launcher interaction at a time: a pending consent or a running action. */
	let busy = false;
	// After launcher-drawn UI: the worker's output was discarded, so restore its modes and ask for a full redraw.
	ui.onClose = () => {
		options.terminal.write(modes.restore());
		sandbox?.post({ kind: "redraw" });
	};
	let kitty = options.terminal.kittyProtocolActive === true;
	const postCapabilities = (target: TuiSandbox | undefined): void =>
		target?.post({ kind: "capabilities", ...capabilities, kittyProtocol: kitty });
	let colorsKnown = false;
	const probe = new TerminalColorProbe({
		write: (data) => options.terminal.write(data),
		scheme: colorFgBgScheme(),
		timeoutMs: options.colorQueryMs,
		onUpdate: (terminal) => {
			colorsKnown = true;
			sandbox?.post({ kind: "terminalColors", terminal });
		},
	});
	// N actions (section 3.2): sanitized, bounded and at most four per second each; dropped while launcher UI shows.
	const statusTimes = new Map<string, number[]>();
	const pendingStatus = new Map<string, () => void>();
	const throttle = (kind: string, apply: () => void): void => {
		const now = Date.now();
		const recent = (statusTimes.get(kind) ?? []).filter((time) => now - time < 1000);
		if (recent.length < 4) {
			statusTimes.set(kind, [...recent, now]);
			apply();
			return;
		}
		if (!pendingStatus.has(kind))
			setTimeout(
				() => {
					const latest = pendingStatus.get(kind);
					pendingStatus.delete(kind);
					if (!closed) latest?.();
				},
				1000 - (now - recent[0]!),
			);
		pendingStatus.set(kind, apply);
	};
	let titled = false;
	let progressing = false;
	const showProgress = () => preferences?.settings.terminal?.showTerminalProgress === true;
	const statusMessage = (message: Record<string, unknown>): void => {
		if (ui.active || paused) return;
		if (message.kind === "title" && typeof message.text === "string") {
			const text = visibleText(message.text)
				.replace(/[\u2400-\u2421\ufffd]/g, " ")
				.slice(0, 80);
			throttle("title", () => {
				titled = true;
				options.terminal.setTitle?.(text);
			});
		} else if (message.kind === "progress" && typeof message.active === "boolean") {
			const active = message.active;
			if (!showProgress()) return;
			throttle("progress", () => {
				progressing = active;
				options.terminal.setProgress?.(active);
			});
		} else if (message.kind === "programStatus") {
			const states = ["idle", "working", "blocked", "done", "error", "clear"] as const;
			const state = states.find((value) => value === message.state);
			if (!state) return;
			const status: ProgramStatus = {
				state,
				app: "p2",
				...(typeof message.message === "string" ? { message: message.message.slice(0, 80) } : {}),
			};
			throttle("programStatus", () => options.terminal.setProgramStatus?.(status));
		}
	};
	const actionContext = (grant: Grant, worker: TuiSandbox): LauncherActionContext => ({
		grant,
		ui,
		origin: options.url,
		writeTerminal: (data) => options.terminal.write(data),
		sendInput: (data) => {
			if (grants.valid(grant.id, worker) && Buffer.byteLength(data) <= MAX_TERMINAL_FRAME)
				worker.post({ kind: "input", data });
		},
		releaseTerminal: (run) => releaseTerminal(run),
		ask: async (kind, payload) => {
			if (!grants.valid(grant.id, worker)) throw new Error("Grant cancelled");
			const value = await worker.request({ kind: "grantRequest", grant: grant.id, ask: kind, payload });
			if (!grants.valid(grant.id, worker)) throw new Error("Grant cancelled");
			return value;
		},
	});
	/** A worker's C request (section 3.3): validated, shown in the trusted UI, run only after local confirmation. */
	const consentRequest = async (worker: TuiSandbox, message: Record<string, unknown>): Promise<void> => {
		const id = message.id;
		if (typeof id !== "number" || !Number.isSafeInteger(id)) return;
		const respond = (value: { ok: true; value?: unknown } | { ok: false; error: string }) =>
			worker.post({ kind: "response", id, ...value });
		const name = typeof message.action === "string" ? message.action : "";
		const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
		if (action?.kind === "gesture") {
			// Only right after the launcher saw the gesture itself; the worker cannot open this window.
			const seen = gestureAt;
			gestureAt = undefined;
			if (seen === undefined || Date.now() - seen > GESTURE_WINDOW_MS || sandbox !== worker || ui.active || paused)
				return respond({ ok: false, error: "denied" });
			if (!action.accept(message.payload)) return respond({ ok: false, error: "denied" });
			const grant = grants.create(name, "gesture", worker, targets.get(worker));
			try {
				const value = await action.run(message.payload, actionContext(grant, worker));
				return respond({ ok: true, value });
			} catch {
				return respond({ ok: false, error: "failed" });
			} finally {
				grants.complete(grant.id);
			}
		}
		if (action?.kind !== "C") return respond({ ok: false, error: "denied" });
		if (busy || ui.active || sandbox !== worker) return respond({ ok: false, error: "busy" });
		const target = targets.get(worker);
		const consent = action.consent(message.payload, { origin: options.url, target });
		if (!consent) return respond({ ok: false, error: "denied" });
		busy = true;
		const grant = grants.create(name, "C", worker, target);
		try {
			const confirmed = await ui.confirm({
				...consent,
				facts: [
					...(target ? [["Session", `${target.session} #${target.conversation}`] as const] : []),
					...(consent.facts ?? []),
				],
			});
			if (!confirmed || !grants.valid(grant.id, worker))
				return respond({ ok: false, error: confirmed ? "cancelled" : "denied" });
			const value = await action.run(message.payload, actionContext(grant, worker));
			respond(grants.valid(grant.id, worker) ? { ok: true, value } : { ok: false, error: "cancelled" });
		} catch (error) {
			// Local errors stay local (section 3.4): the worker learns only that it failed.
			respond({ ok: false, error: "failed" });
			if (!closed) await ui.notice(`Failed: ${error instanceof Error ? error.message : String(error)}`, 2500);
		} finally {
			grants.complete(grant.id);
			busy = false;
		}
	};
	/** A privileged key (section 3.1 K): consumed here; its action gets a grant for this one use. */
	const keyAction = async (id: string): Promise<void> => {
		const entry = keyActions.get(id);
		const worker = sandbox;
		if (!entry || !worker || busy || ui.active) return;
		busy = true;
		const grant = grants.create(entry[0], "K", worker, targets.get(worker));
		try {
			await entry[1].run(actionContext(grant, worker));
		} catch (error) {
			if (!closed && !grant.signal.aborted)
				await ui.notice(`Failed: ${error instanceof Error ? error.message : String(error)}`, 2500);
		} finally {
			grants.complete(grant.id);
			busy = false;
		}
	};
	const fail = (message: string): void => {
		options.onFailure?.(message);
		void close();
		options.onExit?.();
	};
	let ended = false;
	const accessEnded = (): void => {
		if (ended || closed) return;
		ended = true;
		options.onAccessEnded?.();
		void close();
		options.onExit?.();
	};
	/** Confirms a refusal with the launcher's own fixed-origin request; a lying server can only end its own session. */
	const verifyAccess = (): void => {
		void transport
			.request("/__p2_tui", { method: "HEAD", signal: AbortSignal.timeout(10_000) })
			.then((response) => {
				if (response.status === 401 || response.status === 403) accessEnded();
			})
			.catch(() => {});
	};
	const send = (data: Uint8Array): void => {
		if (data.byteLength > MAX_LINK_FRAME) {
			fail("TUI link frame exceeds 4 MiB");
			return;
		}
		if (socket?.open) socket.send(data);
		else {
			pendingBytes += data.byteLength;
			if (pendingBytes > MAX_LINK_FRAME) {
				fail("TUI link queue exceeds 4 MiB");
				return;
			}
			pending.push(data);
		}
	};
	const connect = (attempt = 0): void => {
		if (closed) return;
		let opened = false;
		const current: TuiSocket = transport.socket("/chord", {
			open: () => {
				if (closed || socket !== current) {
					current.terminate();
					return;
				}
				opened = true;
				connected = true;
				for (const data of pending.splice(0)) current.send(data);
				pendingBytes = 0;
				sandbox?.post({ kind: "connection", open: true });
			},
			message: (data, binary) => {
				if (socket !== current || closed) return;
				// Chord's links carry binary messages only.
				if (!binary) {
					current.terminate();
					return;
				}
				sandbox?.post({ kind: "link", data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
			},
			refused: (status) => {
				if (status === 401 || status === 403) verifyAccess();
			},
			close: () => {
				if (closed || socket !== current) return;
				connected = false;
				sandbox?.post({ kind: "connection", open: false });
				// The replacement link emits fresh hello/holds. Never replay stale connection frames.
				pending = [];
				pendingBytes = 0;
				retry = setTimeout(
					() => connect(opened ? 0 : attempt + 1),
					Math.min(5000, (options.reconnectMs ?? 250) * 2 ** Math.min(attempt, 5)),
				);
			},
		});
		socket = current;
	};
	const load = (force: boolean): Promise<void> => {
		if (closed) return Promise.resolve();
		if (loading) return loading;
		loading = (async () => {
			const request = (path: string) => transport.request(path, { signal: AbortSignal.timeout(10_000) });
			const manifest: unknown = JSON.parse(await readBounded(await request("/__p2_tui"), 8192));
			if (
				!manifest ||
				typeof manifest !== "object" ||
				!("version" in manifest) ||
				typeof manifest.version !== "string" ||
				!/^[a-f0-9]{64}$/.test(manifest.version) ||
				!("bundle" in manifest) ||
				manifest.bundle !== `/__p2_tui/${manifest.version}.mjs`
			)
				throw new Error("Invalid TUI bundle manifest");
			if (manifest.version === version && !force) return;
			const source = await readBounded(await request(manifest.bundle), MAX_TUI_BUNDLE);
			if (createHash("sha256").update(source).digest("hex") !== manifest.version)
				throw new Error("TUI bundle version hash mismatch");
			let candidate!: TuiSandbox;
			candidate = new TuiSandbox(source, {
				input: {
					columns: Math.min(500, Math.max(10, options.terminal.columns)),
					rows: Math.min(200, Math.max(5, options.terminal.rows)),
					// The launcher's fixed origin, shown in the header (never credentials).
					origin: options.url.origin,
					// The visitor's mouse policy decides whether pi-tui captures the mouse (wheel, app-owned selection).
					mouse: (options.mouse ?? "off") !== "off",
					...(options.role ? { role: options.role } : {}),
				},
				onFailure: (message) => {
					if (sandbox === candidate) fail(message);
				},
				onMessage: (message) => {
					if (closed || sandbox !== candidate || !message || typeof message !== "object" || !("kind" in message))
						return;
					try {
						if (message.kind === "output" && "data" in message && typeof message.data === "string") {
							// Launcher UI is up: worker IO is suspended; a full redraw replaces what is dropped here.
							const output = modes.filter(message.data);
							if (!ui.active && !paused) options.terminal.write(output);
						} else if (message.kind === "keyContext" && "suspendPrivileged" in message)
							// Rule 3: the worker may only suspend interception (e.g. Ctrl+G is search-next while searching).
							suspendPrivileged = message.suspendPrivileged === true;
						else if (message.kind === "navigation") {
							const target = parseTarget(message);
							if (target) targets.set(candidate, target);
							else targets.delete(candidate);
							grants.navigate(candidate, target);
						} else if (message.kind === "request")
							void consentRequest(candidate, message as Record<string, unknown>);
						else if (message.kind === "title" || message.kind === "progress" || message.kind === "programStatus")
							statusMessage(message as Record<string, unknown>);
						else if (message.kind === "link" && "data" in message && message.data instanceof Uint8Array)
							send(message.data);
						// The worker's link closed on its own (e.g. Chord's heartbeat found the socket silent): drop the socket,
						// so its close reconnects. No new authority: malformed frames already make the server end the link.
						else if (message.kind === "linkClosed") socket?.terminate();
						else if (message.kind === "exit") {
							void close();
							options.onExit?.();
						} else if (message.kind === "reload")
							void load(true).catch(() => options.onFailure?.("TUI reload failed; previous worker retained"));
						// Unknown requests have no authority: no paths, URLs, clipboard or process operations.
					} catch {
						fail("TUI sandbox sent an invalid or oversized output frame");
					}
				},
			});
			preparing = candidate;
			try {
				await candidate.ready;
				if (closed) return;
				const previous = sandbox;
				const state = await previous?.request({ kind: "snapshot" });
				if (state !== undefined && Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024)
					throw new Error("TUI reload state exceeds 1 MiB");
				clearTimeout(retry);
				socket?.terminate();
				socket = undefined;
				connected = false;
				pending = [];
				pendingBytes = 0;
				// Swap: nothing granted to the old worker survives, and its terminal modes are undone first.
				if (previous) {
					grants.cancelWorker(previous);
					ui.cancel();
					options.terminal.write(modes.cleanup());
				}
				suspendPrivileged = false;
				sandbox = candidate;
				version = manifest.version;
				// Data only, before activation: the worker never reads local files or the environment.
				postCapabilities(candidate);
				if (preferences) candidate.post({ kind: "preferences", preferences });
				if (colorsKnown) candidate.post({ kind: "terminalColors", terminal: probe.state });
				candidate.post({ kind: "activate", state });
				connect();
				await previous?.terminate();
			} finally {
				if (preparing === candidate) preparing = undefined;
				if (sandbox !== candidate) await candidate.terminate();
			}
		})().finally(() => {
			loading = undefined;
		});
		return loading;
	};
	const close = (): Promise<void> => {
		closing ??= (async () => {
			closed = true;
			clearTimeout(retry);
			clearInterval(polling);
			stopPreferences?.();
			socket?.terminate();
			ui.cancel();
			grants.cancelAll();
			await Promise.all([sandbox?.terminate(), preparing?.terminate()]);
			if (started) probe.stop();
			if (titled) options.terminal.setTitle?.("");
			if (progressing) options.terminal.setProgress?.(false);
			options.terminal.setProgramStatus?.({ state: "clear" });
			// Exit and crash alike: undo every mode the worker enabled, then the fixed reset (section 3.6).
			options.terminal.write(modes.cleanup());
			options.terminal.stop();
		})();
		return closing;
	};
	const postResize = (): void =>
		sandbox?.post({
			kind: "resize",
			columns: Math.min(500, Math.max(10, options.terminal.columns)),
			rows: Math.min(200, Math.max(5, options.terminal.rows)),
		});
	const onInput = (data: string): void => {
		if (probe.consume(data) || paused) return;
		// Launcher-drawn UI consumes everything; nothing reaches the worker meanwhile.
		if (ui.active) {
			ui.handleInput(data);
			return;
		}
		// The launcher negotiates the kitty keyboard protocol; the worker must decode accordingly.
		if ((options.terminal.kittyProtocolActive === true) !== kitty) {
			kitty = !kitty;
			postCapabilities(sandbox);
		}
		const key = suspendPrivileged ? undefined : privileged.match(data);
		if (key) {
			if (!key.release) void keyAction(key.id);
			return;
		}
		// Copy on selection (rule 5): the release the launcher itself saw ending a drag or multi-click opens a short,
		// single-use window in which pi-tui's copy-on-select request (sent by the worker on that release) is accepted.
		if ((options.mouse ?? "off") !== "off" && selection.feed(data)) gestureAt = Date.now();
		if (Buffer.byteLength(data) <= MAX_TERMINAL_FRAME) sandbox?.post({ kind: "input", data });
	};
	const onResize = (): void => {
		if (ui.active) ui.render();
		postResize();
	};
	/**
	 * Hands the real terminal to a local program (external editor, job control): worker IO is suspended, the worker's
	 * modes are undone (without forgetting them) and the terminal stopped; afterwards everything is restored and the
	 * worker redraws (section 3.2 `externalEditor`, `suspend`).
	 */
	releaseTerminal = async <T>(run: () => Promise<T>): Promise<T> => {
		paused = true;
		options.terminal.write(modes.suspendSequence());
		options.terminal.stop();
		try {
			return await run();
		} finally {
			if (!closed) {
				options.terminal.start(onInput, onResize);
				options.terminal.write(modes.resumeSequence());
				paused = false;
				postResize();
				sandbox?.post({ kind: "redraw" });
			}
		}
	};
	try {
		await load(false);
		if (closed) throw new Error("TUI sandbox closed during startup");
		options.terminal.start(onInput, onResize);
		started = true;
		probe.start();
	} catch (error) {
		await close();
		throw error;
	}
	polling = setInterval(() => {
		void load(false).catch((error: unknown) => {
			if (error instanceof TuiAccessEnded) accessEnded();
		});
	}, options.pollMs ?? 1000);
	return {
		get version() {
			return version;
		},
		get connected() {
			return connected;
		},
		get sandbox() {
			return sandbox;
		},
		reload: () => load(true),
		snapshot: () => sandbox?.request({ kind: "snapshot" }) ?? Promise.resolve(undefined),
		close,
	};
}
