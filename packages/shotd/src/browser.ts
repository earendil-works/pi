// Browser manager: one warm Chromium over CDP. Never one browser per call.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { ARCHIVE_HEIGHT, ARCHIVE_WIDTH, DSF, VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from "./image.ts";

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message: string };
}

export interface CaptureOptions {
	url: string;
	selector?: string;
	provide?: string; // agent id for isolated context
	viewport?: { width: number; height: number };
	clip?: { x: number; y: number; width: number; height: number };
	settleMs?: number;
}

export interface CaptureResult {
	png: Buffer;
	width: number;
	height: number;
	sha256: string;
}

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

function findChrome(): string | undefined {
	for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
	const env = process.env.CHROMIUM_BIN ?? process.env.CHROME_BIN;
	return env && existsSync(env) ? env : undefined;
}

export interface DomMetric {
	selector: string;
	found: boolean;
	rect: {
		x: number;
		y: number;
		width: number;
		height: number;
		top: number;
		left: number;
		right: number;
		bottom: number;
	} | null;
	style: Record<string, string> | null;
}

export class BrowserManager {
	private proc: ReturnType<typeof spawn> | null = null;
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
	private wsUrl = "";
	readonly contexts = new Map<string, string>();
	readonly contextTargets = new Map<string, string>();
	private port = 0;

	async ensure(): Promise<void> {
		if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
		const chrome = findChrome();
		if (!chrome) throw new Error("shotd: no Chromium/Chrome found (set CHROMIUM_BIN)");
		const port = 9222 + Math.floor(Math.random() * 500);
		this.port = port;
		this.proc = spawn(
			chrome,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-sandbox",
				"--remote-debugging-port=" + port,
				"--user-data-dir=/tmp/shotd-" + port,
				"--force-prefers-reduced-motion",
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			},
		);
		// Poll /json/version.
		for (let i = 0; i < 40; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/json/version`);
				const data = (await res.json()) as { webSocketDebuggerUrl?: string };
				if (data.webSocketDebuggerUrl) {
					this.wsUrl = data.webSocketDebuggerUrl;
					break;
				}
			} catch {
				/* retry */
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		if (!this.wsUrl) throw new Error("shotd: Chrome DevTools not ready");
		await this.connect();
		await this.send("Target.createTarget", { url: "about:blank" });
	}

	private connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.wsUrl);
			this.ws = ws;
			ws.addEventListener("open", () => resolve());
			ws.addEventListener("error", () => reject(new Error("shotd CDP connect failed")));
			ws.addEventListener("message", (ev: MessageEvent) => {
				try {
					const msg = JSON.parse(String(ev.data)) as CdpMessage;
					if (msg.id !== undefined && this.pending.has(msg.id)) {
						const p = this.pending.get(msg.id)!;
						this.pending.delete(msg.id);
						if (msg.error) p.reject(new Error(msg.error.message));
						else p.resolve(msg.result ?? {});
					}
				} catch {
					/* ignore */
				}
			});
		});
	}

	private send(
		method: string,
		params: Record<string, unknown> = {},
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		if (!this.ws) throw new Error("shotd: CDP not connected");
		const id = this.nextId++;
		// Flattened CDP: sessionId is a top-level sibling (not inside params).
		const payload: Record<string, unknown> = { id, method, params };
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws!.send(JSON.stringify(payload));
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`shotd CDP timeout ${method}`));
				}
			}, 30_000);
		});
	}

	async openContext(agentId: string): Promise<void> {
		await this.ensure();
		if (this.contexts.has(agentId)) return;
		const target = await this.send("Target.createTarget", { url: "about:blank" });
		const targetId = target.targetId as string;
		const attached = await this.send("Target.attachToTarget", { targetId, flatten: true });
		this.contexts.set(agentId, String(attached.sessionId ?? ""));
		this.contextTargets.set(agentId, targetId);
	}

	async closeContext(agentId: string): Promise<void> {
		const targetId = this.contextTargets.get(agentId);
		this.contextTargets.delete(agentId);
		this.contexts.delete(agentId);
		if (targetId) await this.send("Target.closeTarget", { targetId }).catch(() => undefined);
	}

	async domMetrics(url: string, selectors: string[], agentId = "default"): Promise<DomMetric[]> {
		const target = await this.send("Target.createTarget", { url: "about:blank" });
		const targetId = target.targetId as string;
		const attached = await this.send("Target.attachToTarget", { targetId, flatten: true });
		const sessionId = String(attached.sessionId ?? "");
		await this.send("Page.enable", {}, sessionId);
		await this.send("Runtime.enable", {}, sessionId);
		await this.send("Page.navigate", { url }, sessionId);
		try {
			await this.send(
				"Runtime.evaluate",
				{ expression: "document.fonts.ready.then(()=>true)", awaitPromise: true },
				sessionId,
			);
		} catch {
			/* ignore */
		}
		await new Promise((r) => setTimeout(r, 500));
		const expression = `(() => {
			const out = [];
			for (const sel of ${JSON.stringify(selectors)}) {
				const el = document.querySelector(sel);
				if (!el) { out.push({ selector: sel, found: false, rect: null, style: null }); continue; }
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				out.push({ selector: sel, found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom }, style: { display: cs.display, position: cs.position, width: cs.width, height: cs.height, fontSize: cs.fontSize, color: cs.color, backgroundColor: cs.backgroundColor } });
			}
			return JSON.stringify(out);
		})()`;
		const evaluated = await this.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
		const result = (evaluated.result as { value?: string } | undefined)?.value;
		await this.send("Target.closeTarget", { targetId }).catch(() => undefined);
		if (!result) throw new Error("shotd dom_metrics returned no data");
		return JSON.parse(result) as DomMetric[];
	}

	async capture(opts: CaptureOptions): Promise<CaptureResult> {
		await this.openContext(opts.provide ?? "default");
		const viewport = opts.viewport ?? { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };
		// New page per capture inside warm browser (never new browser).
		const target = await this.send("Target.createTarget", { url: "about:blank" });
		const targetId = target.targetId as string;
		const attached = await this.send("Target.attachToTarget", { targetId, flatten: true });
		const sessionId = String(attached.sessionId ?? "");
		await this.send(
			"Emulation.setDeviceMetricsOverride",
			{ width: viewport.width, height: viewport.height, deviceScaleFactor: DSF, mobile: false },
			sessionId,
		);
		await this.send("Page.enable", {}, sessionId);
		await this.send("Runtime.enable", {}, sessionId);
		// Disable animations for determinism.
		await this.send(
			"Emulation.setEmulatedMedia",
			{ features: [{ name: "prefers-reduced-motion", value: "reduce" }] },
			sessionId,
		);
		await this.send("Page.navigate", { url: opts.url }, sessionId);
		// Settle: fonts + network idle fallback + selector.
		try {
			await this.send(
				"Runtime.evaluate",
				{ expression: "document.fonts.ready.then(()=>true)", awaitPromise: true },
				sessionId,
			);
		} catch {
			/* settle best-effort */
		}
		if (opts.selector) {
			try {
				await new Promise((resolve) => setTimeout(resolve, 300));
				await this.send(
					"Runtime.evaluate",
					{ expression: `document.querySelector(${JSON.stringify(opts.selector)}) !== null`, awaitPromise: false },
					sessionId,
				);
			} catch {
				/* ignore */
			}
		}
		const settleMs = opts.settleMs ?? 800;
		await new Promise((r) => setTimeout(r, settleMs));
		const clip = opts.clip ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
		const shot = await this.send(
			"Page.captureScreenshot",
			{
				format: "png",
				captureBeyondViewport: false,
				clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: DSF },
			},
			sessionId,
		);
		const data = shot.data as string | undefined;
		if (!data) throw new Error("shotd: capture returned no data");
		const png = Buffer.from(data, "base64");
		await this.send("Target.closeTarget", { targetId }).catch(() => undefined);
		const sha = createHash("sha256").update(png).digest("hex");
		return { png, width: ARCHIVE_WIDTH, height: ARCHIVE_HEIGHT, sha256: sha };
	}

	async dispose(): Promise<void> {
		try {
			this.ws?.close();
		} catch {
			/* noop */
		}
		try {
			this.proc?.kill("SIGTERM");
		} catch {
			/* noop */
		}
		this.ws = null;
		this.proc = null;
	}
}
