import { describe, expect, it } from "vitest";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";
import { isWSL2 } from "../src/utils/wsl.ts";

const USER_AGENT_FORMAT = /^pi\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/;
const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;

describe("getPiUserAgent", () => {
	it("formats the user agent expected by pi.dev", () => {
		const userAgent = getPiUserAgent("1.2.3", false);

		expect(userAgent).toBe(`pi/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(USER_AGENT_FORMAT);
	});

	it("reports linux/wsl2 as the platform on WSL2", () => {
		const userAgent = getPiUserAgent("1.2.3", true);

		expect(userAgent).toBe(`pi/1.2.3 (linux/wsl2; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(USER_AGENT_FORMAT);
	});
});

describe("isWSL2", () => {
	it("detects the WSL2 kernel", () => {
		expect(isWSL2("linux", "5.15.167.4-microsoft-standard-WSL2")).toBe(true);
		expect(isWSL2("linux", "6.6.36.3-microsoft-standard-WSL2+")).toBe(true);
	});

	it("rejects WSL1, plain Linux, and other platforms", () => {
		expect(isWSL2("linux", "4.4.0-19041-Microsoft")).toBe(false);
		expect(isWSL2("linux", "6.8.0-45-generic")).toBe(false);
		expect(isWSL2("win32", "10.0.22631")).toBe(false);
	});
});
