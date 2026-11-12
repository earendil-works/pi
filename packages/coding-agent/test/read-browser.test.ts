import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getReaderInvocation } from "../src/config.ts";
import { borrowProjectBrowser, closeProjectBrowsers } from "../src/core/readers/browser-client.ts";
import type { ProjectBrowserConnection } from "../src/core/readers/browser-protocol.ts";
import { runReader } from "../src/core/readers/process.ts";

const executablePath =
	process.env.CHROMIUM_BIN ??
	[
		"/Applications/Helium.app/Contents/MacOS/Helium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	].find((path) => existsSync(path));

// Real browser tests use only installed Chromium, temporary Pi profiles, and a loopback HTTP fixture.
describe.skipIf(!executablePath)("persistent Pi-owned project browser", () => {
	let directory: string;
	let project: string;
	let agentDir: string;
	let baseUrl: string;
	const attachments: Browser[] = [];
	const children: ChildProcess[] = [];
	const server = createServer((request, response) => {
		if (request.url === "/slow") return;
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end(
			'<html><head><title>Browser fixture</title></head><body><main><h1>Project state</h1><p id="state">Loading...</p><script>document.getElementById("state").textContent = "Saved cookie: " + document.cookie + "; local state: " + localStorage.getItem("project_state") + ". This is the document rendered by JavaScript in the owned browser.";</script></main></body></html>',
		);
	});

	beforeAll(async () => {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture HTTP address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-project-browser-test-"));
		project = join(directory, "project");
		agentDir = join(directory, "agent");
		await mkdir(project);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) vi.stubEnv(name, "");
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.connected) child.disconnect();
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null) resolve();
				else child.once("exit", () => resolve());
			});
		}
		closeProjectBrowsers();
		await vi.waitFor(
			async () => {
				const root = join(agentDir, "browser");
				const files = existsSync(root) ? await readdir(root, { recursive: true }) : [];
				expect(files.filter((path) => path.endsWith("broker.json"))).toEqual([]);
			},
			{ timeout: 10_000 },
		);
		for (const browser of attachments.splice(0)) await browser.close();
		await rm(directory, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});
	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	async function borrow(cwd = project) {
		return borrowProjectBrowser(cwd, executablePath, new AbortController().signal);
	}
	async function attach(connection: ProjectBrowserConnection) {
		const browser = await chromium.connectOverCDP(connection.endpoint, { noDefaults: true });
		attachments.push(browser);
		return browser;
	}
	async function seedState() {
		const tab = await borrow();
		const browser = await attach(tab.connection);
		const context = browser.contexts()[0];
		await context.addCookies([{ name: "pi_cookie", value: "kept", url: baseUrl, expires: Date.now() / 1000 + 3600 }]);
		const page = context.pages().find((candidate) => candidate.url() === tab.connection.pageUrl)!;
		await page.goto(baseUrl);
		await page.evaluate(() => localStorage.setItem("project_state", "kept"));
		tab.release();
		return browser;
	}

	it("shares one browser across concurrent reads with separately owned tabs", async () => {
		const tabs = await Promise.all([borrow(), borrow(), borrow()]);
		expect(new Set(tabs.map((tab) => tab.connection.endpoint)).size).toBe(1);
		expect(new Set(tabs.map((tab) => tab.connection.pageUrl)).size).toBe(3);
		const browser = await attach(tabs[0].connection);
		const context = browser.contexts()[0];
		expect(context.pages()).toHaveLength(3);
		tabs[0].release();
		await vi.waitFor(() => expect(context.pages()).toHaveLength(2));
		expect(browser.isConnected()).toBe(true);
		for (const tab of tabs.slice(1)) tab.release();
	});

	it("uses JavaScript and retained cookies/storage for successive explicit browser reads", async () => {
		await seedState();
		const result = await runReader("web", {
			path: baseUrl,
			strategy: "browser",
			browserProjectDir: project,
			browserExecutablePath: executablePath,
		});
		expect(result.status).toBe("ok");
		expect(result.text).toContain("cookie=kept");
		expect(result.text).toContain("local state: kept");
	});

	it("persists profile data after all process leases close and the browser restarts", async () => {
		const browser = await seedState();
		closeProjectBrowsers();
		await vi.waitFor(() => expect(browser.isConnected()).toBe(false), { timeout: 10_000 });
		const result = await runReader("web", {
			path: baseUrl,
			strategy: "browser",
			browserProjectDir: project,
			browserExecutablePath: executablePath,
		});
		expect(result.text).toContain("cookie=kept");
		expect(result.text).toContain("local state: kept");
	});

	it("keeps different projects' cookies and local storage separate", async () => {
		await seedState();
		const other = join(directory, "other-project");
		await mkdir(other);
		const result = await runReader("web", {
			path: baseUrl,
			strategy: "browser",
			browserProjectDir: other,
			browserExecutablePath: executablePath,
		});
		expect(result.text).not.toContain("cookie=kept");
		expect(result.text).toContain("local state: null");
	});

	it("closes a cancelled read's tab without killing the shared browser or another tab", async () => {
		const keeper = await borrow();
		const browser = await attach(keeper.connection);
		const controller = new AbortController();
		const pending = runReader(
			"web",
			{
				path: `${baseUrl}/slow`,
				strategy: "browser",
				browserProjectDir: project,
				browserExecutablePath: executablePath,
			},
			controller.signal,
		);
		const rejected = expect(pending).rejects.toThrow(/abort/i);
		await vi.waitFor(() => expect(browser.contexts()[0].pages()).toHaveLength(2));
		controller.abort();
		await rejected;
		await vi.waitFor(() => expect(browser.contexts()[0].pages()).toHaveLength(1));
		expect(browser.isConnected()).toBe(true);
		expect(browser.contexts()[0].pages()[0].url()).toBe(keeper.connection.pageUrl);
		keeper.release();
	});

	it("shares across Pi processes and keeps the browser alive until the last process releases it", async () => {
		const own = await borrow();
		const browser = await attach(own.connection);
		const invocation = getReaderInvocation("web");
		const fixture = fileURLToPath(new URL("./fixtures/project-browser-client.ts", import.meta.url));
		const child = spawn(invocation.executable, [...invocation.args.slice(0, -1), fixture], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
			env: process.env,
		});
		children.push(child);
		const other = new Promise<ProjectBrowserConnection>((resolve, reject) => {
			child.once("error", reject);
			child.once("message", (message: { ok: boolean; connection: ProjectBrowserConnection; error?: string }) => {
				if (!message.ok) reject(new Error(message.error));
				else resolve(message.connection);
			});
		});
		child.send({ cwd: project, executablePath });
		expect((await other).endpoint).toBe(own.connection.endpoint);
		closeProjectBrowsers();
		await vi.waitFor(() => expect(browser.contexts()[0].pages()).toHaveLength(1));
		expect(browser.isConnected()).toBe(true);
		child.disconnect();
		await vi.waitFor(() => expect(browser.isConnected()).toBe(false), { timeout: 10_000 });
	});
});
