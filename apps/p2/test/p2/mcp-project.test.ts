// A project's `.pi/mcp.json` checked against the owner's servers (plugins/mcp/project.ts): what it may add (stdio
// servers at its location), what it may change (`enabled` of the owner's servers), and each rule that refuses the rest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOwnerConfig } from "../../plugins/mcp/config.ts";
import { parseProjectConfig } from "../../plugins/mcp/project.ts";

const OWNER = parseOwnerConfig(
	JSON.stringify({
		mcpServers: {
			files: { command: "files-server" },
			off: { command: "off-server", enabled: false },
			"my-docs": { url: "https://example.com/mcp" },
		},
	}),
);

const project = (servers: Record<string, unknown>) =>
	parseProjectConfig(JSON.stringify({ mcpServers: servers }), OWNER);

test("a project adds stdio servers and sets enabled of the owner's; host variables stay as written", () => {
	const config = project({
		lint: { command: "lint-server", args: ["--fix"], env: { TOKEN: `\${SECRET}` } },
		later: { command: "later-server", enabled: false },
		files: { enabled: false },
		off: { enabled: true },
		"my-docs": {},
	});
	assert.deepEqual(config.errors, []);
	assert.deepEqual(
		config.servers.map((server) => [server.name, server.config.command, server.config.args, server.config.env]),
		[["lint", "lint-server", ["--fix"], { TOKEN: `\${SECRET}` }]],
	);
	// An entry without `enabled` is an override that changes nothing.
	assert.deepEqual(
		[...config.enabled],
		[
			["files", false],
			["off", true],
		],
	);
});

test("each rule refuses what it should, naming the server and why; the other entries still count", () => {
	const config = project({
		remote: { url: "https://example.com/mcp" },
		placed: { command: "x", runOn: "host" },
		everywhere: { command: "x", shared: true },
		signed: { command: "x", oauth: { clientId: "c" } },
		provided: { command: "x", auth: { provider: "radius" } },
		files: { command: "other-files" },
		off: { enabled: true, args: ["x"] },
		"my-docs": { enabled: "yes" },
		ghost: { enabled: true },
		my_docs: { command: "x" },
		"bad name!": { command: "x" },
		kept: { command: "kept-server" },
	});
	assert.deepEqual(
		config.servers.map((server) => server.name),
		["kept"],
	);
	const errors = config.errors.join("\n");
	assert.equal(config.errors.length, 11, errors);
	for (const error of config.errors) assert.match(error, /^\.pi\/mcp\.json: /);
	assert.match(errors, /server "remote": HTTP servers are for the owner's mcp\.json/);
	assert.match(errors, /server "placed": "runOn" is for the owner's mcp\.json/);
	assert.match(errors, /server "everywhere": "shared" is for the owner's mcp\.json/);
	assert.match(errors, /server "signed": "oauth" is for the owner's mcp\.json/);
	assert.match(errors, /server "provided": "auth" is for the owner's mcp\.json/);
	assert.match(errors, /server "files": the owner's mcp\.json defines it/);
	assert.match(errors, /server "off": an override can only set "enabled"/);
	assert.match(errors, /server "my-docs": enabled must be a boolean/);
	assert.match(errors, /server "ghost": needs "command", or a server of the owner's mcp\.json to override/);
	assert.match(errors, /server "my_docs": its tools would be named like those of "my-docs"/);
	assert.match(errors, /invalid server name/);
	assert.deepEqual([...config.enabled], []);
});

test("a file that is no configuration is one error, and nothing else", () => {
	for (const [text, why] of [
		["{", /Invalid \.pi\/mcp\.json syntax/],
		["[]", /\.pi\/mcp\.json must be an object/],
		['{ "mcpServers": [] }', /"mcpServers" must be an object/],
	] as const) {
		const config = parseProjectConfig(text, OWNER);
		assert.deepEqual([config.servers, [...config.enabled]], [[], []]);
		assert.equal(config.errors.length, 1);
		assert.match(config.errors[0]!, why);
	}
	// Comments are allowed, as in the owner's file.
	assert.deepEqual(parseProjectConfig('{ // none\n "mcpServers": {} }', OWNER).errors, []);
});
