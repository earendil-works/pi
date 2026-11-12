import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchProjectBrowser } from "../src/core/readers/browser-launch.ts";

vi.mock("node:fs/promises", () => ({ access: vi.fn(), readFile: vi.fn() }));

const profile = join(tmpdir(), "pi-owned-test-profile");
const executable = join(tmpdir(), "trusted-chromium");
const close = vi.fn(async () => {});
const context = { pages: () => [], close } as unknown as BrowserContext;

beforeEach(() => {
	close.mockClear();
	vi.mocked(access).mockReset().mockResolvedValue(undefined);
	vi.mocked(readFile).mockReset().mockResolvedValue("9222\n/devtools/browser/fixture\n");
	vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
	for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) vi.stubEnv(name, "");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("Pi-owned persistent browser launch", () => {
	it("uses only the owned profile, keeps sandboxing on, and blocks downloads and service workers", async () => {
		const result = await launchProjectBrowser(profile, executable);
		expect(chromium.launchPersistentContext).toHaveBeenCalledExactlyOnceWith(profile, {
			executablePath: executable,
			headless: true,
			chromiumSandbox: true,
			acceptDownloads: false,
			serviceWorkers: "block",
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false,
			args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
			timeout: 15_000,
		});
		expect(result.endpoint).toBe("ws://127.0.0.1:9222/devtools/browser/fixture");
		expect(result.context).toBe(context);
	});

	it.each(["0\n/devtools/browser/fixture", "65536\n/devtools/browser/fixture", "9222\nhttps://external.example/"])(
		"rejects invalid browser discovery without attaching elsewhere: %s",
		async (discovery) => {
			vi.mocked(readFile).mockResolvedValueOnce(discovery);
			await expect(launchProjectBrowser(profile, executable)).rejects.toThrow("invalid debugging endpoint");
			expect(close).toHaveBeenCalledOnce();
		},
	);

	it("does not launch an unrelated browser when an explicit executable is unavailable", async () => {
		vi.mocked(access).mockRejectedValueOnce(new Error("Executable unavailable"));
		await expect(launchProjectBrowser(profile, executable)).rejects.toThrow("Executable unavailable");
		expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
	});

	it("honors the inherited proxy without writing credentials into the browser profile path", async () => {
		vi.stubEnv("HTTPS_PROXY", "http://fixture-user:fixture-pass@proxy.example:8080");
		vi.stubEnv("NO_PROXY", "localhost,127.0.0.1");
		await launchProjectBrowser(profile, executable);
		expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
			profile,
			expect.objectContaining({
				proxy: {
					server: "http://proxy.example:8080",
					username: "fixture-user",
					password: "fixture-pass",
					bypass: "localhost,127.0.0.1",
				},
			}),
		);
	});
});
