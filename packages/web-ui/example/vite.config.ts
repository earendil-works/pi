import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Simple deterministic UUID v4 for Node (no crypto.randomUUID in older builds). */
function newId(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/**
 * Guard: resolves path and ensures it stays within allowedRoot.
 * Returns null if the resolved path would escape.
 */
function safePath(allowedRoot: string, ...segments: string[]): string | null {
	const full = resolve(join(allowedRoot, ...segments));
	return full.startsWith(allowedRoot) ? full : null;
}

/** Returns true if the request appears to come from a private/local network. */
function isLocalNetwork(req: any): boolean {
	const addr = req.socket?.remoteAddress ?? "";
	return (
		addr === "127.0.0.1" ||
		addr === "::1" ||
		addr === "::ffff:127.0.0.1" ||
		addr.startsWith("10.") ||
		addr.startsWith("192.168.") ||
		addr.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) !== null ||
		addr.startsWith("::ffff:10.") ||
		addr.startsWith("::ffff:192.168.")
	);
}

export default defineConfig({
	define: {
		"process.env": {},
	},
	plugins: [
		tailwindcss(),
		{
			name: "agent-proxy",
			configureServer(server) {
				server.middlewares.use(async (req, res, next) => {
					if (req.url === "/api/agent/settings") {
						const path = join(homedir(), ".pi", "agent", "settings.json");
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "settings.json not found" }));
						}
						return;
					}
					if (req.url === "/api/agent/commands") {
						// Return builtin slash commands + skills from ~/.pi/agent/skills/
						const builtins = [
							{ name: "new", description: "Start a new session", source: "builtin" },
							{ name: "clear", description: "Clear chat (alias for /new)", source: "builtin" },
							{ name: "resume", description: "Resume a past session", source: "builtin" },
							{ name: "session", description: "Show session info and stats", source: "builtin" },
							{ name: "clone", description: "Duplicate current session", source: "builtin" },
							{ name: "name", description: "Set session display name", source: "builtin" },
							{ name: "export", description: "Export session as JSON", source: "builtin" },
							{ name: "compact", description: "Compact session context", source: "builtin" },
							{ name: "model", description: "Select model", source: "builtin" },
							{ name: "copy", description: "Copy last agent message to clipboard", source: "builtin" },
							{ name: "login", description: "Configure provider authentication", source: "builtin" },
							{ name: "logout", description: "Remove provider authentication", source: "builtin" },
							{ name: "fork", description: "Fork from a previous message", source: "builtin" },
							{ name: "tree", description: "Navigate session tree", source: "builtin" },
							{ name: "share", description: "Share session as GitHub gist", source: "builtin" },
							{ name: "settings", description: "Open settings menu", source: "builtin" },
							{ name: "changelog", description: "Show changelog entries", source: "builtin" },
							{ name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin" },
							{ name: "reload", description: "Reload keybindings, extensions, skills", source: "builtin" },
							{ name: "quit", description: "Quit pi", source: "builtin" },
						];
						// Discover skills from ~/.pi/agent/skills/
						const skillsDir = join(homedir(), ".pi", "agent", "skills");
						const skills: { name: string; description: string; source: string }[] = [];
						if (existsSync(skillsDir)) {
							const { readdirSync } = await import("node:fs");
							for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
								if (entry.isDirectory()) {
									const skillMd = join(skillsDir, entry.name, "SKILL.md");
									let description = "";
									if (existsSync(skillMd)) {
										const content = readFileSync(skillMd, "utf-8");
										// Extract description from frontmatter if present
										const descMatch = content.match(/^description:\s*(.+)$/m);
										description = descMatch ? descMatch[1].trim() : "";
									}
									skills.push({ name: entry.name, description, source: "skill" });
								}
							}
						}
						res.setHeader("Content-Type", "application/json");
						res.end(JSON.stringify({ builtins, skills }));
						return;
					}
					if (req.url === "/api/agent/models") {
						const path = join(homedir(), ".pi", "agent", "models.json");
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "models.json not found" }));
						}
						return;
					}
					if (req.url?.startsWith("/api/agent/skill/")) {
						const skillName = decodeURIComponent(req.url.substring("/api/agent/skill/".length));
						const skillPath = join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md");
						if (existsSync(skillPath)) {
							let content = readFileSync(skillPath, "utf-8");
							// Strip frontmatter if present
							content = content.replace(/^---[\s\S]*?---\n/, "").trim();
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify({ name: skillName, content }));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: `Skill ${skillName} not found` }));
						}
						return;
					}
					if (req.url === "/api/agent/auth") {
						// auth.json contains OAuth tokens — restrict to local network only
						if (!isLocalNetwork(req)) {
							res.statusCode = 403;
							res.end(JSON.stringify({ error: "Forbidden" }));
							return;
						}
						const path = join(homedir(), ".pi", "agent", "auth.json");
						if (existsSync(path)) {
							res.setHeader("Content-Type", "application/json");
							res.end(readFileSync(path));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "auth.json not found" }));
						}
						return;
					}
					if (req.url === "/api/agents") {
						const agentsDir = join(homedir(), "agentes");
						if (existsSync(agentsDir)) {
							const dirs = readdirSync(agentsDir).filter((d) => {
								const fullPath = join(agentsDir, d);
								return statSync(fullPath).isDirectory() && existsSync(join(fullPath, ".pi"));
							});
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify(dirs));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: "agentes directory not found" }));
						}
						return;
					}
					if (req.url?.startsWith("/api/agents/")) {
						const agentsRoot = resolve(join(homedir(), "agentes"));
						const rawName = req.url.substring("/api/agents/".length);
						// Guard: only allow simple directory names (no slashes or dots)
						if (!/^[\w-]+$/.test(rawName)) {
							res.statusCode = 400;
							res.end(JSON.stringify({ error: "Invalid agent name" }));
							return;
						}
						const agentPiDir = safePath(agentsRoot, rawName, ".pi");
						if (!agentPiDir) {
							res.statusCode = 400;
							res.end(JSON.stringify({ error: "Invalid agent path" }));
							return;
						}

						if (existsSync(agentPiDir)) {
							const config: { name: string; systemPrompt?: string; files: Record<string, unknown> } = {
								name: rawName,
								files: {},
							};
							const files = readdirSync(agentPiDir);
							for (const file of files) {
								const filePath = join(agentPiDir, file);
								if (statSync(filePath).isFile()) {
									if (file === "SYSTEM.md") {
										config.systemPrompt = readFileSync(filePath, "utf-8");
									} else if (file.endsWith(".json")) {
										try {
											config.files[file] = JSON.parse(readFileSync(filePath, "utf-8"));
										} catch (e) {
											console.error(`[agent-proxy] Failed to parse ${file}: ${e}`);
										}
									}
								}
							}
							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify(config));
						} else {
							res.statusCode = 404;
							res.end(JSON.stringify({ error: `Agent ${rawName} not found` }));
						}
						return;
					}
					if (req.url?.startsWith("/api/storage/")) {
						const url = new URL(req.url, "http://localhost");
						const pathname = url.pathname;
						const parts = pathname.substring("/api/storage/".length).split("/");
						const storeName = parts[0];
						const action = parts[1];
						const agentName = url.searchParams.get("agent");

						let sessionsDir = join(homedir(), ".pi", "agent", "sessions");
						if (agentName && agentName !== "default") {
							sessionsDir = join(sessionsDir, `--root-agentes-${agentName}--`);
						} else {
							sessionsDir = join(sessionsDir, "--root--");
						}

						const getAllSessionFiles = (dir: string): string[] => {
							const results: string[] = [];
							if (!existsSync(dir)) return results;
							const list = readdirSync(dir);
							for (const file of list) {
								const path = join(dir, file);
								const stat = statSync(path);
								if (!stat?.isDirectory() && file.endsWith(".jsonl")) {
									results.push(path);
								}
							}
							return results;
						};

						const getMessagePreview = (message: any) => {
							if (!message || !message.content) return "";
							if (typeof message.content === "string") return message.content;
							if (Array.isArray(message.content)) {
								return message.content
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text)
									.join(" ");
							}
							return "";
						};

						const readSession = (path: string) => {
							const content = readFileSync(path, "utf-8");
							const lines = content.trim().split("\n");
							if (lines.length === 0) return null;

							try {
								const header = JSON.parse(lines[0]);
								if (header.type !== "session") return null;

								const messages: any[] = [];
								let title = "";
								let model = null;
								let thinkingLevel = "off";

								for (let i = 1; i < lines.length; i++) {
									const entry = JSON.parse(lines[i]);
									if (entry.type === "message") {
										messages.push(entry.message);
										if (entry.message.role === "assistant" && !model) {
											model = { id: entry.message.model, provider: entry.message.provider };
										}
									} else if (entry.type === "session_info") {
										title = entry.name || title;
									} else if (entry.type === "thinking_level_change") {
										thinkingLevel = entry.thinkingLevel;
									} else if (entry.type === "model_change") {
										model = { id: entry.modelId, provider: entry.provider };
									}
								}

								return {
									id: header.id,
									title: title || getMessagePreview(messages[0])?.substring(0, 50) || "New Session",
									model: model || { id: "unknown", provider: "unknown" },
									thinkingLevel,
									messages,
									createdAt: header.timestamp,
									lastModified: statSync(path).mtime.toISOString(),
								};
							} catch (e) {
								console.error(`[agent-proxy] Failed to parse session ${path}: ${e}`);
								return null;
							}
						};

						if (storeName === "sessions" || storeName === "sessions-metadata") {
							if (action === "keys") {
								const files = getAllSessionFiles(sessionsDir);
								const ids = files
									.map((f) => {
										const match = f.match(/_([a-f0-9-]+)\.jsonl$/);
										return match ? match[1] : null;
									})
									.filter(Boolean);
								res.setHeader("Content-Type", "application/json");
								res.end(JSON.stringify(ids));
								return;
							}

							if (action === "index" && parts[2] === "lastModified") {
								const files = getAllSessionFiles(sessionsDir);
								const sessions = files.map(readSession).filter(Boolean);

								if (storeName === "sessions-metadata") {
									const metadata = sessions.map((s: any) => ({
										id: s.id,
										title: s.title,
										createdAt: s.createdAt,
										lastModified: s.lastModified,
										messageCount: s.messages.length,
										usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
										thinkingLevel: s.thinkingLevel,
										preview: getMessagePreview(s.messages[0])?.substring(0, 200) || "",
									}));
									if (url.searchParams.get("direction") === "desc") {
										metadata.sort((a: any, b: any) => b.lastModified.localeCompare(a.lastModified));
									}
									res.setHeader("Content-Type", "application/json");
									res.end(JSON.stringify(metadata));
								} else {
									if (url.searchParams.get("direction") === "desc") {
										sessions.sort((a: any, b: any) => b.lastModified.localeCompare(a.lastModified));
									}
									res.setHeader("Content-Type", "application/json");
									res.end(JSON.stringify(sessions));
								}
								return;
							}

							const sessionId = decodeURIComponent(parts[1]);
							const files = getAllSessionFiles(sessionsDir);
							const sessionPath = files.find((f) => f.includes(sessionId));

							if (req.method === "GET") {
								if (parts[2] === "exists") {
									res.setHeader("Content-Type", "application/json");
									res.end(JSON.stringify({ exists: !!sessionPath }));
									return;
								}
								if (sessionPath) {
									const session = readSession(sessionPath);
									if (storeName === "sessions-metadata" && session) {
										res.setHeader("Content-Type", "application/json");
										res.end(
											JSON.stringify({
												id: session.id,
												title: session.title,
												createdAt: session.createdAt,
												lastModified: session.lastModified,
												messageCount: session.messages.length,
												thinkingLevel: session.thinkingLevel,
												preview: getMessagePreview(session.messages[0])?.substring(0, 200) || "",
											}),
										);
									} else {
										res.setHeader("Content-Type", "application/json");
										res.end(JSON.stringify(session));
									}
								} else {
									res.statusCode = 404;
									res.end(JSON.stringify({ error: "Session not found" }));
								}
								return;
							}

							if (req.method === "PUT") {
								const body = await new Promise<string>((resolve) => {
									let data = "";
									req.on("data", (chunk) => {
										data += chunk;
									});
									req.on("end", () => resolve(data));
								});
								const data = JSON.parse(body);

								// If sessions-metadata, we only update the title if it changed
								if (storeName === "sessions-metadata") {
									if (sessionPath) {
										const session = readSession(sessionPath);
										if (session && session.title !== data.title) {
											const infoEntry = {
												type: "session_info",
												id: newId(),
												parentId: session.messages.length > 0 ? "last" : null,
												timestamp: new Date().toISOString(),
												name: data.title,
											};
											appendFileSync(sessionPath, `${JSON.stringify(infoEntry)}\n`);
										}
									}
									res.end(JSON.stringify({ success: true }));
									return;
								}

								// For "sessions" store, we either create new or append
								let targetPath = sessionPath;
								if (!targetPath) {
									const timestamp = new Date().toISOString();
									const fileTimestamp = timestamp.replace(/[:.]/g, "-");
									targetPath = join(sessionsDir, `${fileTimestamp}_${sessionId}.jsonl`);
									if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });

									const header = {
										type: "session",
										version: 3,
										id: sessionId,
										timestamp,
										cwd: "/root/pi-mono",
									};
									writeFileSync(targetPath, `${JSON.stringify(header)}\n`);
								}

								// Full overwrite or intelligent append?
								// For web-ui compatibility, we'll rewrite the whole file to match the state exactly
								// but keep it as JSONL.
								const header = JSON.parse(readFileSync(targetPath, "utf-8").split("\n")[0]);
								let content = `${JSON.stringify(header)}\n`;

								if (data.title) {
									content += `${JSON.stringify({
										type: "session_info",
										id: "title",
										parentId: null,
										timestamp: data.createdAt || new Date().toISOString(),
										name: data.title,
									})}\n`;
								}

								if (data.thinkingLevel) {
									content += `${JSON.stringify({
										type: "thinking_level_change",
										id: "thinking",
										parentId: null,
										timestamp: data.createdAt || new Date().toISOString(),
										thinkingLevel: data.thinkingLevel,
									})}\n`;
								}

								for (const msg of data.messages) {
									content += `${JSON.stringify({
										type: "message",
										id: newId(),
										parentId: null,
										timestamp: msg.timestamp || new Date().toISOString(),
										message: msg,
									})}\n`;
								}

								writeFileSync(targetPath, content);
								res.end(JSON.stringify({ success: true }));
								return;
							}

							if (req.method === "DELETE") {
								if (sessionPath) {
									unlinkSync(sessionPath);
								}
								res.end(JSON.stringify({ success: true }));
								return;
							}
						}

						next();
						return;
					}
					if (req.url === "/api/sys/env") {
						res.setHeader("Content-Type", "application/json");
						res.end(
							JSON.stringify({
								cwd: resolve("/root/pi-mono"),
								homedir: homedir(),
								os: process.platform,
								user: process.env.USER || "root",
							}),
						);
						return;
					}

					if (req.url?.startsWith("/api/tools/execute")) {
						// Only allow from local network for safety
						if (!isLocalNetwork(req)) {
							res.statusCode = 403;
							res.end(JSON.stringify({ error: "Forbidden" }));
							return;
						}

						if (req.method !== "POST") {
							res.statusCode = 405;
							res.end(JSON.stringify({ error: "Method Not Allowed" }));
							return;
						}

						try {
							const bodyStr = await new Promise<string>((resolve) => {
								let data = "";
								req.on("data", (chunk) => {
									data += chunk;
								});
								req.on("end", () => resolve(data));
							});
							console.log("[agent-proxy] RAW BODY:", bodyStr);
							const parsed = JSON.parse(bodyStr);
							const { toolCallId, toolName, params, cwd = "/root/pi-mono" } = parsed;

							console.log(
								`[agent-proxy] Executing tool ${toolName} with toolCallId=${toolCallId}, params=`,
								params,
							);

							// Dynamically import from coding-agent (since it's a devDep)
							const { createBashTool, createReadTool, createWriteTool, createEditTool } = await import(
								"@mariozechner/pi-coding-agent"
							);

							const safeCwd = resolve(cwd);
							let tool: { execute: (id: string, params: any) => Promise<any> };
							switch (toolName) {
								case "bash":
									tool = createBashTool(safeCwd);
									break;
								case "read":
									tool = createReadTool(safeCwd);
									break;
								case "write":
									tool = createWriteTool(safeCwd);
									break;
								case "edit":
									tool = createEditTool(safeCwd);
									break;
								default:
									res.statusCode = 400;
									res.end(JSON.stringify({ error: `Unknown tool: ${toolName}` }));
									return;
							}

							// Execute tool natively in Node.js
							const result = await tool.execute(toolCallId, params);

							res.setHeader("Content-Type", "application/json");
							res.end(JSON.stringify(result));
						} catch (err: any) {
							console.error(`[agent-proxy] Tool execution error:`, err);
							res.statusCode = 500;
							// Try to preserve output if it's an execution error
							res.end(JSON.stringify({ error: String(err.message || err) }));
						}
						return;
					}

					if (req.url?.startsWith("/api/files/")) {
						const url = new URL(req.url, "http://localhost");
						const pathname = url.pathname;
						const action = pathname.substring("/api/files/".length);
						const baseDir = resolve("/root/pi-mono"); // Root directory for file explorer

						if (action === "list") {
							const relPath = url.searchParams.get("path") || ".";
							const fullPath = safePath(baseDir, relPath);
							if (!fullPath) {
								res.statusCode = 400;
								res.end(JSON.stringify({ error: "Invalid path" }));
								return;
							}

							if (existsSync(fullPath)) {
								const items = readdirSync(fullPath).map((name) => {
									const itemPath = join(fullPath, name);
									const stat = statSync(itemPath);
									return {
										name,
										isDirectory: stat.isDirectory(),
										size: stat.size,
										mtime: stat.mtime.toISOString(),
									};
								});
								res.setHeader("Content-Type", "application/json");
								res.end(JSON.stringify(items));
							} else {
								res.statusCode = 404;
								res.end(JSON.stringify({ error: "Directory not found" }));
							}
							return;
						}

						if (action === "download") {
							const relPath = url.searchParams.get("path") || "";
							const fullPath = safePath(baseDir, relPath);
							if (!fullPath) {
								res.statusCode = 400;
								res.end(JSON.stringify({ error: "Invalid path" }));
								return;
							}

							if (existsSync(fullPath) && statSync(fullPath).isFile()) {
								res.setHeader(
									"Content-Disposition",
									`attachment; filename="${join(relPath).split("/").pop()}"`,
								);
								res.setHeader("Content-Type", "application/octet-stream");
								res.end(readFileSync(fullPath));
							} else {
								res.statusCode = 404;
								res.end(JSON.stringify({ error: "File not found" }));
							}
							return;
						}

						if (action === "mkdir" && req.method === "POST") {
							const body = await new Promise<string>((resolve) => {
								let data = "";
								req.on("data", (chunk) => {
									data += chunk;
								});
								req.on("end", () => resolve(data));
							});
							const { path: relPath } = JSON.parse(body);
							const fullPath = safePath(baseDir, relPath);
							if (!fullPath) {
								res.statusCode = 400;
								res.end(JSON.stringify({ error: "Invalid path" }));
								return;
							}

							if (!existsSync(fullPath)) {
								mkdirSync(fullPath, { recursive: true });
								res.end(JSON.stringify({ success: true }));
							} else {
								res.statusCode = 400;
								res.end(JSON.stringify({ error: "Directory already exists" }));
							}
							return;
						}

						if (action === "upload" && req.method === "POST") {
							const relPath = url.searchParams.get("path") || "";
							const fileName = url.searchParams.get("name") || "upload";
							const fullPath = safePath(baseDir, relPath, fileName);
							if (!fullPath) {
								res.statusCode = 400;
								res.end(JSON.stringify({ error: "Invalid path" }));
								return;
							}
							await new Promise((resolve) => req.on("end", resolve));

							const dir = safePath(baseDir, relPath);
							if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

							writeFileSync(fullPath, Buffer.concat(chunks));
							res.end(JSON.stringify({ success: true }));
							return;
						}
					}
					if (req.url?.startsWith("/api/proxy/")) {
						const targetUrl = decodeURIComponent(req.url.substring("/api/proxy/".length));

						// Simple proxy — dev-only helper
						const body = await new Promise<Buffer>((resolve) => {
							const chunks: Buffer[] = [];
							req.on("data", (chunk) => {
								chunks.push(chunk);
							});
							req.on("end", () => resolve(Buffer.concat(chunks)));
						});

						try {
							const requestHeaders: Record<string, string> = {};
							for (const [key, value] of Object.entries(req.headers)) {
								if (value !== undefined) {
									requestHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
								}
							}

							// Inject Antigravity User-Agent for Google requests
							// Browsers block this header, so we must inject it at the proxy level
							if (targetUrl.includes("googleapis.com") || targetUrl.includes("localhost:51200")) {
								requestHeaders["user-agent"] = "antigravity/1.21.9 darwin/arm64";
								// Strip X-Goog-Api-Key as the rotator doesn't swap it and it causes 404s at Google
								delete requestHeaders["x-goog-api-key"];
								// Strip Origin and Referer to look like a native IDE request
								delete requestHeaders.origin;
								delete requestHeaders.referer;
							}

							// For all proxied requests, strip Origin/Referer so self-hosted servers
							// (Ollama, LM Studio, etc.) that have strict CORS allowlists don't reject them.
							// The proxy itself is the effective client — CORS is irrelevant server-to-server.
							delete requestHeaders.origin;
							delete requestHeaders.referer;
							delete requestHeaders.host;
							const response = await fetch(targetUrl, {
								method: req.method,
								headers: requestHeaders,
								body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
							});

							res.statusCode = response.status;
							for (const [key, value] of response.headers.entries()) {
								res.setHeader(key, value);
							}
							const resBody = await response.arrayBuffer();
							res.end(Buffer.from(resBody));
						} catch (err) {
							console.error(`[agent-proxy] Proxy error: ${err}`);
							res.statusCode = 500;
							res.end(JSON.stringify({ error: String(err) }));
						}
						return;
					}
					next();
				});
			},
		},
	],
});
