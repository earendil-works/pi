// A headless Chromium for the page's browser tests, driven over the DevTools protocol: `CHROMIUM_BIN` (on slayer the
// Playwright image's Chromium through `chromium-docker`). Browser tests run only when asked (`P3_BROWSER_TESTS=1`
// with `CHROMIUM_BIN`), never in a plain `npm test`. One page per
// browser: open a URL, size the viewport (a phone with touch, or a desktop), wait for an expression, click and type as
// a person would (real input events), take screenshots. The page's console and uncaught errors are kept.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually } from "../../../test/until.ts";

/** The Chromium binary the tests use, or `undefined`. */
export const CHROMIUM = process.env.CHROMIUM_BIN;

/** Why the browser tests are skipped, or `false` when they were asked for and have a Chromium. */
export const BROWSER_SKIP =
	process.env.P3_BROWSER_TESTS !== "1"
		? "browser tests run only when asked (P3_BROWSER_TESTS=1)"
		: CHROMIUM === undefined
			? "no CHROMIUM_BIN"
			: false;

/** A viewport: a phone (390x844, touch) or a desktop (1280x900). */
export type Viewport = { readonly width: number; readonly height: number; readonly phone: boolean };

/** The phone's viewport. */
export const PHONE: Viewport = { width: 390, height: 844, phone: true };

/** The desktop's viewport. */
export const DESKTOP: Viewport = { width: 1280, height: 900, phone: false };

/** One headless Chromium with one page. */
export class Browser {
	readonly #child: ChildProcess;
	readonly #profile: string;
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly #loaded = new Set<string>();
	#next = 0;
	/** What the page logged, and its uncaught errors, in order. */
	readonly console: string[] = [];

	private constructor(child: ChildProcess, profile: string, socket: WebSocket) {
		this.#child = child;
		this.#profile = profile;
		this.#socket = socket;
		socket.addEventListener("message", (event) => this.#received(JSON.parse(String(event.data)) as Message));
	}

	/** Starts Chromium (`CHROMIUM`) with a fresh profile and attaches to its page. */
	static async start(): Promise<Browser> {
		if (CHROMIUM === undefined) throw new Error("Browser: no CHROMIUM_BIN");
		const profile = await mkdtemp(join(tmpdir(), "p3-browser-"));
		const child = spawn(
			CHROMIUM,
			[
				"--headless=new",
				"--no-sandbox",
				"--no-zygote",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--hide-scrollbars",
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		try {
			const portFile = join(profile, "DevToolsActivePort");
			// Chromium writes the file in two steps: the port is there once its second line is.
			const lines = await eventually(
				async () => (await readFile(portFile, "utf8")).split("\n"),
				(read) => read.length > 1,
				60_000,
			);
			const port = lines[0];
			const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as readonly {
				readonly type: string;
				readonly webSocketDebuggerUrl: string;
			}[];
			const target = targets.find(({ type }) => type === "page") ?? targets[0];
			if (target === undefined) throw new Error("Browser: Chromium has no page");
			const socket = new WebSocket(target.webSocketDebuggerUrl);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("Browser: no DevTools socket")), { once: true });
			});
			const browser = new Browser(child, profile, socket);
			await browser.call("Page.enable");
			await browser.call("Runtime.enable");
			await browser.call("Page.setLifecycleEventsEnabled", { enabled: true });
			return browser;
		} catch (error) {
			child.kill("SIGKILL");
			await rm(profile, { recursive: true, force: true });
			throw error;
		}
	}

	/** One DevTools command. */
	call(method: string, params: object = {}): Promise<unknown> {
		const id = ++this.#next;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Signs the browser in for `origin` with `cookie` (`name=value`, as `testServer`'s `cookie` gives it). */
	async signIn(origin: string, cookie: string): Promise<void> {
		const at = cookie.indexOf("=");
		await this.call("Network.setCookie", {
			name: cookie.slice(0, at),
			value: cookie.slice(at + 1),
			url: `${origin}/`,
			httpOnly: true,
			sameSite: "Lax",
		});
	}

	/** Forgets every sign-in (the browser's cookies). */
	async signOut(): Promise<void> {
		await this.call("Network.clearBrowserCookies");
	}

	/** Sizes the page as `viewport` (a phone with touch emulated). */
	async size(viewport: Viewport): Promise<void> {
		await this.call("Emulation.setDeviceMetricsOverride", {
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: 1,
			mobile: viewport.phone,
		});
		await this.call("Emulation.setTouchEmulationEnabled", { enabled: viewport.phone });
	}

	/** Makes the page see the system's colour scheme as `scheme`. */
	async colorScheme(scheme: "light" | "dark"): Promise<void> {
		await this.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
	}

	/** Navigates to `url` and waits for its document. */
	async open(url: string): Promise<void> {
		const result = (await this.call("Page.navigate", { url })) as { loaderId?: string; errorText?: string };
		if (result.errorText !== undefined) throw new Error(`Browser: ${url}: ${result.errorText}`);
		const loader = result.loaderId;
		if (loader !== undefined)
			await eventually(
				() => this.#loaded.has(loader),
				(loaded) => loaded,
				30_000,
			);
	}

	/** The value of `expression` in the page (awaited). */
	async evaluate<T>(expression: string): Promise<T> {
		const answer = (await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
			readonly result: { readonly value: T };
			readonly exceptionDetails?: { readonly exception?: { readonly description?: string } };
		};
		if (answer.exceptionDetails !== undefined) {
			throw new Error(`Browser: ${answer.exceptionDetails.exception?.description ?? expression}`);
		}
		return answer.result.value;
	}

	/** Waits until `expression` is truthy in the page; the failure names it and the page's console. */
	async wait(expression: string, timeoutMs = 20_000): Promise<void> {
		try {
			await eventually(
				() => this.evaluate<boolean>(`Boolean(${expression})`),
				(passed) => passed,
				timeoutMs,
			);
		} catch (error) {
			throw new Error(
				`waiting for ${expression}: ${(error as Error).message}\nconsole:\n${this.console.join("\n")}`,
			);
		}
	}

	/** The text of the first element `selector` matches (`""` when none). */
	text(selector: string): Promise<string> {
		return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
	}

	/** Clicks the first element `selector` matches at its centre, as a mouse would, once it is visible and on top. */
	async click(selector: string): Promise<void> {
		const at = JSON.stringify(selector);
		await this.wait(
			`(() => { const e = document.querySelector(${at}); if (e === null || e.disabled) return false;` +
				" const r = e.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false;" +
				" const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);" +
				" return hit !== null && (e === hit || e.contains(hit)); })()",
		);
		const { x, y } = await this.evaluate<{ x: number; y: number }>(
			`(() => { const r = document.querySelector(${at}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
			await this.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: 1, clickCount: 1 });
		}
	}

	/** Focuses the first element `selector` matches and types `text` into it. */
	async type(selector: string, text: string): Promise<void> {
		await this.click(selector);
		await this.call("Input.insertText", { text });
	}

	/** Presses Enter in the focused element. */
	async enter(): Promise<void> {
		const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
		await this.call("Input.dispatchKeyEvent", { type: "keyDown", ...key });
		await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...key });
	}

	/**
	 * Waits until the first element `selector` matches has finished appearing (no animation or transition runs on it
	 * or inside it, and it is fully opaque), then checks that it is on top: the element at its centre is it or inside it.
	 */
	async settled(selector: string): Promise<void> {
		const at = JSON.stringify(selector);
		await this.wait(
			`(() => { const e = document.querySelector(${at}); return e !== null && e.getAnimations({ subtree: true }).length === 0` +
				` && getComputedStyle(e).opacity === "1"; })()`,
		);
		const onTop = await this.evaluate<boolean>(
			`(() => { const e = document.querySelector(${at}); const r = e.getBoundingClientRect();` +
				" const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);" +
				" return hit !== null && (e === hit || e.contains(hit)); })()",
		);
		if (!onTop) throw new Error(`Browser: ${selector} is not on top`);
	}

	/** Saves a screenshot of the viewport as a PNG at `path`. */
	async screenshot(path: string): Promise<void> {
		const { data } = (await this.call("Page.captureScreenshot", { format: "png" })) as { readonly data: string };
		await writeFile(path, Buffer.from(data, "base64"));
	}

	/** Closes Chromium and removes its profile. */
	async close(): Promise<void> {
		await this.call("Browser.close").catch(() => {});
		this.#socket.close();
		const exited = () => this.#child.exitCode !== null || this.#child.signalCode !== null;
		await eventually(exited, (done) => done, 10_000).catch(() => this.#child.kill("SIGKILL"));
		await rm(this.#profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}

	/** A DevTools message: an answer to a command, or an event. */
	#received(message: Message): void {
		if (message.method === "Page.lifecycleEvent" && message.params?.name === "DOMContentLoaded") {
			if (message.params.loaderId !== undefined) this.#loaded.add(message.params.loaderId);
		}
		if (message.method === "Runtime.consoleAPICalled") {
			this.console.push((message.params?.args ?? []).map((arg) => String(arg.value ?? arg.description)).join(" "));
		}
		if (message.method === "Runtime.exceptionThrown") {
			this.console.push(`uncaught: ${message.params?.exceptionDetails?.exception?.description ?? "?"}`);
		}
		if (message.id === undefined) return;
		const waiting = this.#pending.get(message.id);
		this.#pending.delete(message.id);
		if (message.error !== undefined) waiting?.reject(new Error(`DevTools: ${message.error.message}`));
		else waiting?.resolve(message.result);
	}
}

/** What DevTools sends (a trust boundary of the test's own: only the fields read here). */
type Message = {
	readonly id?: number;
	readonly result?: unknown;
	readonly error?: { readonly message: string };
	readonly method?: string;
	readonly params?: {
		readonly name?: string;
		readonly loaderId?: string;
		readonly args?: readonly { readonly value?: unknown; readonly description?: string }[];
		readonly exceptionDetails?: { readonly exception?: { readonly description?: string } };
	};
};
