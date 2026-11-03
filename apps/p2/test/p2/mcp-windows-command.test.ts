// How a stdio MCP server starts on a Windows environment (plugins/mcp/windows-command.ts): `.exe` and `.com` directly,
// everything else through `cmd.exe` with the command line in a variable, quoted as cross-spawn quotes it (the expected
// lines below are cross-spawn's `lib/util/escape.js` output for the same values).
import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsCommand } from "../../plugins/mcp/windows-command.ts";

const CMD = ["cmd.exe", "/d", "/s", "/c", "%P2_MCP_COMMAND%"];

test("an .exe or .com program starts directly, its arguments as they are", () => {
	assert.deepEqual(windowsCommand("C:\\tools\\server.exe", ["a b", '"q"']), {
		argv: ["C:\\tools\\server.exe", "a b", '"q"'],
		env: {},
	});
	assert.deepEqual(windowsCommand("C:\\TOOLS\\SERVER.COM", []), { argv: ["C:\\TOOLS\\SERVER.COM"], env: {} });
});

test("any other command runs through cmd.exe, the line in P2_MCP_COMMAND quoted as cross-spawn quotes it", () => {
	const { argv, env } = windowsCommand("npx", [
		"plain",
		"a b",
		'say "hi"',
		"C:\\dir\\",
		'tail\\"q',
		"100%",
		"a&b|c",
		"^",
	]);
	assert.deepEqual(argv, CMD);
	assert.equal(
		env.P2_MCP_COMMAND,
		[
			"npx",
			'^"plain^"',
			'^"a^ b^"',
			'^"say^ \\^"hi\\^"^"',
			'^"C:\\dir\\\\^"',
			'^"tail\\\\\\^"q^"',
			'^"100^%^"',
			'^"a^&b^|c^"',
			'^"^^^"',
		].join(" "),
	);
});

test("the program's path is normalized and its meta characters escaped", () => {
	const { env } = windowsCommand("C:/Program Files (x86)/tool.cmd", []);
	assert.equal(env.P2_MCP_COMMAND, "C:\\Program^ Files^ ^(x86^)\\tool.cmd");
});

test("a cmd-shim in node_modules\\.bin gets its arguments escaped twice (it parses them through cmd.exe again)", () => {
	const { argv, env } = windowsCommand("C:\\work\\node_modules\\.bin\\server.cmd", ["a b", "100%"]);
	assert.deepEqual(argv, CMD);
	assert.equal(env.P2_MCP_COMMAND, 'C:\\work\\node_modules\\.bin\\server.cmd ^^^"a^^^ b^^^" ^^^"100^^^%^^^"');
});
