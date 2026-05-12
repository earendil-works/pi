import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { homedir, networkInterfaces } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../config.js";
import { estimateContextTokens } from "../../core/compaction/index.js";
import { SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { assertHostAllowed, parseWebArgs, usage } from "./args.js";
import { assertAuthorized, assertSafeOrigin, requestHasToken, writeAuthRedirect } from "./auth.js";
import {
	HttpError,
	readJsonBody,
	requireNonEmptyString,
	requireString,
	sendError,
	sendJson,
	sendStaticFile,
	sendText,
} from "./http.js";
import { ProgressTrackerManager } from "./progress-tracker.js";
import { groupSessionsByProject } from "./projects.js";
import { RpcBridge } from "./rpc-bridge.js";
import { deleteWebSkill, listWebSkills, writeWebSkill } from "./skills.js";
import { TerminalManager, TerminalUnavailableError } from "./terminal.js";
import type {
	AskQuestionAnswer,
	AskQuestionRequest,
	ProgressTrackerRequest,
	PromptRequest,
	SetModelRequest,
	SetThinkingRequest,
	SkillWriteRequest,
	SwitchSessionRequest,
	SystemPromptRequest,
	TerminalInputRequest,
	TerminalResizeRequest,
	WebCommand,
	WebEvent,
	WebOptions,
	WebRpcResponse,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "..", "..", "cli.js");
const sourceWebDir = path.resolve(__dirname, "..", "..", "..", "web");
const distWebDir = path.resolve(__dirname, "..", "..", "web");
const webMainSystemPromptPath = path.join(getAgentDir(), "web-main-system-prompt.txt");

interface PendingQuestion {
	resolve: (answer: AskQuestionAnswer) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	options: string[];
}

export { assertHostAllowed, isLoopbackHost, parseWebArgs } from "./args.js";
export { TerminalManager, TerminalUnavailableError } from "./terminal.js";

export async function runWebMode(args: string[] = []): Promise<void> {
	const options = parseWebArgs(args);
	if (options.help) {
		console.log(usage());
		return;
	}
	assertHostAllowed(options);
	await startWebServer(options);
}

async function startWebServer(options: WebOptions): Promise<void> {
	const token = options.token?.trim() || "";
	const clients = new Set<http.ServerResponse>();
	const replayBuffer: WebEvent[] = [];
	const webRoot = await resolveWebRoot();
	let activeCwd = process.cwd();
	let rpcBusy = false;
	let askQuestionUrl = "";
	let progressTrackerUrl = "";
	let rpc = new RpcBridge(cliPath, options.rpcArgs, broadcast, activeCwd, webEnv());
	const terminalManager = new TerminalManager({ broadcast });
	const progressTrackerManager = new ProgressTrackerManager(broadcast);
	let mainSystemPromptOverride = await readMainSystemPromptOverride();
	const pendingQuestions = new Map<string, PendingQuestion>();

	function broadcast(event: WebEvent): void {
		if (event.type === "agent_start") rpcBusy = true;
		if (rpcBusy) {
			replayBuffer.push(event);
			if (replayBuffer.length > 500) replayBuffer.shift();
		}
		if (event.type === "agent_end") rpcBusy = false;
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of clients) res.write(payload);
	}

	async function applyMainSystemPromptOverride(targetRpc = rpc): Promise<void> {
		if (!mainSystemPromptOverride.trim()) return;
		try {
			await targetRpc.send({ type: "set_system_prompt", systemPrompt: mainSystemPromptOverride }, 120000);
		} catch (error) {
			broadcast({ type: "web_warning", message: error instanceof Error ? error.message : String(error) });
		}
	}

	function webEnv(): NodeJS.ProcessEnv {
		return {
			...(askQuestionUrl ? { PI_WEB_ASK_QUESTION_URL: askQuestionUrl } : {}),
			...(progressTrackerUrl ? { PI_WEB_PROGRESS_TRACKER_URL: progressTrackerUrl } : {}),
		};
	}

	await applyMainSystemPromptOverride();

	async function restartRpc(cwd: string, startNewSession: boolean): Promise<string> {
		const resolvedCwd = path.resolve(cwd);
		const previous = rpc;
		rpc = new RpcBridge(cliPath, options.rpcArgs, broadcast, resolvedCwd, webEnv());
		activeCwd = resolvedCwd;
		previous.stop();
		if (startNewSession) await rpc.send({ type: "new_session" });
		await applyMainSystemPromptOverride();
		return resolvedCwd;
	}

	const server = http.createServer((req, res) => {
		void handleRequest(req, res).catch((error) => sendError(res, error));
	});

	async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const queryTokenMatches = token && url.searchParams.get("token") === token;
		if (queryTokenMatches && !url.pathname.startsWith("/api/") && url.pathname !== "/events") {
			url.searchParams.delete("token");
			writeAuthRedirect(res, url.pathname + url.search, token);
			return;
		}

		if (token && (url.pathname.startsWith("/api/") || url.pathname === "/events") && !queryTokenMatches) {
			assertAuthorized(req, token);
			assertSafeOrigin(req);
		}

		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(`data: ${JSON.stringify({ type: "web_connected", rpcBusy })}\n\n`);
			if (rpcBusy) {
				for (const event of replayBuffer) res.write(`data: ${JSON.stringify({ ...event, replay: true })}\n\n`);
			}
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}

		if (url.pathname.startsWith("/api/")) {
			await handleApi(req, res, url);
			return;
		}

		if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
		if (url.pathname === "/favicon.svg") {
			sendText(
				res,
				`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6d5dfc"/><text x="32" y="43" text-anchor="middle" font-family="ui-serif, Georgia, serif" font-size="38" font-weight="700" fill="white">π</text></svg>`,
				200,
				{ "content-type": "image/svg+xml; charset=utf-8" },
			);
			return;
		}
		if (url.pathname.startsWith("/web/")) {
			const served = await sendStaticFile(res, webRoot, url.pathname.slice("/web/".length));
			if (!served) throw new HttpError(404, "Not found");
			return;
		}
		if (token && !requestHasToken(req, token)) {
			sendText(res, "Unauthorized. Open the URL printed by pi web.", 401);
			return;
		}
		const served = await sendStaticFile(res, webRoot, "index.html");
		if (!served) throw new HttpError(404, "Web client not found");
	}

	async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		if (req.method === "POST" && url.pathname === "/api/prompt") {
			const body = await readJsonBody<PromptRequest>(req);
			const message = requireNonEmptyString(body.message, "message");
			const response = await handlePrompt(message, body);
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/projects") {
			const sessions = await SessionManager.listAll();
			sendJson(res, { projects: groupSessionsByProject(sessions, activeCwd) });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/sessions") {
			sendJson(res, { sessions: await SessionManager.listAll() });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/browse") {
			const target = path.resolve(url.searchParams.get("path") || activeCwd);
			const stat = await fs.stat(target);
			if (!stat.isDirectory()) throw new HttpError(400, `Not a directory: ${target}`);
			const entries = (await fs.readdir(target, { withFileTypes: true }))
				.filter((entry) => !entry.name.startsWith("."))
				.map((entry) => ({
					name: entry.name,
					type: entry.isDirectory() ? "directory" : "file",
					path: path.join(target, entry.name),
				}))
				.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
			const parent = path.dirname(target) !== target ? path.dirname(target) : null;
			sendJson(res, { path: target, parent, entries });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/open-project") {
			const body = await readJsonBody<{ cwd?: string }>(req);
			const cwd = await restartRpc(requireNonEmptyString(body.cwd, "cwd"), true);
			sendJson(res, { success: true, cwd });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/models") {
			sendJson(res, await rpc.send({ type: "get_available_models" }));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/model") {
			const body = await readJsonBody<SetModelRequest>(req);
			const response = await rpc.send({
				type: "set_model",
				provider: requireString(body.provider, "provider"),
				modelId: requireString(body.modelId, "modelId"),
			});
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/thinking") {
			const body = await readJsonBody<SetThinkingRequest>(req);
			const response = await rpc.send({ type: "set_thinking_level", level: body.level });
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/commands") {
			sendJson(res, await mergeCommands(await rpc.send({ type: "get_commands" })));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/skills") {
			sendJson(res, { skills: await listWebSkills() });
			return;
		}
		if ((req.method === "POST" || req.method === "PUT") && url.pathname === "/api/skills") {
			const body = await readJsonBody<SkillWriteRequest>(req);
			sendJson(res, { success: true, skill: await writeWebSkill(body, req.method) });
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/skills") {
			const body = await readJsonBody<{ path?: string }>(req);
			await deleteWebSkill(body.path);
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/ask-question") {
			const body = await readJsonBody<AskQuestionRequest>(req, 64 * 1024);
			sendJson(res, await askQuestion(body));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/ask-question/answer") {
			const body = await readJsonBody<AskQuestionAnswer & { id?: string }>(req, 64 * 1024);
			answerQuestion(body.id, body);
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/progress-tracker") {
			sendJson(res, { success: true, data: await progressTrackerManager.state(await currentSessionFile()) });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/progress-tracker") {
			const body = await readJsonBody<ProgressTrackerRequest>(req, 64 * 1024);
			const data = await progressTrackerManager.register(
				requireNonEmptyString(body.path, "path"),
				activeCwd,
				await requireCurrentSessionFile(),
			);
			sendJson(res, { success: true, data });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/messages") {
			sendJson(res, await rpc.send({ type: "get_messages" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/local-image") {
			await sendLocalImage(res, requireNonEmptyString(url.searchParams.get("path"), "path"));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/new-session") {
			const response = await rpc.send({ type: "new_session" });
			await applyMainSystemPromptOverride();
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/switch-session") {
			const body = await readJsonBody<SwitchSessionRequest>(req);
			const sessionPath = requireNonEmptyString(body.sessionPath, "sessionPath");
			const response = await rpc.send({ type: "switch_session", sessionPath });
			if (response.success) {
				const sessions = await SessionManager.listAll();
				const match = sessions.find((session) => path.resolve(session.path) === path.resolve(sessionPath));
				if (match?.cwd) activeCwd = match.cwd;
				void applyMainSystemPromptOverride();
			}
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/session") {
			const body = await readJsonBody<SwitchSessionRequest>(req);
			const sessionPath = requireNonEmptyString(body.sessionPath, "sessionPath");
			const sessions = await SessionManager.listAll();
			const match = sessions.find((session) => path.resolve(session.path) === path.resolve(sessionPath));
			if (!match) throw new HttpError(400, "Unknown session");
			await fs.rm(sessionPath, { force: true });
			sendJson(res, { success: true });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			sendJson(res, await rpc.send({ type: "get_state" }));
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/stats") {
			const response = await rpc.send<WebRpcResponse & { data?: Record<string, unknown> }>({
				type: "get_session_stats",
			});
			const messagesResponse = await rpc.send<WebRpcResponse & { data?: { messages?: unknown[] } }>({
				type: "get_messages",
			});
			const stateResponse = await rpc.send<WebRpcResponse & { data?: { model?: { contextWindow?: number } } }>({
				type: "get_state",
			});
			if (response.success && messagesResponse.success) {
				const messages = (messagesResponse.data?.messages ?? []) as Parameters<typeof estimateContextTokens>[0];
				const estimated = estimateContextTokens(messages);
				const contextWindow = stateResponse.data?.model?.contextWindow ?? null;
				response.data = {
					...(response.data ?? {}),
					estimatedContextUsage: {
						tokens: estimated.tokens,
						contextWindow,
						percent: contextWindow ? (estimated.tokens / contextWindow) * 100 : null,
					},
				};
			}
			sendJson(res, response);
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/system-prompt") {
			sendJson(res, await rpc.send({ type: "get_system_prompt" }));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/system-prompt") {
			const body = await readJsonBody<SystemPromptRequest>(req);
			mainSystemPromptOverride = requireNonEmptyString(body.systemPrompt, "systemPrompt");
			await writeMainSystemPromptOverride(mainSystemPromptOverride);
			const response = await rpc.send({ type: "set_system_prompt", systemPrompt: mainSystemPromptOverride }, 120000);
			sendJson(res, response, response.success ? 200 : 400);
			return;
		}
		if (url.pathname.startsWith("/api/terminal/")) {
			await handleTerminalApi(req, res, url);
			return;
		}
		throw new HttpError(404, "Not found");
	}

	async function sendLocalImage(res: http.ServerResponse, filePath: string): Promise<void> {
		const expandedPath =
			filePath === "~" || filePath.startsWith(`~${path.sep}`) ? path.join(homedir(), filePath.slice(2)) : filePath;
		const resolvedPath = path.resolve(expandedPath);
		const mimeType = await detectSupportedImageMimeTypeFromFile(resolvedPath);
		if (!mimeType) throw new HttpError(404, "Image not found");
		const data = await fs.readFile(resolvedPath);
		res.writeHead(200, { "content-type": mimeType, "cache-control": "no-cache" });
		res.end(data);
	}

	async function handleTerminalApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
		try {
			if (req.method === "GET" && url.pathname === "/api/terminal/state") {
				sendJson(res, { success: true, data: terminalManager.state(activeCwd) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/start") {
				sendJson(res, { success: true, data: terminalManager.start(activeCwd) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/restart") {
				terminalManager.stop(activeCwd);
				sendJson(res, { success: true, data: terminalManager.start(activeCwd) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/input") {
				const body = await readJsonBody<TerminalInputRequest>(req);
				sendJson(res, {
					success: true,
					data: terminalManager.write(activeCwd, requireString(body.data, "terminal input")),
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/resize") {
				const body = await readJsonBody<TerminalResizeRequest>(req);
				sendJson(res, { success: true, data: terminalManager.resize(activeCwd, body.cols, body.rows) });
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/terminal/stop") {
				sendJson(res, { success: true, data: terminalManager.stop(activeCwd) });
				return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) {
			if (error instanceof TerminalUnavailableError) {
				sendText(res, error.message, 503);
				return;
			}
			throw error;
		}
	}

	function askQuestion(input: AskQuestionRequest): Promise<AskQuestionAnswer> {
		const question = requireNonEmptyString(input.question, "question");
		if (!Array.isArray(input.options)) throw new HttpError(400, "Missing options");
		const options = input.options.map((option) => String(option || "").trim()).filter(Boolean);
		if (options.length === 0) throw new HttpError(400, "Missing options");
		if (options.length > 12) throw new HttpError(400, "Too many options");
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => {
					pendingQuestions.delete(id);
					reject(new HttpError(408, "Question timed out"));
				},
				10 * 60 * 1000,
			);
			pendingQuestions.set(id, { resolve, reject, timeout, options });
			broadcast({ type: "ask_question", id, question, options });
		});
	}

	function answerQuestion(id: string | undefined, answer: AskQuestionAnswer): void {
		if (!id) throw new HttpError(400, "Missing question id");
		const pending = pendingQuestions.get(id);
		if (!pending) throw new HttpError(404, "Question not found");
		const response = normalizeQuestionAnswer(answer, pending.options);
		clearTimeout(pending.timeout);
		pendingQuestions.delete(id);
		pending.resolve(response);
	}

	async function currentSessionFile(): Promise<string | null> {
		const response = await rpc.send<WebRpcResponse & { data?: { sessionFile?: string } }>({ type: "get_state" });
		return response.success ? response.data?.sessionFile || null : null;
	}

	async function requireCurrentSessionFile(): Promise<string> {
		const sessionFile = await currentSessionFile();
		if (!sessionFile) throw new HttpError(400, "No active conversation session file");
		return sessionFile;
	}

	async function handlePrompt(message: string, body: PromptRequest): Promise<WebRpcResponse> {
		if (!message.trim().startsWith("/")) {
			return rpc.send({
				type: "prompt",
				message,
				images: body.images,
				streamingBehavior: body.streamingBehavior,
			});
		}
		const [rawCommand, ...rest] = message.trim().slice(1).split(/\s+/);
		const commandName = rawCommand.toLowerCase();
		const commandArgs = rest.join(" ").trim();
		switch (commandName) {
			case "compact":
				return rpc.send(
					commandArgs ? { type: "compact", customInstructions: commandArgs } : { type: "compact" },
					120000,
				);
			case "new": {
				const response = await rpc.send({ type: "new_session" });
				await applyMainSystemPromptOverride();
				return response;
			}
			case "export":
				return rpc.send(
					commandArgs ? { type: "export_html", outputPath: commandArgs } : { type: "export_html" },
					120000,
				);
			case "session":
				return rpc.send({ type: "get_session_stats" });
			case "copy":
				return rpc.send({ type: "get_last_assistant_text" });
			case "abort":
				return rpc.send({ type: "abort" });
			case "commands":
				return mergeCommands(await rpc.send({ type: "get_commands" }));
			case "name":
				if (!commandArgs) throw new HttpError(400, "Usage: /name <session name>");
				return rpc.send({ type: "set_session_name", name: commandArgs });
			case "clone":
				return rpc.send({ type: "clone" });
			case "reload": {
				await restartRpc(activeCwd, false);
				return textResponse("reload", "Reloaded Pi web RPC process.");
			}
			case "model":
				if (!commandArgs) return rpc.send({ type: "get_state" });
				return setModelByNeedle(commandArgs);
			case "settings":
				return rpc.send({ type: "get_state" });
			case "scoped-models":
				return rpc.send({ type: "get_available_models" });
			case "hotkeys":
				return textResponse(
					"hotkeys",
					"Web hotkeys: Enter send, Shift+Enter newline, / for commands, Tab/Enter apply slash command, mobile swipe opens sidebar.",
				);
			case "changelog":
				return textResponse("changelog", await readChangelog());
			case "resume":
				return resumeResponse();
			case "tree":
				return textResponse(
					"tree",
					"Tree navigation is not available in the web UI yet. Use the conversation list/sidebar or the TUI /tree command.",
				);
			case "fork":
				return textResponse(
					"fork",
					"Fork selection is not available in the web UI yet. Use the TUI /fork command.",
				);
			default:
				if (commandName.startsWith("skill:")) {
					const skillName = commandName.slice("skill:".length);
					return rpc.sendDetached({
						type: "prompt",
						message: `Use the ${skillName} skill. ${commandArgs}`.trim(),
					});
				}
				if (["import", "share", "login", "logout", "quit"].includes(commandName)) {
					throw new HttpError(400, `/${commandName} is interactive-only and is not available in Pi web yet`);
				}
				return rpc.sendDetached({
					type: "prompt",
					message: `${message}\n\nExecute the slash command above as requested.`,
				});
		}
	}

	async function setModelByNeedle(needleInput: string): Promise<WebRpcResponse> {
		const modelsResponse = await rpc.send<
			WebRpcResponse & { data?: { models?: Array<{ provider: string; id: string; name?: string }> } }
		>({
			type: "get_available_models",
		});
		const needle = needleInput.toLowerCase();
		const model = (modelsResponse.data?.models ?? []).find(
			(m) =>
				`${m.provider}/${m.id}`.toLowerCase() === needle ||
				m.id.toLowerCase() === needle ||
				(m.name || "").toLowerCase() === needle ||
				`${m.provider}/${m.id}`.toLowerCase().includes(needle),
		);
		if (!model) throw new HttpError(400, `Model not found: ${needleInput}`);
		return rpc.send({ type: "set_model", provider: model.provider, modelId: model.id });
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	askQuestionUrl = askQuestionEndpointUrl(options.host, port, token);
	progressTrackerUrl = progressTrackerEndpointUrl(options.host, port, token);
	await restartRpc(activeCwd, false);
	const urls = webUrls(options.host, port, token);
	console.log(`Pi web UI running at ${urls.local}`);
	for (const url of urls.network) console.log(`Network URL: ${url}`);
	console.log(`Headless Pi RPC PID: ${rpc.pid}`);
	if (options.open) openBrowser(urls.local);

	const shutdown = (): void => {
		server.close();
		terminalManager.stopAll();
		progressTrackerManager.stopAll();
		rpc.stop();
		for (const [id, pending] of pendingQuestions) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Pi web server stopped"));
			pendingQuestions.delete(id);
		}
	};
	process.once("SIGINT", () => {
		shutdown();
		process.exit(130);
	});
	process.once("SIGTERM", () => {
		shutdown();
		process.exit(143);
	});
}

async function resolveWebRoot(): Promise<string> {
	try {
		await fs.access(path.join(sourceWebDir, "index.html"));
		return sourceWebDir;
	} catch {
		return distWebDir;
	}
}

async function readMainSystemPromptOverride(): Promise<string> {
	try {
		return await fs.readFile(webMainSystemPromptPath, "utf8");
	} catch {
		return "";
	}
}

async function writeMainSystemPromptOverride(value: string): Promise<void> {
	await fs.mkdir(path.dirname(webMainSystemPromptPath), { recursive: true });
	await fs.writeFile(webMainSystemPromptPath, value, "utf8");
}

async function mergeCommands(response: WebRpcResponse): Promise<WebRpcResponse> {
	const dynamicCommands = response.success && response.command === "get_commands" ? response.data.commands : [];
	const skills = await listWebSkills();
	const skillNames = new Set(skills.map((skill) => skill.name));
	const byName = new Map<string, WebCommand>();
	for (const command of BUILTIN_SLASH_COMMANDS) byName.set(command.name, { ...command, source: "builtin" });
	for (const command of dynamicCommands) {
		if (command.name.startsWith("skill:") && !skillNames.has(command.name.slice("skill:".length))) continue;
		byName.set(command.name, command);
	}
	for (const skill of skills) {
		byName.set(`skill:${skill.name}`, {
			name: `skill:${skill.name}`,
			description: skill.description || `Use skill ${skill.name}`,
			source: "skill",
		});
	}
	return {
		type: "response",
		command: "get_commands",
		success: true,
		data: { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) },
	} as WebRpcResponse;
}

function textResponse(command: string, text: string): WebRpcResponse {
	return { type: "response", command, success: true, data: { text } } as WebRpcResponse;
}

function normalizeQuestionAnswer(answer: AskQuestionAnswer, options: string[]): AskQuestionAnswer {
	if (answer.custom) {
		const customAnswer = String(answer.answer || "").trim();
		if (!customAnswer) throw new HttpError(400, "Missing custom answer");
		return { answer: customAnswer, optionIndex: null, custom: true };
	}
	const optionIndex = Number(answer.optionIndex);
	if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
		throw new HttpError(400, "Invalid optionIndex");
	}
	return { answer: options[optionIndex], optionIndex, custom: false };
}

function askQuestionEndpointUrl(host: string, port: number, token: string): string {
	return webApiEndpointUrl(host, port, token, "/api/ask-question");
}

function progressTrackerEndpointUrl(host: string, port: number, token: string): string {
	return webApiEndpointUrl(host, port, token, "/api/progress-tracker");
}

function webApiEndpointUrl(host: string, port: number, token: string, pathname: string): string {
	const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
	const localHost = wildcard ? "127.0.0.1" : host;
	const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
	return `http://${localHost}:${port}${pathname}${tokenQuery}`;
}

async function readChangelog(): Promise<string> {
	const changelog = await fs
		.readFile(path.resolve(__dirname, "..", "..", "..", "CHANGELOG.md"), "utf8")
		.catch(() => "Changelog not found.");
	return changelog.split(/\r?\n/).slice(0, 120).join("\n");
}

async function resumeResponse(): Promise<WebRpcResponse> {
	const sessions = await SessionManager.listAll();
	return {
		type: "response",
		command: "resume",
		success: true,
		data: {
			sessions: sessions.slice(0, 50).map((session) => ({
				id: session.id,
				path: session.path,
				cwd: session.cwd,
				name: session.name,
				modified: session.modified,
			})),
		},
	} as WebRpcResponse;
}

function webUrls(host: string, port: number, token: string): { local: string; network: string[] } {
	const suffix = token ? `/?token=${encodeURIComponent(token)}` : "/";
	const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
	const localHost = wildcard ? "localhost" : host;
	const network = wildcard
		? Object.values(networkInterfaces())
				.flatMap((items) => items ?? [])
				.filter((item) => item.family === "IPv4" && !item.internal)
				.map((item) => `http://${item.address}:${port}${suffix}`)
		: [];
	return { local: `http://${localHost}:${port}${suffix}`, network };
}

function openBrowser(url: string): void {
	try {
		if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		else if (process.platform === "win32")
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		else {
			const graphical = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.WSL_DISTRO_NAME;
			const hasXdg =
				spawnSync("sh", ["-lc", "command -v xdg-open >/dev/null 2>&1"], { stdio: "ignore" }).status === 0;
			if (graphical && hasXdg) spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// Browser opening is best-effort only.
	}
}
