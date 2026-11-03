import { describe, expect, it } from "vitest";
import {
	isMcpServerOverride,
	type McpServerConfigOptions,
	type McpServerConfigResult,
	validateMcpServerConfig,
} from "../src/index.ts";

/** The error of an invalid entry, or the empty string. */
function errorOf(result: McpServerConfigResult): string {
	return result.kind === "invalid" ? result.error : "";
}

describe("validateMcpServerConfig", () => {
	it("accepts stdio and HTTP entries and keeps them as given", () => {
		const stdio = { command: "npx", args: ["-y", "server"], env: { A: "1" }, cwd: "sub", enabled: false };
		expect(validateMcpServerConfig("files", stdio)).toEqual({ kind: "stdio", config: stdio });
		expect(validateMcpServerConfig("files", { type: "stdio", command: "x" }).kind).toBe("stdio");

		const http = {
			url: "https://example.com/mcp",
			headers: { Authorization: "Bearer token" },
			oauth: { clientId: "id", callbackPort: 8080, scope: "read" },
			timeout: 30,
			description: "Docs",
		};
		const result = validateMcpServerConfig("docs", http);
		expect(result).toEqual({ kind: "http", config: http });
		if (result.kind === "http") expect(result.config).toBe(http);
		for (const type of ["http", "streamable-http"]) {
			expect(validateMcpServerConfig("docs", { type, url: "http://localhost:3000/mcp" }).kind).toBe("http");
		}
	});

	it("picks the transport from type, url and command", () => {
		// With both, url wins unless the type says stdio.
		expect(validateMcpServerConfig("s", { url: "https://a.example", command: "x" }).kind).toBe("http");
		expect(validateMcpServerConfig("s", { type: "stdio", url: "https://a.example", command: "x" }).kind).toBe(
			"stdio",
		);
		expect(errorOf(validateMcpServerConfig("s", { type: "http", command: "x" }))).toBe(
			'server "s" needs either "command" (stdio) or "url" (streamable HTTP)',
		);
		expect(errorOf(validateMcpServerConfig("s", { type: "sse", url: "https://a.example/sse" }))).toBe(
			'server "s": legacy SSE transport is not supported; use the streamable HTTP URL',
		);
	});

	it("reports invalid names and fields", () => {
		const cases: [string, unknown, string][] = [
			["bad name", { command: "x" }, 'invalid server name "bad name" (use letters, digits, "_" and "-")'],
			["s", "npx", 'server "s" must be an object'],
			["s", [], 'server "s" must be an object'],
			["s", { command: "x", enabled: "yes" }, 'server "s": enabled must be a boolean'],
			["s", { command: "x", description: 1 }, 'server "s": description must be a string'],
			["s", { command: "x", timeout: 0 }, 'server "s": timeout must be a positive number of seconds'],
			["s", { command: "x", args: "a b" }, 'server "s": args must be an array of strings'],
			["s", { command: "x", env: { A: 1 } }, 'server "s": env must map names to strings'],
			["s", { command: "x", cwd: 1 }, 'server "s": cwd must be a string'],
			["s", { url: "file:///x" }, 'server "s": url must be an http or https URL'],
			["s", { url: "not a url" }, 'server "s": url must be an http or https URL'],
			["s", { url: "https://a.example", headers: { A: 1 } }, 'server "s": headers must map names to strings'],
			["s", {}, 'server "s" needs either "command" (stdio) or "url" (streamable HTTP)'],
		];
		for (const [name, raw, error] of cases) expect(errorOf(validateMcpServerConfig(name, raw))).toBe(error);
	});

	it("checks oauth settings", () => {
		const oauth = (settings: unknown) =>
			errorOf(validateMcpServerConfig("s", { url: "https://a.example", oauth: settings }));
		expect(oauth("x")).toBe('server "s": oauth must be an object');
		expect(oauth({ clientId: 1 })).toBe('server "s": oauth.clientId must be a string');
		expect(oauth({ clientSecret: 1 })).toBe('server "s": oauth.clientSecret must be a string');
		expect(oauth({ callbackPort: 70000 })).toBe('server "s": oauth.callbackPort must be a port number');
		expect(oauth({ callbackUrl: "https://localhost/callback" })).toContain("oauth.callbackUrl must be an http URI");
		expect(oauth({ callbackUrl: "http://example.com/callback" })).toContain("oauth.callbackUrl must be an http URI");
		expect(oauth({ callbackUrl: "http://localhost/callback?x=1" })).toContain(
			"oauth.callbackUrl must be an http URI",
		);
		expect(oauth({ callbackUrl: "http://[::1]:8080/cb", callbackPort: 8080 })).toBe("");
		expect(oauth({ callbackUrl: "http://localhost:8080/cb", callbackPort: 9090 })).toBe(
			'server "s": oauth.callbackUrl and oauth.callbackPort name different ports',
		);
		expect(oauth({ scope: 1 })).toBe('server "s": oauth.scope must be a string');
		expect(oauth({ clientName: " " })).toBe('server "s": oauth.clientName must be a non-empty string');
		expect(oauth({ clientRegistration: "x" })).toBe(
			'server "s": oauth.clientRegistration must be "auto", "dcr", or "cimd"',
		);
		expect(oauth({ clientRegistration: "dcr", clientName: "app" })).toBe("");
		expect(oauth({ authServerMetadataUrl: "http://auth.example/.well-known/x" })).toContain(
			"oauth.authServerMetadataUrl must be an https URL",
		);
		expect(oauth({ authServerMetadataUrl: "http://127.0.0.1/.well-known/x" })).toBe("");
	});

	it("allows cimd only with the application's check of the callback", () => {
		const entry = (oauth: Record<string, unknown>) => ({ url: "https://a.example", oauth });
		expect(errorOf(validateMcpServerConfig("s", entry({ clientRegistration: "cimd" })))).toBe(
			'server "s": oauth.clientRegistration "cimd" is not supported: there are no Client ID Metadata Documents',
		);
		const checked: (string | undefined)[] = [];
		const options: McpServerConfigOptions = {
			checkMetadataDocumentCallback: (callbackUrl) => {
				checked.push(callbackUrl);
				return callbackUrl?.endsWith("/other") ? "the documents do not list it" : undefined;
			},
		};
		expect(validateMcpServerConfig("s", entry({ clientRegistration: "cimd" }), options).kind).toBe("http");
		expect(
			errorOf(
				validateMcpServerConfig(
					"s",
					entry({ clientRegistration: "cimd", callbackUrl: "http://localhost/other" }),
					options,
				),
			),
		).toBe('server "s": the documents do not list it');
		expect(checked).toEqual([undefined, "http://localhost/other"]);
		expect(
			errorOf(validateMcpServerConfig("s", entry({ clientRegistration: "cimd", clientId: "id" }), options)),
		).toBe('server "s": oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName');
	});
});

describe("extending validateMcpServerConfig", () => {
	/** An application's own fields, like p2's `shared` and `runOn`, checked on the result. */
	function validateAppConfig(name: string, raw: unknown): string {
		const result = validateMcpServerConfig(name, raw);
		if (result.kind === "invalid") return result.error;
		const { shared, runOn } = result.config;
		if (shared !== undefined && typeof shared !== "boolean") return `server "${name}": shared must be a boolean`;
		if (result.kind === "http" && runOn !== undefined) return `server "${name}": runOn is for stdio`;
		return `${result.kind} shared=${String(shared)}`;
	}

	it("keeps unknown fields for the caller, after the shared fields are valid", () => {
		expect(validateAppConfig("s", { command: "x", shared: true, runOn: "host" })).toBe("stdio shared=true");
		expect(validateAppConfig("s", { url: "https://a.example", runOn: "host" })).toBe(
			'server "s": runOn is for stdio',
		);
		expect(validateAppConfig("s", { command: "x", shared: 1 })).toBe('server "s": shared must be a boolean');
		// The shared fields are reported first.
		expect(validateAppConfig("s", { command: "x", shared: 1, enabled: "no" })).toBe(
			'server "s": enabled must be a boolean',
		);
	});
});

describe("isMcpServerOverride", () => {
	it("is true for entries without command, url or type", () => {
		expect(isMcpServerOverride({ enabled: false })).toBe(true);
		expect(isMcpServerOverride({})).toBe(true);
		expect(isMcpServerOverride({ command: "x" })).toBe(false);
		expect(isMcpServerOverride({ url: "https://a.example" })).toBe(false);
		expect(isMcpServerOverride({ type: "stdio", enabled: false })).toBe(false);
	});
});
