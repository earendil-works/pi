// Reusable in-process views presented either in pi overlays or thin, authenticated Rex viewers.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Compile } from "typebox/compile";
import { getInternalInvocation } from "../../config.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { localProof, receivePackets, sendPacket, verifyLocalProof } from "../local-channel.ts";
import {
	closeRexPane,
	getRexLocation,
	openRexPane,
	type RexLocation,
	type RexPane,
	setRexPaneMinimized,
	setRexPaneTitle,
	showRexPane,
} from "../rex.ts";
import { PaneInputSchema } from "./protocol.ts";

export interface PaneView {
	render(width: number, height: number): string[];
	handleInput(data: string): void;
	dispose(): void | Promise<void>;
}
export interface PaneControls {
	invalidate(): void;
	close(): void;
	minimize(): Promise<void>;
	setTitle(title: string): Promise<void>;
}
export interface PaneHandle {
	readonly backend: "rex" | "tui";
	readonly placement: "split" | "floating" | undefined;
	readonly closed: Promise<void>;
	close(): Promise<void>;
	show(): Promise<void>;
	minimize(): Promise<void>;
}
export interface PaneOptions {
	title: string;
	create: (controls: PaneControls) => PaneView;
	backend?: "auto" | "rex" | "tui";
	placement?: "split" | "floating";
	/** Background presentation may require Rex without opening a fallback overlay. */
	fallback?: "tui" | "none";
	minimized?: boolean;
	location?: RexLocation;
	signal?: AbortSignal;
}

const inputValidator = Compile(PaneInputSchema);
class RexUnavailableError extends Error {}

/** Present one view through Rex when running inside it, with the same view as a TUI fallback. */
export async function openPane(
	ctx: Pick<ExtensionContext, "ui" | "mode" | "cwd">,
	options: PaneOptions,
): Promise<PaneHandle> {
	options.signal?.throwIfAborted();
	if (ctx.mode !== "tui") throw new Error("Live panes require interactive pi mode");
	const settings = ctx.ui.getRexSettings();
	options = {
		...options,
		backend: options.backend && options.backend !== "auto" ? options.backend : settings.enabled ? "auto" : "tui",
		placement: options.placement ?? (options.minimized ? "floating" : settings.mode),
	};
	if (options.minimized && options.placement === "split")
		throw new Error("Minimized panes require floating Rex placement");
	const location = options.location ?? getRexLocation();
	if (options.backend !== "tui" && location) {
		try {
			return await openRemotePane(ctx, options, location);
		} catch (error) {
			if (!(error instanceof RexUnavailableError) || options.signal?.aborted) throw error;
			if (options.fallback === "none") throw error;
			ctx.ui.notify(`Rex view unavailable; using pi overlay: ${error.message}`, "warning");
		}
	} else if (options.backend !== "tui") {
		if (options.fallback === "none") throw new RexUnavailableError("No Rex session context");
		if (options.backend === "rex") ctx.ui.notify("No Rex session context; using pi overlay", "warning");
	}
	return openOverlay(ctx, options);
}

function openOverlay(ctx: Pick<ExtensionContext, "ui" | "mode" | "cwd">, options: PaneOptions): Promise<PaneHandle> {
	const ready = Promise.withResolvers<PaneHandle>();
	const closed = Promise.withResolvers<void>();
	let overlay: OverlayHandle | undefined;
	let hidden = options.minimized ?? false;
	let view: PaneView | undefined;
	let finish: (() => void) | undefined;
	let stopped = false;
	const handle: PaneHandle = {
		backend: "tui",
		placement: undefined,
		closed: closed.promise,
		async close() {
			finish?.();
			await closed.promise;
		},
		async show() {
			hidden = false;
			overlay?.setHidden(false);
			overlay?.focus();
		},
		async minimize() {
			hidden = true;
			overlay?.setHidden(true);
		},
	};
	const abort = () => finish?.();
	options.signal?.addEventListener("abort", abort, { once: true });
	const presentation = ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) => {
			finish = () => {
				if (!stopped) {
					stopped = true;
					done();
				}
			};
			options.signal?.throwIfAborted();
			view = options.create({
				invalidate: () => {
					if (!stopped && !hidden) tui.requestRender();
				},
				close: () => finish?.(),
				minimize: handle.minimize,
				async setTitle(title) {
					if (stopped || options.title === title) return;
					options.title = title;
					if (!hidden) tui.requestRender();
				},
			});
			if (options.signal?.aborted) finish();
			ready.resolve(handle);
			return {
				render: (width: number) =>
					frame(ctx, options, view!, width, Math.max(4, Math.floor(tui.terminal.rows * 0.8))),
				handleInput: (data: string) => view?.handleInput(data),
				invalidate: () => {},
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "80%", maxHeight: "80%" },
			onHandle: (value) => {
				overlay = value;
				if (hidden) value.setHidden(true);
			},
		},
	);
	void presentation.then(
		async () => {
			stopped = true;
			options.signal?.removeEventListener("abort", abort);
			try {
				await view?.dispose();
			} catch (error) {
				ctx.ui.notify(`Pane cleanup failed: ${String(error)}`, "error");
			} finally {
				view = undefined;
				closed.resolve();
			}
		},
		(error: unknown) => {
			options.signal?.removeEventListener("abort", abort);
			ready.reject(error);
			closed.resolve();
		},
	);
	return ready.promise;
}

async function openRemotePane(
	ctx: Pick<ExtensionContext, "ui" | "mode" | "cwd">,
	options: PaneOptions,
	location: RexLocation,
): Promise<PaneHandle> {
	const directory = mkdtempSync(join(tmpdir(), "pi-pane-"));
	const token = randomBytes(32).toString("hex");
	const closed = Promise.withResolvers<void>();
	const connected = Promise.withResolvers<void>();
	let client: Socket | undefined;
	let pane: RexPane | undefined;
	let view: PaneView | undefined;
	let width = 80;
	let height = 24;
	let stopped = false;
	let hidden = options.minimized ?? false;
	let renderScheduled = false;
	let titleUpdates = Promise.resolve();
	const sockets = new Set<Socket>();
	const handle: PaneHandle = {
		backend: "rex",
		placement: options.placement ?? "floating",
		closed: closed.promise,
		async close() {
			await finish();
			if (pane) await closeRexPane(pane, ctx.cwd);
		},
		async show() {
			hidden = false;
			if (pane) await showRexPane(pane, ctx.cwd);
			invalidate();
		},
		async minimize() {
			if (!pane) return;
			await setRexPaneMinimized(pane, true, ctx.cwd);
			hidden = true;
		},
	};
	const abort = () => {
		void handle.close().catch((error: unknown) => ctx.ui.notify(String(error), "warning"));
	};
	function invalidate() {
		if (stopped || hidden || renderScheduled) return;
		renderScheduled = true;
		setImmediate(() => {
			renderScheduled = false;
			if (!stopped && client && view && !hidden)
				sendPacket(client, { type: "frame", lines: frame(ctx, options, view, width, height) });
		});
	}
	function setTitle(title: string): Promise<void> {
		if (stopped || options.title === title) return titleUpdates;
		options.title = title;
		invalidate();
		titleUpdates = titleUpdates
			.catch(() => {})
			.then(async () => {
				// Coalesce queued label changes, preserving order if a CLI request is already in flight.
				if (!stopped && pane && options.title === title) await setRexPaneTitle(pane, title, ctx.cwd);
			});
		return titleUpdates;
	}
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.setNoDelay(true);
		socket.setTimeout(5000, () => socket.destroy());
		socket.on("error", () => {});
		socket.once("close", () => {
			sockets.delete(socket);
			if (socket === client) {
				connected.reject(new Error("Rex viewer disconnected during startup"));
				void finish();
			}
		});
		receivePackets(socket, (packet) => {
			// Trust boundary: drawing and input are accepted only from our authenticated local viewer.
			if (!inputValidator.Check(packet)) return socket.destroy();
			if (packet.type === "hello") {
				if (!verifyLocalProof(token, "pane-client", packet.proof) || client) return socket.destroy();
				client = socket;
				width = packet.columns;
				height = packet.rows;
				sendPacket(socket, { type: "ready", proof: localProof(token, "pane-server") });
				socket.setTimeout(0);
				connected.resolve();
				invalidate();
			} else if (socket !== client) socket.destroy();
			else if (packet.type === "resize") {
				width = packet.columns;
				height = packet.rows;
				invalidate();
			} else view?.handleInput(packet.data);
		});
	});
	server.maxConnections = 16;
	let handshakeTimeout: NodeJS.Timeout | undefined;
	async function finish() {
		if (stopped) return closed.promise;
		stopped = true;
		clearTimeout(handshakeTimeout);
		options.signal?.removeEventListener("abort", abort);
		if (client) {
			const socket = client;
			sendPacket(socket, { type: "close" });
			socket.end(() => socket.destroy());
		}
		for (const socket of sockets) if (socket !== client) socket.destroy();
		if (server.listening) server.close();
		try {
			await view?.dispose();
		} catch (error) {
			ctx.ui.notify(`Pane cleanup failed: ${String(error)}`, "error");
		} finally {
			view = undefined;
			rmSync(directory, { recursive: true, force: true });
			closed.resolve();
		}
	}
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		server.on("error", (error) => {
			connected.reject(error);
			ctx.ui.notify(`Pane control server failed: ${error.message}`, "error");
			void handle.close().catch((cause: unknown) => ctx.ui.notify(String(cause), "warning"));
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Pane control server has no TCP address");
		const credentialPath = join(directory, "credentials.json");
		writeFileSync(credentialPath, JSON.stringify({ port: address.port, token }), { mode: 0o600, flag: "wx" });
		const invocation = getInternalInvocation("pane-client");
		handshakeTimeout = setTimeout(
			() => connected.reject(new Error("Rex viewer did not connect within 15 seconds")),
			15000,
		);
		await Promise.all([
			openRexPane(location, {
				title: options.title,
				cwd: ctx.cwd,
				command: [invocation.executable, ...invocation.args, credentialPath],
				placement: options.placement ?? "floating",
				minimized: hidden,
			}).then((created) => {
				pane = created;
			}),
			connected.promise,
		]);
		clearTimeout(handshakeTimeout);
		if (stopped) throw new Error("Rex viewer closed during startup");
	} catch (error) {
		await finish();
		if (pane) await closeRexPane(pane, ctx.cwd).catch(() => {});
		throw new RexUnavailableError(error instanceof Error ? error.message : String(error), { cause: error });
	}
	// Construct the view only after the backend is ready: a fallback must not start a second model request.
	try {
		options.signal?.throwIfAborted();
		view = options.create({ invalidate, close: abort, minimize: handle.minimize, setTitle });
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) await handle.close();
		else {
			// Minimized panes still need an initial frame and a live viewer for later restoration.
			if (client) sendPacket(client, { type: "frame", lines: frame(ctx, options, view, width, height) });
		}
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function frame(
	ctx: Pick<ExtensionContext, "ui">,
	options: PaneOptions,
	view: PaneView,
	width: number,
	height: number,
): string[] {
	const title = options.title.replace(/[\x00-\x1f\x7f]/g, " ");
	return [ctx.ui.theme.fg("accent", truncateToWidth(title, width)), ...view.render(width, Math.max(1, height - 1))]
		.slice(0, height)
		.map((line) => truncateToWidth(line, width));
}
