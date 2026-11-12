import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serveProjectBrowser } from "../src/core/readers/browser-broker.ts";
import { launchProjectBrowser } from "../src/core/readers/browser-launch.ts";
import {
	MAX_BROWSER_MESSAGE_BYTES,
	type ProjectBrowserMetadata,
	type ProjectBrowserResponse,
} from "../src/core/readers/browser-protocol.ts";

vi.mock("../src/core/readers/browser-launch.ts", () => ({ launchProjectBrowser: vi.fn() }));

class FakePage extends EventEmitter {
	goto = vi.fn(async (_url: string) => {});
	route = vi.fn(async (_pattern: string, _handler: unknown) => {});
	close = vi.fn(async () => {});
}

describe("project browser broker leases", () => {
	let directory: string;
	let broker: Awaited<ReturnType<typeof serveProjectBrowser>>;
	let context: EventEmitter & {
		newPage: ReturnType<typeof vi.fn<() => Promise<Page>>>;
		close: ReturnType<typeof vi.fn<() => Promise<void>>>;
	};
	let stopped: ReturnType<typeof vi.fn<() => void>>;
	const pages: FakePage[] = [];
	const sockets = new Set<Socket>();

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-browser-broker-"));
		pages.length = 0;
		context = Object.assign(new EventEmitter(), {
			newPage: vi.fn(async () => {
				const page = new FakePage();
				pages.push(page);
				return page as unknown as Page;
			}),
			close: vi.fn(async () => {
				context.emit("close");
			}),
		});
		vi.mocked(launchProjectBrowser)
			.mockReset()
			.mockResolvedValue({
				context: context as unknown as BrowserContext,
				endpoint: "ws://127.0.0.1:1234/devtools/browser/fixture",
			});
		stopped = vi.fn();
		broker = await serveProjectBrowser({ profileDir: directory, settingsKey: "settings" }, stopped);
	});
	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		await broker.close();
		await rm(directory, { recursive: true, force: true });
	});

	function request(
		action: "lease" | "page",
		metadata: ProjectBrowserMetadata = broker.metadata,
		settingsKey = "settings",
	) {
		const socket = createConnection({ host: "127.0.0.1", port: metadata.port });
		sockets.add(socket);
		const response = new Promise<ProjectBrowserResponse>((resolve, reject) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("error", reject);
			socket.once("close", () => reject(new Error("closed")));
			socket.on("data", (data: string) => {
				buffer += data;
				if (buffer.includes("\n")) resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
			});
			socket.once("connect", () =>
				socket.write(`${JSON.stringify({ token: metadata.token, settingsKey, action })}\n`),
			);
		});
		return { socket, response };
	}

	it("authenticates before starting a browser", async () => {
		const invalid = request("lease", { ...broker.metadata, token: "0".repeat(64) });
		expect(await invalid.response).toEqual({ ok: false, error: "Project browser authentication failed" });
		expect(launchProjectBrowser).not.toHaveBeenCalled();
	});

	it("rejects conflicting settings without changing the existing browser", async () => {
		const keeper = request("lease");
		expect(await keeper.response).toMatchObject({ ok: true });
		const other = request("lease", broker.metadata, "different-settings");
		expect(await other.response).toMatchObject({
			ok: false,
			error: expect.stringContaining("different browser/proxy settings"),
		});
		expect(launchProjectBrowser).toHaveBeenCalledOnce();
		expect(context.close).not.toHaveBeenCalled();
	});

	it("shares a single launch and closes only the released connection's page", async () => {
		const keeper = request("lease");
		const first = request("page");
		const second = request("page");
		const replies = await Promise.all([keeper.response, first.response, second.response]);
		expect(replies.every((reply) => reply.ok)).toBe(true);
		expect(launchProjectBrowser).toHaveBeenCalledOnce();
		expect(pages).toHaveLength(2);
		first.socket.destroy();
		await vi.waitFor(() => expect(pages[0].close).toHaveBeenCalledOnce());
		expect(pages[1].close).not.toHaveBeenCalled();
		expect(context.close).not.toHaveBeenCalled();
	});

	it("installs network restrictions on the owning connection before handing off a tab", async () => {
		const page = request("page");
		expect(await page.response).toMatchObject({ ok: true, pageUrl: expect.stringContaining("about:blank#pi-") });
		expect(pages[0].route).toHaveBeenCalledWith("**/*", expect.any(Function));
		expect(pages[0].route.mock.invocationCallOrder[0]).toBeLessThan(pages[0].goto.mock.invocationCallOrder[0]);
	});

	it("closes a tab created after its borrowing client has already disconnected", async () => {
		const keeper = request("lease");
		await keeper.response;
		const created = Promise.withResolvers<Page>();
		context.newPage.mockReturnValueOnce(created.promise);
		const pending = request("page");
		const closed = expect(pending.response).rejects.toThrow("closed");
		await vi.waitFor(() => expect(context.newPage).toHaveBeenCalledOnce());
		pending.socket.destroy();
		await closed;
		const late = new FakePage();
		created.resolve(late as unknown as Page);
		await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
		expect(context.close).not.toHaveBeenCalled();
	});

	it("does not keep the browser running after the last lease is released", async () => {
		const owner = request("lease");
		await owner.response;
		owner.socket.destroy();
		await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
		expect(context.close).toHaveBeenCalledOnce();
	});

	it("bounds unauthenticated messages without starting a browser", async () => {
		const socket = createConnection({ host: "127.0.0.1", port: broker.metadata.port });
		sockets.add(socket);
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		socket.on("error", () => {});
		socket.once("connect", () => socket.write("x".repeat(MAX_BROWSER_MESSAGE_BYTES + 1)));
		await closed;
		expect(launchProjectBrowser).not.toHaveBeenCalled();
	});

	it("returns launch errors rather than falling back to a personal browser", async () => {
		vi.mocked(launchProjectBrowser).mockRejectedValueOnce(new Error("Installed browser unavailable"));
		expect(await request("lease").response).toEqual({ ok: false, error: "Installed browser unavailable" });
		expect(launchProjectBrowser).toHaveBeenCalledOnce();
	});
});
