// A real browser for the web surface's tests (slice 11 §6): headless Chromium driven over the DevTools protocol (`ws`).
// The binary is `CHROMIUM_BIN`, else `chromium-docker` on the `PATH` (a wrapper running the Playwright image's
// Chromium); without either the browser tests are skipped. Adapted from p2's `test/p2/browser.ts`.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

/** The Chromium binary, or `undefined`. */
export const CHROMIUM = findChromium();

function findChromium(): string | undefined {
	for (const candidate of [process.env.CHROMIUM_BIN, "chromium-docker"]) {
		if (candidate === undefined) continue;
		try {
			execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 120_000 });
			return candidate;
		} catch {
			// Not there.
		}
	}
	return undefined;
}

/** Polls `check` until it is true (`timeoutMs` at most). */
export async function poll(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (await check()) return;
		} catch {
			// Not yet.
		}
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** One headless Chromium with one page. */
export class Browser {
	readonly #process: ChildProcess;
	readonly #profile: string;
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly #loaded = new Set<string>();
	/** Listeners of DevTools events, by method. */
	readonly #listeners = new Map<string, (params: Record<string, unknown>) => void>();
	#id = 0;
	/** The page's console messages. */
	readonly console: string[] = [];

	private constructor(child: ChildProcess, profile: string, socket: WebSocket) {
		this.#process = child;
		this.#profile = profile;
		this.#socket = socket;
		socket.on("message", (raw) => this.#message(JSON.parse(raw.toString())));
	}

	/** Starts Chromium and attaches to its page. */
	static async start(): Promise<Browser> {
		const profile = mkdtempSync(join(tmpdir(), "chord-browser-"));
		const child = spawn(
			CHROMIUM!,
			[
				"--headless=new",
				"--no-sandbox",
				"--no-zygote",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		const portFile = join(profile, "DevToolsActivePort");
		await poll(
			() => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n"),
			60_000,
			"Chromium's port",
		);
		const port = readFileSync(portFile, "utf8").split("\n")[0];
		const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
			readonly type: string;
			readonly webSocketDebuggerUrl: string;
		}[];
		const target = targets.find(({ type }) => type === "page") ?? targets[0]!;
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => {
			socket.once("open", () => resolve());
			socket.once("error", reject);
		});
		const browser = new Browser(child, profile, socket);
		await browser.call("Page.enable");
		await browser.call("Runtime.enable");
		await browser.call("Page.setLifecycleEventsEnabled", { enabled: true });
		return browser;
	}

	/** One DevTools call. */
	call(method: string, params: object = {}): Promise<unknown> {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#socket.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Calls `listener` with the params of each DevTools event `method` (one listener per method; `undefined` removes it). */
	on(method: string, listener: ((params: Record<string, unknown>) => void) | undefined): void {
		if (listener === undefined) this.#listeners.delete(method);
		else this.#listeners.set(method, listener);
	}

	/** The value of `expression` in the page (awaited). */
	async evaluate<T>(expression: string): Promise<T> {
		const answer = (await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
			readonly result: { readonly value: T };
			readonly exceptionDetails?: unknown;
		};
		if (answer.exceptionDetails !== undefined) throw new Error(JSON.stringify(answer.exceptionDetails));
		return answer.result.value;
	}

	/** Waits until `expression` is truthy in the page. */
	wait(expression: string, timeoutMs = 30_000): Promise<void> {
		return poll(() => this.evaluate<boolean>(`Boolean(${expression})`), timeoutMs, expression);
	}

	/** Navigates to `url` and waits for its document. */
	async open(url: string): Promise<void> {
		const result = (await this.call("Page.navigate", { url })) as {
			readonly loaderId?: string;
			readonly errorText?: string;
		};
		if (result.errorText !== undefined) throw new Error(result.errorText);
		if (result.loaderId !== undefined) await poll(() => this.#loaded.has(result.loaderId!), 30_000, "the document");
	}

	/** Types `text` into the focused element. */
	async type(text: string): Promise<void> {
		await this.call("Input.insertText", { text });
	}

	async close(): Promise<void> {
		await this.call("Browser.close").catch(() => {});
		this.#socket.close();
		const exited = (): boolean => this.#process.exitCode !== null || this.#process.signalCode !== null;
		try {
			await poll(exited, 10_000, "Chromium's exit");
		} catch {
			this.#process.kill("SIGTERM");
		}
		rmSync(this.#profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}

	#message(message: {
		readonly id?: number;
		readonly result?: unknown;
		readonly error?: { readonly message: string };
		readonly method?: string;
		readonly params?: {
			readonly name?: string;
			readonly loaderId?: string;
			readonly args?: readonly { readonly value?: unknown }[];
		};
	}): void {
		// An event's params are an object (DevTools protocol); each listener reads the fields of its event.
		if (message.method !== undefined)
			this.#listeners.get(message.method)?.(message.params as Record<string, unknown>);
		if (message.method === "Page.lifecycleEvent" && message.params?.name === "DOMContentLoaded") {
			this.#loaded.add(message.params.loaderId!);
		}
		if (message.method === "Runtime.consoleAPICalled") {
			this.console.push((message.params?.args ?? []).map(({ value }) => String(value)).join(" "));
		}
		if (message.method === "Runtime.exceptionThrown") {
			const details = (
				message.params as { readonly exceptionDetails?: { readonly exception?: { readonly description?: string } } }
			).exceptionDetails;
			this.console.push(`exception: ${details?.exception?.description ?? "unknown"}`);
		}
		if (message.id === undefined) return;
		const waiting = this.#pending.get(message.id);
		this.#pending.delete(message.id);
		if (message.error !== undefined) waiting?.reject(new Error(message.error.message));
		else waiting?.resolve(message.result);
	}
}
