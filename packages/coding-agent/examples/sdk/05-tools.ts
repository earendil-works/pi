/**
 * Tools Configuration
 *
 * Use tool names to choose which built-in tools are enabled.
 *
 * Tool names are matched against all available tools. If you use a custom `cwd`,
 * createAgentSession() applies that cwd when it builds the actual built-in tools.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using pi.registerTool().
 */

import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";

// Read-only mode (no edit/write)
await createAgentSession({
	tools: ["read", "grep", "find", "ls"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Read-only session created");

// Custom tool selection
await createAgentSession({
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");

// With custom cwd
const customCwd = "/path/to/project";
await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "edit", "write"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Custom cwd session created");

// Or pick specific tools for custom cwd
await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
