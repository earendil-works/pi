// Bundled on the server, evaluated inside the locked-down worker. No Node transports or local facet loader.
import type { Link, PluginFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ProgramStatus,
	setCapabilityOverrides,
	setKittyProtocolActive,
	type Terminal,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import { Access } from "../runtime/access.ts";
import { createHost, hostErrorText, newerPeerProtocol } from "../runtime/chord.ts";
import { type P2Principal, SERVER } from "../runtime/principals.ts";
import { follow, whenLive } from "../runtime/refs.ts";
import { TuiRuntime } from "../runtime/tui.ts";
import type { TuiGrantResult } from "../runtime/tui-context.ts";
import { TuiPreferences } from "../runtime/tui-preferences.ts";
import { tuiCoreFacet } from "../tui/core-commands.ts";
import { parseLocalPreferences } from "../tui/preferences.ts";
import { restoreRuntime, snapshotRuntime } from "../tui/snapshot.ts";
import { parseTerminalState } from "../tui/theme/theme.ts";

type Bridge = {
	input: { columns: number; rows: number; origin?: unknown; mouse?: unknown };
	send(value: unknown): void;
	onMessage(handler: (message: Record<string, unknown>) => unknown): void;
};
class BridgeTerminal implements Terminal {
	columns: number;
	rows: number;
	kittyProtocolActive = false;
	private send: Bridge["send"];
	onInput: (data: string) => void = () => {};
	onResize: () => void = () => {};
	constructor(bridge: Bridge) {
		this.columns = bridge.input.columns;
		this.rows = bridge.input.rows;
		this.send = bridge.send;
	}
	start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		this.onResize = onResize;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.send({ kind: "output", data });
	}
	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}
	// N actions (section 3.2): the launcher sanitizes, bounds and rate-limits them, and resets them on exit.
	setTitle(title: string): void {
		this.send({ kind: "title", text: title.slice(0, 200) });
	}
	setProgress(active: boolean): void {
		this.send({ kind: "progress", active });
	}
	setProgramStatus(status: ProgramStatus): void {
		this.send({ kind: "programStatus", state: status.state, message: status.message?.slice(0, 200) });
	}
}

/**
 * The host's parent link, relayed by the launcher: its messages travel as `link` bridge messages to the launcher's
 * socket and back. Until `activate` (the launcher's first activation) what is sent waits.
 */
class BridgeLink implements Link {
	closed = false;
	private listener: ((message: Uint8Array) => void) | undefined;
	private received: Uint8Array[] = [];
	private closeListener: (() => void) | undefined;
	private queue: Uint8Array[] = [];
	private active = false;
	private sendBridge: Bridge["send"];
	constructor(send: Bridge["send"]) {
		this.sendBridge = send;
	}
	send(message: Uint8Array): void {
		if (this.closed) return;
		if (this.active) this.sendBridge({ kind: "link", data: message });
		else this.queue.push(message);
	}
	onMessage(listener: (message: Uint8Array) => void): void {
		if (this.closed) return;
		this.listener = listener;
		for (const message of this.received.splice(0)) listener(message);
	}
	onClose(listener: () => void): void {
		if (this.closed) listener();
		else this.closeListener = listener;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const listener = this.closeListener;
		this.listener = undefined;
		this.closeListener = undefined;
		this.received = [];
		listener?.();
	}
	activate(): void {
		this.active = true;
		for (const message of this.queue.splice(0)) this.sendBridge({ kind: "link", data: message });
	}
	deliver(message: Uint8Array): void {
		if (this.closed) return;
		if (this.listener) this.listener(message);
		else this.received.push(message);
	}
}

export async function setupTui(bridge: Bridge, facets: readonly PluginFacet<P2Principal>[]): Promise<void> {
	setCapabilityOverrides({ images: null, hyperlinks: false });
	const terminal = new BridgeTerminal(bridge);
	// pi's fullscreen, as is: the mouse is captured (wheel scrolling, selection, copy on select) unless the visitor's
	// launcher policy turns it off. Only the clipboard write differs: pi-tui's OSC 52 would be filtered, so its
	// `copySelection` hook asks the launcher, which accepts only right after it saw the release itself.
	let requestCopy: (text: string) => Promise<boolean | string> = async () => "Copy unavailable";
	const tui = new TuiAltScreen(terminal, true, undefined, {
		mouse: bridge.input.mouse === true,
		wheelScrollLines: "auto",
		copySelection: (text) => requestCopy(text),
	});
	let runtime: TuiRuntime | undefined;
	const host = createHost({
		onError: (error) => {
			// A server that speaks another link protocol was updated: this bundle is outdated, so the launcher loads
			// the current one into a fresh worker (as `/reload` does).
			if (newerPeerProtocol(error)) bridge.send({ kind: "reload" });
			else if (
				error.kind === "routine_failed" ||
				error.kind === "derive_failed" ||
				error.kind === "activation_failed" ||
				error.kind === "object_failed" ||
				error.kind === "registry_undeclared" ||
				error.kind === "unbound_long" ||
				error.kind === "transaction_cancelled"
			)
				runtime?.fail(hostErrorText(error));
		},
	});
	runtime = new TuiRuntime(host, tui);
	let link = new BridgeLink(bridge.send);
	const linkOptions = { principal: SERVER };
	host.connect(link, linkOptions, BACKGROUND_CONTEXT);
	const loaded = await host.load([...facets, { name: "@p2/tui-core", facet: tuiCoreFacet }], BACKGROUND_CONTEXT);
	runtime.origin = typeof bridge.input.origin === "string" ? bridge.input.origin.slice(0, 200) : undefined;
	await runtime.start();
	// A facet left out at load (its setup threw) is shown, not silently missing.
	for (const { plugin, error } of loaded.failed)
		runtime.fail(`TUI plugin ${plugin} failed to load: ${error instanceof Error ? error.message : String(error)}`);
	// Fullscreen layout (P0c): the runtime's root is the layout; the runtime itself stays the focused input target.
	tui.setLayoutRoot(runtime.root);
	tui.setFocus(runtime);
	runtime.onExit = () => bridge.send({ kind: "exit" });
	runtime.onReload = () => bridge.send({ kind: "reload" });
	// Launcher C requests: answered by the launcher after its own consent UI (section 3.3).
	let nextRequest = 0;
	const requests = new Map<number, (result: TuiGrantResult) => void>();
	runtime.onGrant = (action, payload) =>
		new Promise((resolve) => {
			const id = ++nextRequest;
			requests.set(id, resolve);
			bridge.send({ kind: "request", id, action, payload });
		});
	requestCopy = async (text) => {
		const result = await runtime.onGrant("copy.selection", { text: text.slice(0, 1024 * 1024) });
		return result.ok ? true : result.error === "failed" ? "Copy failed" : false;
	};
	// Reports the launcher binds grants to (navigation), the keys it may intercept (keyContext) and progress.
	let reported: { target?: string; suspend?: boolean; busy?: boolean } = {};
	let wheelLines: unknown;
	const report = (): void => {
		// pi's fullscreenWheelScrollLines and fullscreenCopyOnSelect settings, applied as pi does.
		const settings = runtime.appearance.settings;
		const lines = settings.fullscreenWheelScrollLines ?? "auto";
		if (lines !== wheelLines) {
			wheelLines = lines;
			tui.setWheelScrollLines(lines);
		}
		tui.setCopyOnSelect(settings.fullscreenCopyOnSelect ?? true);
		const target = runtime.session === undefined ? "" : `${runtime.session}#${runtime.conversation}`;
		if (target !== reported.target)
			bridge.send({ kind: "navigation", session: runtime.session, conversation: runtime.conversation });
		// Rule 3: while anything but the runtime has focus (transcript search, a dialog's text input), keys like
		// Ctrl+G belong to it, not to the launcher.
		const suspend = tui.getFocusedComponent() !== runtime;
		if (suspend !== reported.suspend) bridge.send({ kind: "keyContext", suspendPrivileged: suspend });
		const busy = runtime.contexts().has("busy");
		if (busy !== reported.busy) {
			terminal.setProgress(busy);
			terminal.setProgramStatus({ state: busy ? "working" : "idle" });
		}
		reported = { target, suspend, busy };
	};
	runtime.listeners.add(report);
	let access: ReturnType<typeof host.hold<typeof Access>> | undefined;
	bridge.onMessage(async (message) => {
		if (message.kind === "snapshot") return snapshotRuntime(runtime);
		if (message.kind === "activate") {
			restoreRuntime(runtime, message.state);
			link.activate();
			tui.start();
			if (runtime.origin) terminal.setTitle(`π p2 · ${new URL(runtime.origin).host}`);
			report();
			runtime.changed();
		} else if (message.kind === "connection") {
			runtime.connected = message.open === true;
			if (runtime.connected) {
				if (link.closed) {
					link = new BridgeLink(bridge.send);
					host.connect(link, linkOptions, BACKGROUND_CONTEXT);
					link.activate();
				}
				// Held for the connection: the role and a guest's grant follow it (released when the link drops).
				access?.release();
				const held = host.hold(Access, {}, BACKGROUND_CONTEXT);
				access = held;
				void whenLive(held)
					.then(() => {
						runtime.role = held.variant === "owner" ? "owner" : "guest";
						runtime.changed();
						if (held.variant === "guest")
							follow(held.grant, (grant) => {
								runtime.grant = grant
									? { name: grant.name, sessions: grant.sessions ?? { [grant.session]: grant.mode } }
									: undefined;
								if (grant) runtime.navigate("chat", grant.session);
							});
					})
					.catch((error: unknown) => runtime.fail(error));
				void host
					.root(async (ctx) => (await ctx.get(TuiPreferences, {})).read(ctx), BACKGROUND_CONTEXT)
					// Server defaults sit below the guest's local preferences (section 4.2).
					.then((server) => runtime.appearance.update({ server }))
					.catch((error: unknown) => runtime.fail(error));
			} else link.close();
			runtime.changed();
		} else if (message.kind === "preferences")
			runtime.appearance.update({ local: parseLocalPreferences(message.preferences) });
		else if (message.kind === "terminalColors")
			runtime.appearance.update({ terminal: parseTerminalState(message.terminal) });
		else if (message.kind === "capabilities") {
			// Launcher-negotiated terminal facts (section 3.2): kitty keyboard, color depth, the guest's platform.
			setKittyProtocolActive(message.kittyProtocol === true);
			terminal.kittyProtocolActive = message.kittyProtocol === true;
			runtime.appearance.update({
				capabilities: {
					trueColor: message.trueColor === true,
					platform: typeof message.platform === "string" ? message.platform.slice(0, 16) : "linux",
					windowsKeys: message.windowsKeys === true,
				},
			});
		} else if (message.kind === "redraw") {
			// After launcher-drawn UI: the launcher discarded output meanwhile.
			tui.requestRender(true);
		} else if (message.kind === "response" && typeof message.id === "number") {
			const resolve = requests.get(message.id);
			requests.delete(message.id);
			resolve?.(
				message.ok === true
					? { ok: true, value: message.value }
					: { ok: false, error: typeof message.error === "string" ? message.error : "denied" },
			);
		} else if (message.kind === "grantRequest" && typeof message.ask === "string") {
			return (await runtime.launcherAnswers.get(message.ask)?.(message.payload)) ?? null;
		} else if (message.kind === "link" && message.data instanceof Uint8Array) link.deliver(message.data);
		else if (message.kind === "input" && typeof message.data === "string") {
			terminal.onInput(message.data);
			// After pi-tui handled the key (it may have opened or closed the transcript search).
			report();
		} else if (message.kind === "resize" && typeof message.columns === "number" && typeof message.rows === "number") {
			terminal.columns = message.columns;
			terminal.rows = message.rows;
			terminal.onResize();
		}
		return null;
	});
}
