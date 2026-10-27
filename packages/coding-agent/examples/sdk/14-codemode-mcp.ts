/**
 * Codemode, Tool Search, and MCP
 *
 * The CLI loads `codemode`, `tool_search`, and MCP as built-in extensions. SDK sessions add
 * them to the resource loader's extension factories.
 *
 * `codemode` and `tool_search` are registered inactive. Enable them through the `defaultTools` setting
 * (`tools` would also restrict the session to the named tools, which hides MCP tools), or let the
 * MCP extension activate them: `codemode` for servers with `codemode` exposure, `tool_search` for
 * servers with `deferred` exposure.
 */

import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();

const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir: getAgentDir(),
	extensionFactories: [
		createCodemodeExtension({ mode: "on" }),
		createToolSearchExtension(),
		// Reads mcp.json from the agent directory and the trusted project, like the CLI.
		createMcpExtension(),
	],
});
await resourceLoader.reload();

const settingsManager = SettingsManager.create(cwd);
// `+name` adds to the configured default tools instead of replacing them.
settingsManager.applyOverrides({ defaultTools: ["+codemode", "+tool_search"] });

const { session } = await createAgentSession({
	resourceLoader,
	settingsManager,
	sessionManager: SessionManager.inMemory(),
});

try {
	// Emits session_start, which connects the MCP servers in the background.
	await session.bindExtensions({});
	console.log("Active tools:", session.getActiveToolNames().join(", "));
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});
	await session.prompt("Use codemode to count the TypeScript files in src/ and list the three largest.");
	console.log();
} finally {
	session.dispose();
}
