// @ts-nocheck
/* biome-ignore-all lint: vendored web server */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateContextTokens } from "./core/compaction/index.js";
import { SessionManager } from "./core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "./core/slash-commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "cli.js");
const sourceWebDir = path.join(__dirname, "..", "web");
const webDir = fs.existsSync(sourceWebDir) ? sourceWebDir : path.join(__dirname, "web");
const webMainSystemPromptPath = path.join(os.homedir(), ".pi", "agent", "web-main-system-prompt.txt");
async function readWebMainSystemPromptOverride() {
	try {
		return await fs.promises.readFile(webMainSystemPromptPath, "utf8");
	} catch {
		return "";
	}
}
async function writeWebMainSystemPromptOverride(value) {
	await fs.promises.mkdir(path.dirname(webMainSystemPromptPath), { recursive: true });
	await fs.promises.writeFile(webMainSystemPromptPath, value, "utf8");
}

function parseArgs(args) {
	const result = { port: 5173, host: "127.0.0.1", open: true, rpcArgs: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") result.help = true;
		else if (arg === "--no-open") result.open = false;
		else if (arg === "--port") result.port = Number(args[++i] ?? result.port);
		else if (arg.startsWith("--port=")) result.port = Number(arg.slice("--port=".length));
		else if (arg === "--host") result.host = args[++i] ?? result.host;
		else if (arg.startsWith("--host=")) result.host = arg.slice("--host=".length);
		else result.rpcArgs.push(arg);
	}
	return result;
}

function usage() {
	console.log(
		`pi web - browser UI for Pi\n\nUsage:\n  pi web [--port 5173] [--host 127.0.0.1] [--no-open] [pi options...]\n\nExamples:\n  pi web\n  pi web --port 3000 --model sonnet:high\n  pi web --no-open --provider openai --model gpt-5\n`,
	);
}

function openBrowser(url) {
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
	} catch {}
}

const WEB_BUILTIN_COMMANDS = BUILTIN_SLASH_COMMANDS.map((command) => ({
	...command,
	source: "builtin",
}));

function groupSessionsByProject(sessions, currentCwd) {
	const projects = new Map();
	for (const session of sessions) {
		const cwd = session.cwd || "Unknown";
		if (!projects.has(cwd)) {
			projects.set(cwd, { cwd, sessions: [] });
		}
		projects.get(cwd).sessions.push({
			path: session.path,
			id: session.id,
			cwd: session.cwd,
			name: session.name,
			firstMessage: session.firstMessage,
			modified: session.modified,
			created: session.created,
			messageCount: session.messageCount,
		});
	}
	if (currentCwd && !projects.has(currentCwd)) {
		projects.set(currentCwd, { cwd: currentCwd, sessions: [] });
	}
	return [...projects.values()]
		.map((project) => ({
			...project,
			sessions: project.sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()),
			modified: project.sessions[0]?.modified,
		}))
		.sort((a, b) => new Date(b.modified ?? 0).getTime() - new Date(a.modified ?? 0).getTime());
}

function parseSkillMarkdown(content, fallbackName) {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	const meta = {};
	if (match) {
		for (const line of match[1].split(/\r?\n/)) {
			const idx = line.indexOf(":");
			if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}
	const heading = content.match(/^#\s+(.+)$/m);
	return {
		name: meta.name || fallbackName || (heading && heading[1]) || "Untitled skill",
		description: meta.description || "",
		meta,
		body: content.replace(/^---\n[\s\S]*?\n---\n?/, ""),
		content,
	};
}

function skillSlug(name) {
	return String(name || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

async function listWebSkills() {
	const roots = [path.join(os.homedir(), ".pi", "agent", "skills")];
	const skills = [];
	for (const root of roots) {
		let entries = [];
		try {
			entries = await fs.promises.readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillPath = path.join(root, entry.name, "SKILL.md");
			try {
				const content = await fs.promises.readFile(skillPath, "utf8");
				skills.push({ ...parseSkillMarkdown(content, entry.name), path: skillPath });
			} catch {}
		}
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function mergeCommands(response) {
	const dynamicCommands = response?.data?.commands ?? [];
	const currentSkills = await listWebSkills();
	const currentSkillNames = new Set(currentSkills.map((skill) => skill.name));
	const byName = new Map();
	for (const command of WEB_BUILTIN_COMMANDS) {
		byName.set(command.name, command);
	}
	for (const command of dynamicCommands) {
		if (
			String(command.name || "").startsWith("skill:") &&
			!currentSkillNames.has(String(command.name).slice("skill:".length))
		)
			continue;
		byName.set(command.name, command);
	}
	for (const skill of currentSkills) {
		byName.set("skill:" + skill.name, {
			name: "skill:" + skill.name,
			description: skill.description || "Use skill " + skill.name,
			source: "skill",
		});
	}
	return {
		type: "response",
		command: "get_commands",
		success: true,
		data: { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) },
	};
}

function createRpc(rpcArgs, broadcast, cwd = process.cwd()) {
	const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...rpcArgs], {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const pending = new Map();
	let nextId = 1;
	let stdoutBuffer = "";
	let stderrBuffer = "";

	function handleLine(line) {
		if (!line.trim()) return;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			broadcast({ type: "rpc_parse_error", line });
			return;
		}
		if (msg.type === "response" && msg.id && pending.has(msg.id)) {
			const { resolve } = pending.get(msg.id);
			pending.delete(msg.id);
			resolve(msg);
		}
		broadcast(msg);
	}

	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk.toString("utf8");
		let idx;
		while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
			const line = stdoutBuffer.slice(0, idx).replace(/\r$/, "");
			stdoutBuffer = stdoutBuffer.slice(idx + 1);
			handleLine(line);
		}
	});
	child.stderr.on("data", (chunk) => {
		stderrBuffer += chunk.toString("utf8");
		let idx;
		while ((idx = stderrBuffer.indexOf("\n")) >= 0) {
			const line = stderrBuffer.slice(0, idx).replace(/\r$/, "");
			stderrBuffer = stderrBuffer.slice(idx + 1);
			if (line.trim()) broadcast({ type: "rpc_stderr", line });
		}
	});
	child.on("exit", (code, signal) => broadcast({ type: "rpc_exit", code, signal }));

	function send(command, timeoutMs = 30000) {
		const id = `web-${nextId++}`;
		const message = { id, ...command };
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`RPC command timed out: ${command.type}`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				reject,
			});
			child.stdin.write(JSON.stringify(message) + "\n", (err) => {
				if (err) {
					clearTimeout(timeout);
					pending.delete(id);
					reject(err);
				}
			});
		});
	}

	function sendDetached(command) {
		const id = `web-${nextId++}`;
		const message = { id, ...command };
		return new Promise((resolve, reject) => {
			child.stdin.write(JSON.stringify(message) + "\n", (err) => {
				if (err) reject(err);
				else resolve({ type: "response", id, command: command.type, success: true, detached: true });
			});
		});
	}

	return { child, send, sendDetached, cwd };
}

function createTerminalManager(broadcast) {
	const terminals = new Map();
	const maxBufferLength = 200000;

	function terminalKey(cwd) {
		return path.resolve(cwd || process.cwd());
	}

	function terminalShell() {
		if (process.env.SHELL) return process.env.SHELL;
		return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
	}

	function shellArgs(shell) {
		if (process.platform === "win32") return [];
		const base = path.basename(shell);
		return base === "bash" || base === "zsh" || base === "fish" || base === "sh" ? ["-i"] : [];
	}

	function appendOutput(terminal, data) {
		terminal.buffer += data;
		if (terminal.buffer.length > maxBufferLength) terminal.buffer = terminal.buffer.slice(-maxBufferLength);
		broadcast({ type: "terminal_output", cwd: terminal.cwd, data });
	}

	function ensure(cwd) {
		const resolvedCwd = terminalKey(cwd);
		const existing = terminals.get(resolvedCwd);
		if (existing && !existing.exited) return existing;
		const shell = terminalShell();
		const child = spawn(shell, shellArgs(shell), {
			cwd: resolvedCwd,
			env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const terminal = { cwd: resolvedCwd, child, buffer: "", exited: false, exitCode: null, signal: null };
		terminals.set(resolvedCwd, terminal);
		broadcast({ type: "terminal_start", cwd: resolvedCwd, pid: child.pid });
		child.stdout.on("data", (chunk) => appendOutput(terminal, chunk.toString("utf8")));
		child.stderr.on("data", (chunk) => appendOutput(terminal, chunk.toString("utf8")));
		child.on("exit", (code, signal) => {
			terminal.exited = true;
			terminal.exitCode = code;
			terminal.signal = signal;
			broadcast({ type: "terminal_exit", cwd: resolvedCwd, code, signal });
		});
		child.on("error", (error) => {
			appendOutput(terminal, `\r\nTerminal error: ${error instanceof Error ? error.message : String(error)}\r\n`);
		});
		return terminal;
	}

	function write(cwd, data) {
		const terminal = ensure(cwd);
		if (terminal.exited) throw new Error("Terminal is not running");
		terminal.child.stdin.write(String(data || ""));
		return terminal;
	}

	function stop(cwd) {
		const resolvedCwd = terminalKey(cwd);
		const terminal = terminals.get(resolvedCwd);
		if (!terminal) return;
		terminal.child.kill("SIGTERM");
		terminals.delete(resolvedCwd);
	}

	function stopAll() {
		for (const terminal of terminals.values()) terminal.child.kill("SIGTERM");
		terminals.clear();
	}

	function state(cwd) {
		const resolvedCwd = terminalKey(cwd);
		const terminal = terminals.get(resolvedCwd);
		return {
			cwd: resolvedCwd,
			running: !!terminal && !terminal.exited,
			pid: terminal?.child?.pid ?? null,
			buffer: terminal?.buffer ?? "",
			exitCode: terminal?.exitCode ?? null,
			signal: terminal?.signal ?? null,
		};
	}

	return { ensure, write, stop, stopAll, state };
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pi Web</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <style>
    :root { color-scheme: light; --bg:#f7f8fb; --panel:#ffffff; --muted:#667085; --text:#111827; --accent:#6d5dfc; --border:#e5e7eb; --soft:#eef2ff; --tool:#f3f4f6; }
    * { box-sizing: border-box; } html, body { width:100%; max-width:100%; overflow-x:hidden; } body { margin:0; font:14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--text); }
    .app { display:grid; grid-template-columns:300px 1fr; min-height:100vh; }
    aside { position:fixed; inset:0 auto 0 0; width:300px; background:#ecebe7; border-right:1px solid #dedbd3; padding:18px 14px; overflow:auto; }
    .maincol { grid-column:2; min-width:0; }
    header { height:52px; display:flex; align-items:center; justify-content:space-between; padding:0 18px; border-bottom:1px solid var(--border); background:rgba(255,255,255,.92); backdrop-filter:blur(12px); position:fixed; top:0; left:300px; right:0; z-index:10; }
    h1 { font-size:16px; margin:0; } .status { color:var(--muted); font-size:12px; }
    main { max-width:1120px; margin:0 auto; padding:74px 22px 112px; }
    .msg { white-space:pre-wrap; overflow-wrap:anywhere; margin:16px 0; }
    .agents-container { max-width:980px; margin:0 auto; display:flex; flex-direction:column; gap:22px; }
    .agents-section { background:#fff; border:1px solid var(--border); border-radius:16px; padding:16px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
    .agents-section h2 { margin:0 0 12px; font-size:16px; }
    .agent-list { display:flex; flex-direction:column; gap:10px; }
    .agent-card { display:flex; align-items:center; gap:12px; border:1px solid #e5e7eb; border-radius:14px; padding:12px; background:#fff; }
    .agent-avatar { width:34px; height:34px; border-radius:10px; background:#eef2ff; color:#4f46e5; display:flex; align-items:center; justify-content:center; font-weight:900; flex:0 0 auto; overflow:hidden; }
    .agent-avatar img { width:100%; height:100%; object-fit:cover; }
    .agent-info { flex:1; min-width:0; }
    .agent-name { font-weight:800; display:flex; align-items:center; gap:8px; }
    .agent-status { font-size:10px; text-transform:uppercase; letter-spacing:.06em; border-radius:999px; padding:2px 6px; background:#ecfdf3; color:#067647; }
    .agent-status.disabled { background:#f2f4f7; color:#667085; }
    .agent-desc { color:#667085; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .agent-meta { color:#98a2b3; font-size:11px; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .agent-add { background:#f2f4f7; color:#344054; box-shadow:none; }
    .skill-actions { display:flex; gap:8px; margin-top:10px; }
    .skill-action { background:#f2f4f7; color:#344054; box-shadow:none; padding:8px 10px; font-size:12px; }
    .skill-content { display:none; margin-top:10px; border:1px solid #e5e7eb; border-radius:12px; background:#f9fafb; padding:12px; max-height:520px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:#344054; }
    .skill-content.visible { display:block; }
    .agent-modal { width:min(760px, 94vw); max-height:min(760px, 88vh); background:#fff; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 24px 80px rgba(16,24,40,.28); display:flex; flex-direction:column; overflow:hidden; }
    .agent-modal-body { overflow:auto; padding:16px; display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .agent-field { display:flex; flex-direction:column; gap:6px; color:#344054; font-size:12px; font-weight:800; }
    .agent-field.full { grid-column:1 / -1; }
    .agent-field input, .agent-field textarea { border:1px solid #d0d5dd; border-radius:12px; padding:10px 12px; color:#111827; background:#fff; font:14px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; outline:none; }
    .agent-field textarea { resize:vertical; min-height:82px; max-height:220px; }
    .agent-picker { border:1px solid #d0d5dd; border-radius:12px; padding:8px; display:flex; flex-direction:column; gap:6px; max-height:150px; overflow:auto; background:#fff; }
    .agent-picker-row { display:flex; align-items:flex-start; gap:8px; padding:7px 8px; border-radius:9px; color:#344054; font-weight:600; }
    .agent-picker-row:hover { background:#f2f4f7; }
    .agent-picker-row input { margin-top:3px; }
    .agent-picker-name { font-weight:800; }
    .agent-picker-desc { color:#667085; font-size:11px; font-weight:500; }
    .agent-enabled-row { display:flex; align-items:center; gap:8px; padding:10px 0; color:#344054; font-weight:800; }
    .agent-enabled-row input { width:auto; }
    .agent-icon-preview { width:42px; height:42px; border-radius:12px; background:#eef2ff; color:#4f46e5; display:flex; align-items:center; justify-content:center; font-weight:900; overflow:hidden; border:1px solid #e5e7eb; }
    .agent-icon-preview img { width:100%; height:100%; object-fit:cover; }
    .msg.system { border:1px solid var(--border); background:var(--panel); border-radius:16px; padding:12px 14px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
    .user { margin-left:auto; max-width:min(760px, 82%); border:1px solid #c7d2fe; background:var(--soft); border-radius:20px 20px 6px 20px; padding:12px 14px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
    .assistant { width:100%; padding:8px 2px 22px; border-bottom:1px solid var(--border); font-size:15px; line-height:1.65; }
    .assistant .body { max-width:980px; }
    .assistant-spinner { display:none; width:16px; height:16px; margin-top:10px; border:2px solid #e5e7eb; border-top-color:#111827; border-radius:50%; animation:spin .8s linear infinite; }
    .assistant.generating .assistant-spinner { display:block; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .tool { border:1px solid var(--border); border-radius:12px; padding:10px 12px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:#475467; background:var(--tool); }
    .tool.running { border-color:#c7d2fe; background:#eef2ff; }
    .tool.error { border-color:#fecaca; background:#fff1f2; color:#991b1b; }
    .tool pre { margin:8px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; }
    .tool-line { display:flex; align-items:center; gap:8px; color:#475467; font-size:13px; margin:8px 0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    .tool-line.running { color:#4f46e5; }
    .tool-line.error { color:#b42318; }
    .tool-icon { width:18px; text-align:center; }
    .tool-output { margin:6px 0 10px 26px; border-left:2px solid #e5e7eb; padding:6px 0 6px 10px; color:#667085; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; max-height:260px; overflow:auto; }
    details.tool-details { margin:8px 0; color:#475467; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; }
    details.tool-details.command-details { color:#344054; }
    details.tool-details summary { cursor:pointer; color:#475467; list-style:none; }
    details.tool-details summary::-webkit-details-marker { display:none; }
    details.tool-details summary::before { content:'›'; display:inline-block; width:18px; transition:transform .12s ease; }
    details.tool-details[open] summary::before { transform:rotate(90deg); }
    .diff { margin:6px 0 10px 26px; border:1px solid #e5e7eb; border-radius:10px; overflow:auto; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
    .diff-line { white-space:pre-wrap; padding:2px 10px; }
    .diff-line.del { background:#fff1f2; color:#b42318; }
    .diff-line.add { background:#ecfdf3; color:#067647; }
    .diff-file { color:#667085; background:#f9fafb; padding:6px 10px; border-bottom:1px solid #e5e7eb; font-weight:700; }
    .thinking { border-left:3px solid #d0d5dd; padding-left:10px; color:#667085; background:#fafafa; }
    .meta { color:var(--muted); font-size:11px; margin-bottom:6px; text-transform:uppercase; letter-spacing:.06em; font-weight:700; }
    form { position:fixed; left:300px; right:0; bottom:0; background:linear-gradient(to top, rgba(247,248,251,.98), rgba(247,248,251,.86)); backdrop-filter:blur(14px); padding:12px 18px 14px; }
    .composer-wrap { max-width:980px; margin:0 auto; position:relative; }
    .message-queue { display:none; flex-direction:column; gap:8px; margin:0 0 8px; }
    .message-queue.visible { display:flex; }
    .queue-item { display:flex; align-items:center; gap:10px; border:1px solid #d0d5dd; background:#fff; border-radius:14px; padding:8px 10px; box-shadow:0 1px 2px rgba(16,24,40,.05); }
    .queue-label { color:#667085; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.06em; }
    .queue-text { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#344054; font-size:13px; }
    .queue-remove { border:0; background:transparent; color:#667085; padding:2px; box-shadow:none; font-size:16px; }
    .composer-card { border:1px solid #d9d9d9; background:#fff; border-radius:20px; box-shadow:0 6px 20px rgba(16,24,40,.07); padding:10px 12px 8px; }
    .composer { display:grid; grid-template-columns:auto 1fr auto auto auto auto; gap:8px; align-items:center; }
    .attachment-preview { display:none; gap:8px; flex-wrap:wrap; margin:0 0 8px; }
    .attachment-preview.visible { display:flex; }
    .attachment-chip { display:flex; align-items:center; gap:8px; max-width:220px; border:1px solid #d0d5dd; background:#fff; border-radius:12px; padding:6px 8px; box-shadow:0 1px 2px rgba(16,24,40,.05); }
    .attachment-chip img { width:34px; height:34px; object-fit:cover; border-radius:8px; border:1px solid #e5e7eb; }
    .attachment-icon { width:34px; height:34px; border-radius:8px; display:flex; align-items:center; justify-content:center; background:#f2f4f7; color:#667085; font-weight:800; }
    .attachment-info { min-width:0; flex:1; }
    .attachment-name { font-size:12px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .attachment-meta { font-size:11px; color:#667085; }
    .attachment-remove { border:0; background:transparent; color:#667085; padding:2px; box-shadow:none; font-size:16px; }
    .chat-attachments { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .chat-attachment { border:1px solid #d0d5dd; border-radius:12px; background:#fff; padding:6px; max-width:220px; }
    .chat-attachment img { display:block; max-width:200px; max-height:180px; border-radius:9px; object-fit:contain; }
    .chat-file { display:flex; align-items:center; gap:8px; color:#344054; font-size:12px; padding:6px 8px; }
    .attach-button { width:28px; height:28px; border:0; background:transparent; color:#8b8b8b; box-shadow:none; padding:0; font-size:22px; line-height:1; font-weight:300; }
    .model-select { width:104px; border:0; background:transparent; color:#202124; padding:3px 2px; font-size:13px; font-weight:500; }
    .thinking-select { width:94px; border:0; background:transparent; color:#8b8b8b; padding:3px 2px; font-size:13px; font-weight:500; }
    .mic-button { width:28px; height:28px; border:0; background:transparent; color:#8b8b8b; padding:0; box-shadow:none; display:flex; align-items:center; justify-content:center; }
    textarea { grid-column:1 / -1; width:100%; resize:none; min-height:42px; max-height:160px; overflow-y:auto; border:0; background:#fff; color:var(--text); padding:2px 4px 8px; outline:none; box-shadow:none; font-size:15px; line-height:1.35; }
    textarea::placeholder { color:#b8b8b8; }
    textarea:focus { box-shadow:none; }
    button { border:0; border-radius:12px; background:var(--accent); color:white; padding:12px 18px; font-weight:700; cursor:pointer; box-shadow:0 1px 2px rgba(16,24,40,.12); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    #send { width:32px; height:32px; border-radius:999px; background:#d1d5db; color:white; padding:0; display:flex; align-items:center; justify-content:center; }
    #send.active, #send.generating { background:#111827; }
    #send svg, .mic-button svg { width:18px; height:18px; display:block; }
    #send .stop-icon { display:none; width:12px; height:12px; border-radius:2px; background:#fff; }
    #send.generating .send-icon { display:none; }
    #send.generating .stop-icon { display:block; }
    code { color:#5b21b6; }
    .suggestions { display:none; position:absolute; left:0; right:78px; bottom:72px; max-height:260px; overflow:auto; border:1px solid var(--border); border-radius:14px; background:#fff; box-shadow:0 18px 40px rgba(16,24,40,.16); padding:6px; }
    .suggestions.visible { display:block; }
    .suggestion { padding:9px 10px; border-radius:10px; cursor:pointer; display:flex; gap:10px; align-items:baseline; }
    .suggestion:hover, .suggestion.active { background:#f2f4ff; }
    .suggestion-name { font-weight:800; color:#3f3ad8; min-width:150px; }
    .suggestion-desc { color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    select { border:1px solid #d0d5dd; border-radius:10px; background:#fff; color:#111827; padding:8px 10px; }
    .side-action { display:flex; align-items:center; gap:14px; width:100%; border:0; background:transparent; color:#333; padding:10px 10px; border-radius:12px; font-size:18px; font-weight:500; box-shadow:none; text-align:left; }
    .side-action:hover { background:#deddd8; }
    .side-icon { width:22px; text-align:center; color:#333; }
    .sidebar-search { display:none; margin:10px 4px 0; }
    .sidebar-search.visible { display:block; }
    .sidebar-search input { width:100%; border:1px solid #d0d5dd; border-radius:12px; padding:9px 10px; background:#fff; color:#344054; outline:none; }
    .sidebar-search input:focus { border-color:#9b8afb; box-shadow:0 0 0 3px rgba(109,93,252,.12); }
    .projects-title { color:#9a9a9a; font-size:17px; margin:28px 4px 16px; }
    .project { margin:14px 0 20px; }
    .project-head { display:flex; align-items:center; gap:10px; color:#666; font-size:18px; margin:0 4px 8px; cursor:pointer; border-radius:12px; padding:4px 6px; }
    .project-head:hover { background:#deddd8; }
    .project-caret { width:14px; color:#8a8a8a; transition:transform .12s ease; }
    .project.collapsed .project-caret { transform:rotate(-90deg); }
    .project.collapsed .session-row, .project.collapsed .show-more { display:none; }
    .project-icon { width:20px; height:20px; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
    .project-icon img { width:20px; height:20px; border-radius:5px; object-fit:cover; }
    .project-name { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .project-menu-button { opacity:0; border:0; background:transparent; color:#667085; box-shadow:none; padding:0 6px; font-size:18px; line-height:1; border-radius:8px; }
    .project-head:hover .project-menu-button { opacity:1; }
    .project-menu-button:hover { background:#d3d2cd; }
    .project-menu { position:fixed; z-index:30; min-width:160px; background:#fff; border:1px solid #e5e7eb; border-radius:12px; box-shadow:0 16px 36px rgba(16,24,40,.18); padding:6px; }
    .project-menu-item { width:100%; border:0; background:#fff; color:#b42318; box-shadow:none; text-align:left; padding:9px 10px; border-radius:9px; font-size:13px; }
    .project-menu-item:hover { background:#fff1f2; }
    .session-row { display:flex; align-items:center; gap:10px; border-radius:14px; padding:9px 10px 9px 46px; cursor:pointer; color:#333; }
    .session-row:hover, .session-row.active { background:#dfded9; }
    .session-title { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:16px; }
    .session-time { color:#888; font-size:14px; white-space:nowrap; }
    .session-menu-button { opacity:0; border:0; background:transparent; color:#667085; box-shadow:none; padding:0 6px; font-size:18px; line-height:1; border-radius:8px; }
    .session-row:hover .session-menu-button { opacity:1; }
    .session-menu-button:hover { background:#d3d2cd; }
    .show-more { color:#858585; padding:8px 10px 4px 46px; cursor:pointer; font-size:14px; }
    .modal-backdrop { display:none; position:fixed; inset:0; background:rgba(17,24,39,.32); z-index:20; align-items:center; justify-content:center; padding:20px; }
    .modal-backdrop.visible { display:flex; }
    .folder-modal { width:min(760px, 94vw); height:min(620px, 82vh); background:#fff; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 24px 80px rgba(16,24,40,.28); display:flex; flex-direction:column; overflow:hidden; }
    .folder-modal-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px; border-bottom:1px solid #e5e7eb; }
    .folder-modal-head h2 { margin:0; font-size:17px; }
    .folder-close { background:#f2f4f7; color:#344054; padding:8px 10px; box-shadow:none; }
    .folder-path { padding:10px 16px; color:#667085; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; border-bottom:1px solid #f0f0f0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .folder-list { flex:1; overflow:auto; padding:8px; }
    .folder-row { display:flex; align-items:center; gap:10px; width:100%; border:0; background:#fff; color:#344054; box-shadow:none; padding:10px 12px; border-radius:10px; text-align:left; font-size:14px; }
    .folder-row:hover { background:#f2f4f7; }
    .folder-row.file { color:#98a2b3; cursor:default; }
    .folder-row.file:hover { background:#fff; }
    .folder-icon { width:20px; text-align:center; }
    .folder-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .folder-footer { display:flex; justify-content:flex-end; gap:10px; padding:12px 16px; border-top:1px solid #e5e7eb; }
    .folder-cancel { background:#f2f4f7; color:#344054; box-shadow:none; }
    .folder-select { background:var(--accent); color:#fff; }
    .search-modal { width:min(760px, 94vw); max-height:min(680px, 86vh); background:#fff; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 24px 80px rgba(16,24,40,.28); display:flex; flex-direction:column; overflow:hidden; }
    .search-modal-head { padding:14px 16px; border-bottom:1px solid #e5e7eb; display:flex; gap:12px; align-items:center; }
    .search-modal-head input { flex:1; border:0; outline:none; font-size:18px; color:#111827; padding:8px 2px; }
    .search-modal-head input::placeholder { color:#98a2b3; }
    .search-close { background:#f2f4f7; color:#344054; padding:8px 10px; box-shadow:none; }
    .search-results { overflow:auto; padding:8px; }
    .search-empty { color:#98a2b3; padding:28px 14px; text-align:center; }
    .search-section { color:#667085; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.06em; padding:12px 10px 6px; }
    .search-result { width:100%; display:flex; gap:10px; align-items:flex-start; border:0; background:#fff; color:#344054; box-shadow:none; text-align:left; border-radius:12px; padding:10px 12px; }
    .search-result:hover, .search-result.active { background:#f2f4f7; }
    .search-result-icon { width:20px; color:#667085; text-align:center; }
    .search-result-main { min-width:0; flex:1; }
    .search-result-title { font-size:14px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .search-result-sub { font-size:12px; color:#667085; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
    .mobile-sidebar-toggle { display:none; border:0; background:#f2f4f7; color:#344054; box-shadow:none; padding:7px 9px; border-radius:10px; }
    @media (max-width: 820px) {
      .app { grid-template-columns:minmax(0, 1fr); width:100%; max-width:100vw; overflow-x:hidden; }
      aside { transform:translateX(-100%); transition:transform .18s ease; z-index:40; box-shadow:none; }
      body.sidebar-open aside { transform:translateX(0); }
      body.sidebar-open::after { content:''; position:fixed; inset:0; background:rgba(17,24,39,.28); z-index:35; }
      .maincol { grid-column:1; min-width:0; max-width:100vw; overflow-x:hidden; }
      header { height:48px; left:0; padding:0 10px; }
      .mobile-sidebar-toggle { display:block; }
      h1 { font-size:14px; }
      .status-wrap { gap:6px; }
      .status { display:none; }
      .context-usage { font-size:11px; padding:3px 7px; max-width:180px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      main { width:100%; max-width:100vw; overflow-x:hidden; padding:60px 10px 118px; }
      .user { max-width:92%; padding:10px 12px; }
      .assistant { font-size:14px; padding-bottom:18px; }
      form { left:0; width:100vw; max-width:100vw; overflow-x:hidden; padding:10px 8px calc(10px + env(safe-area-inset-bottom)); }
      .composer-wrap { max-width:none; width:100%; min-width:0; }
      .composer-card { border-radius:18px; padding:8px; overflow:hidden; }
      .composer { width:100%; min-width:0; grid-template-columns:28px minmax(0, 1fr) 74px 32px; gap:6px; }
      textarea { grid-column:1 / -1; width:100%; min-width:0; box-sizing:border-box; min-height:34px; font-size:14px; padding:1px 2px 4px; }
      .model-select { grid-column:2; width:100%; min-width:0; max-width:100%; font-size:12px; }
      .thinking-select { grid-column:3; width:74px; font-size:12px; }
      .attach-button { grid-column:1; grid-row:2; width:28px; height:28px; }
      .mic-button { display:none; }
      #send { grid-column:4; grid-row:2; width:32px; height:32px; }
      .suggestions { left:0; right:0; bottom:112px; max-height:220px; }
      .message-queue { max-height:96px; overflow:auto; }
      .queue-item { padding:7px 9px; }
      .attachment-chip { max-width:100%; }
      .folder-modal, .search-modal, .agent-modal { width:100vw; height:100dvh; max-height:none; border-radius:0; }
      .agent-modal-body { grid-template-columns:1fr; }
      .modal-backdrop { padding:0; align-items:stretch; justify-content:stretch; }
      .search-modal-head input { font-size:16px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <button class="side-action" id="newChat"><span class="side-icon">✎</span><span>New chat</span></button>
      <button class="side-action" id="searchFocus"><span class="side-icon">⌕</span><span>Search</span></button>
      <button class="side-action" id="agentsNav"><span class="side-icon">◎</span><span>Agents</span></button>
      <button class="side-action" id="skillsNav"><span class="side-icon">✦</span><span>Skills</span></button>
      <button class="side-action" id="toolsNav"><span class="side-icon">⚙</span><span>Tools</span></button>
      <div class="sidebar-search" id="sidebarSearch"><input id="projectSearchInput" placeholder="Search projects and sessions…" /></div>
      <button class="side-action" id="addProject"><span class="side-icon">＋</span><span>Add project</span></button>
      <div class="projects-title">Projects</div>
      <div id="projects"></div>
    </aside>
    <div class="maincol">
      <header><button type="button" class="mobile-sidebar-toggle" id="mobileSidebarToggle">☰</button><h1>π Pi Web</h1><div class="status-wrap"><div class="context-usage" id="contextUsage">Context: --</div><div class="status" id="status">connecting…</div></div></header>
      <main id="log"><div class="msg system"><div class="meta">System</div>Pi web UI is ready. It talks to a headless <code>pi --mode rpc</code> process.</div></main>
      <main id="agentsPage" style="display:none"><div class="agents-container"><section class="agents-section"><h2>Built-in agents</h2><div class="agent-list"><div class="agent-card"><div class="agent-avatar">C</div><div class="agent-info"><div class="agent-name">Coding Agent</div><div class="agent-desc">General purpose coding assistant with project tools.</div></div></div><div class="agent-card"><div class="agent-avatar">R</div><div class="agent-info"><div class="agent-name">Review Agent</div><div class="agent-desc">Focused on reviewing code, diffs, and implementation quality.</div></div></div></div></section><section class="agents-section"><h2>Custom agents</h2><div class="agent-list" id="customAgentsList"></div><button type="button" class="agent-add" id="addCustomAgent">Add custom agent</button></section></div></main>
      <main id="skillsPage" style="display:none"><div class="agents-container"><section class="agents-section"><h2>Skills</h2><div class="agent-list" id="skillsList"><div class="agent-desc">Loading skills…</div></div><button type="button" class="agent-add" id="addSkill">Add skill</button></section></div></main>
      <main id="toolsPage" style="display:none"><div class="agents-container"><section class="agents-section"><h2>Tools</h2><div class="agent-list" id="toolsList"></div><button type="button" class="agent-add" id="addTool">Add tool</button></section></div></main>
      <form id="form"><div class="composer-wrap"><div class="suggestions" id="suggestions"></div><div class="message-queue" id="messageQueue"></div><div class="composer-card"><div class="attachment-preview" id="attachmentPreview"></div><div class="composer"><textarea id="input" placeholder="Ask for additional changes"></textarea><button type="button" class="attach-button" id="attachButton" title="Attach files">＋</button><input type="file" id="fileInput" multiple hidden><select class="model-select" id="modelSelect" title="Model"><option>Loading models…</option></select><select class="thinking-select" id="thinkingSelect" title="Reasoning"><option value="off">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option></select><button type="button" class="mic-button" id="micButton" title="Voice input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/></svg></button><button id="send" title="Send"><svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg><span class="stop-icon" aria-hidden="true"></span></button></div></div></div></form>
      <div class="modal-backdrop" id="folderModal"><div class="folder-modal"><div class="folder-modal-head"><h2>Add project</h2></div><div class="folder-path" id="folderPath"></div><div class="folder-list" id="folderList"></div><div class="folder-footer"><button type="button" class="folder-cancel" id="folderCancel">Cancel</button><button type="button" class="folder-select" id="folderSelect">Select folder</button></div></div></div>
      <div class="modal-backdrop" id="searchModal"><div class="search-modal"><div class="search-modal-head"><span>⌕</span><input id="searchModalInput" placeholder="Search projects and sessions…" autocomplete="off" /></div><div class="search-results" id="searchResults"></div></div></div>
      <div class="modal-backdrop" id="agentModal"><div class="agent-modal"><div class="folder-modal-head"><h2>Create custom agent</h2><button type="button" class="folder-close" id="agentCancel">Cancel</button></div><div class="agent-modal-body"><label class="agent-field"><span>Name</span><input id="agentNameInput" placeholder="e.g. Security reviewer" /></label><label class="agent-field"><span>Icon</span><div style="display:flex;align-items:center;gap:10px"><div class="agent-icon-preview" id="agentIconPreview">A</div><button type="button" class="folder-cancel" id="agentIconButton">Choose image</button><input type="file" id="agentIconInput" accept="image/*" hidden></div></label><label class="agent-enabled-row full"><input type="checkbox" id="agentEnabledInput" checked> Enabled</label><label class="agent-field full"><span>Short description</span><input id="agentDescriptionInput" placeholder="What this agent is for" /></label><label class="agent-field full"><span>System prompt</span><textarea id="agentSystemPromptInput" placeholder="Instructions this agent should follow"></textarea></label><label class="agent-field full"><span>Tools it has access to</span><div class="agent-picker" id="agentToolsPicker"></div></label><label class="agent-field full"><span>Skills it has access to</span><div class="agent-picker" id="agentSkillsPicker"></div></label></div><div class="folder-footer"><button type="button" class="folder-cancel" id="agentCancelFooter">Cancel</button><button type="button" class="folder-select" id="agentSave">Save agent</button></div></div></div>
      <div class="modal-backdrop" id="skillModal"><div class="agent-modal"><div class="folder-modal-head"><h2>Create skill</h2><button type="button" class="folder-close" id="skillCancel">Cancel</button></div><div class="agent-modal-body"><label class="agent-field full"><span>Name</span><input id="skillNameInput" placeholder="e.g. docs-search" /></label><label class="agent-field full"><span>Description</span><input id="skillDescriptionInput" placeholder="When this skill should be used" /></label><label class="agent-field full"><span>Content</span><textarea id="skillContentInput" style="min-height:260px" placeholder="Skill instructions, examples, and workflow"></textarea></label></div><div class="folder-footer"><button type="button" class="folder-cancel" id="skillCancelFooter">Cancel</button><button type="button" class="folder-select" id="skillSave">Save skill</button></div></div></div>
      <div class="modal-backdrop" id="toolModal"><div class="agent-modal"><div class="folder-modal-head"><h2>Create tool</h2><button type="button" class="folder-close" id="toolCancel">Cancel</button></div><div class="agent-modal-body"><label class="agent-field full"><span>Name</span><input id="toolNameInput" placeholder="e.g. database-query" /></label><label class="agent-field full"><span>Description</span><input id="toolDescriptionInput" placeholder="What this tool does" /></label><label class="agent-field full"><span>Content</span><textarea id="toolContentInput" style="min-height:260px" placeholder="Tool definition, input schema, behavior, notes..."></textarea></label></div><div class="folder-footer"><button type="button" class="folder-cancel" id="toolCancelFooter">Cancel</button><button type="button" class="folder-select" id="toolSave">Save tool</button></div></div></div>
    </div>
  </div>
<script type="module">
const mobileSidebarToggle = document.getElementById('mobileSidebarToggle');
const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const status = document.getElementById('status');
const contextUsage = document.getElementById('contextUsage');
const suggestions = document.getElementById('suggestions');
const attachmentPreview = document.getElementById('attachmentPreview');
const messageQueue = document.getElementById('messageQueue');
const attachButton = document.getElementById('attachButton');
const fileInput = document.getElementById('fileInput');
const micButton = document.getElementById('micButton');
const projectsEl = document.getElementById('projects');
const newChat = document.getElementById('newChat');
const searchFocus = document.getElementById('searchFocus');
const agentsNav = document.getElementById('agentsNav');
const skillsNav = document.getElementById('skillsNav');
const toolsNav = document.getElementById('toolsNav');
const addProject = document.getElementById('addProject');
const sidebarSearch = document.getElementById('sidebarSearch');
const projectSearchInput = document.getElementById('projectSearchInput');
const searchModal = document.getElementById('searchModal');
const searchModalInput = document.getElementById('searchModalInput');
const searchResults = document.getElementById('searchResults');
const folderModal = document.getElementById('folderModal');
const folderCancel = document.getElementById('folderCancel');
const folderSelect = document.getElementById('folderSelect');
const folderPath = document.getElementById('folderPath');
const folderList = document.getElementById('folderList');
const modelSelect = document.getElementById('modelSelect');
const thinkingSelect = document.getElementById('thinkingSelect');
const agentsPage = document.getElementById('agentsPage');
const skillsPage = document.getElementById('skillsPage');
const toolsPage = document.getElementById('toolsPage');
const toolsList = document.getElementById('toolsList');
const addTool = document.getElementById('addTool');
const skillsList = document.getElementById('skillsList');
const addSkill = document.getElementById('addSkill');
const customAgentsList = document.getElementById('customAgentsList');
const addCustomAgent = document.getElementById('addCustomAgent');
const agentModal = document.getElementById('agentModal');
const agentCancel = document.getElementById('agentCancel');
const agentCancelFooter = document.getElementById('agentCancelFooter');
const agentSave = document.getElementById('agentSave');
const agentNameInput = document.getElementById('agentNameInput');
const agentIconButton = document.getElementById('agentIconButton');
const agentIconInput = document.getElementById('agentIconInput');
const agentIconPreview = document.getElementById('agentIconPreview');
const agentEnabledInput = document.getElementById('agentEnabledInput');
const agentDescriptionInput = document.getElementById('agentDescriptionInput');
const agentSystemPromptInput = document.getElementById('agentSystemPromptInput');
const agentToolsPicker = document.getElementById('agentToolsPicker');
const agentSkillsPicker = document.getElementById('agentSkillsPicker');
const skillModal = document.getElementById('skillModal');
const skillCancel = document.getElementById('skillCancel');
const skillCancelFooter = document.getElementById('skillCancelFooter');
const skillSave = document.getElementById('skillSave');
const skillNameInput = document.getElementById('skillNameInput');
const skillDescriptionInput = document.getElementById('skillDescriptionInput');
const skillContentInput = document.getElementById('skillContentInput');
const toolModal = document.getElementById('toolModal');
const toolCancel = document.getElementById('toolCancel');
const toolCancelFooter = document.getElementById('toolCancelFooter');
const toolSave = document.getElementById('toolSave');
const toolNameInput = document.getElementById('toolNameInput');
const toolDescriptionInput = document.getElementById('toolDescriptionInput');
const toolContentInput = document.getElementById('toolContentInput');
let assistantEl = null;
let thinkingEl = null;
let activeTools = new Map();
let activeToolCalls = new Map();
let busy = false;
let awaitingAgent = false;
let commands = [];
let availableModels = [];
let currentState = null;
let sessionStats = null;
let selectedFiles = [];
let queuedMessages = [];
let sendingQueue = false;
let selectedSuggestion = 0;
let currentBrowsePath = '';
let knownProjectPaths = new Set();
let hiddenProjectPaths = new Set(JSON.parse(localStorage.getItem('piWebHiddenProjects') || '[]'));
let collapsedProjectPaths = new Set(JSON.parse(localStorage.getItem('piWebCollapsedProjects') || '[]'));
let projectIcons = JSON.parse(localStorage.getItem('piWebProjectIcons') || '{}');
let allProjects = [];
let projectSearchQuery = '';
let currentSessionPath = '';
let applyingRoute = false;
let customAgents = JSON.parse(localStorage.getItem('piWebCustomAgents') || '[]');
let skillsCache = [];
let editingSkill = null;
let customTools = JSON.parse(localStorage.getItem('piWebCustomTools') || '[]');
let editingTool = null;
const builtinTools = [
  { name: 'read', builtin: true, description: 'Read text files and images from the current machine.', content: 'Input: { path: string, offset?: number, limit?: number }\n\nReads file contents for inspection. Text output is truncated for very large files; images are attached for viewing.' },
  { name: 'bash', builtin: true, description: 'Execute shell commands in the current working directory.', content: 'Input: { command: string, timeout?: number }\n\nRuns bash commands for listing files, tests, builds, grep/ripgrep, and other development tasks.' },
  { name: 'edit', builtin: true, description: 'Edit a file with exact text replacements.', content: 'Input: { path: string, edits: [{ oldText: string, newText: string }] }\n\nApplies precise non-overlapping replacements. oldText must match exactly and uniquely.' },
  { name: 'write', builtin: true, description: 'Create or overwrite a file.', content: 'Input: { path: string, content: string }\n\nWrites complete file content and creates parent directories automatically.' }
];
let pendingAgentIcon = '';
let loadedConversationMessages = [];
let renderedMessageStart = 0;
const MESSAGE_CHUNK_SIZE = 30;
let touchStartX = 0;
let touchStartY = 0;
let searchResultItems = [];
let activeSearchIndex = 0;
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function add(kind, title, text='') {
  const el = document.createElement('div'); el.className = 'msg ' + kind;
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = title; el.appendChild(meta);
  const body = document.createElement('div'); body.className = 'body'; body.textContent = text; el.appendChild(body);
  log.appendChild(el); window.scrollTo(0, document.body.scrollHeight); return body;
}
function appendChatAttachments(body, attachments) {
  if (!attachments || attachments.length === 0) return;
  const wrap = document.createElement('div'); wrap.className = 'chat-attachments';
  for (const att of attachments) {
    const item = document.createElement('div'); item.className = 'chat-attachment';
    if (att.kind === 'image') {
      const img = document.createElement('img'); img.src = att.url || ('data:' + att.mimeType + ';base64,' + att.data); img.alt = att.name || 'attached image'; item.appendChild(img);
    } else {
      const file = document.createElement('div'); file.className = 'chat-file'; file.textContent = '📎 ' + (att.name || 'file') + (att.size ? ' · ' + formatBytes(att.size) : ''); item.appendChild(file);
    }
    wrap.appendChild(item);
  }
  body.parentElement.appendChild(wrap);
}
function renderQueue() {
  messageQueue.innerHTML = '';
  messageQueue.classList.toggle('visible', queuedMessages.length > 0);
  queuedMessages.forEach((item, index) => {
    const row = document.createElement('div'); row.className = 'queue-item';
    const label = document.createElement('div'); label.className = 'queue-label'; label.textContent = item.streamingBehavior === 'followUp' ? 'Follow-up' : 'Queued';
    const text = document.createElement('div'); text.className = 'queue-text'; text.textContent = item.originalMessage || item.message || '(attachments)';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'queue-remove'; remove.textContent = '×';
    remove.addEventListener('click', () => { queuedMessages.splice(index, 1); renderQueue(); });
    row.appendChild(label); row.appendChild(text); row.appendChild(remove); messageQueue.appendChild(row);
  });
}
function renderOutgoingPayload(payload) {
  if (payload.silentInChat || payload.renderedInChat) return;
  const userBody = add('user', 'You', payload.originalMessage || payload.message || '');
  appendChatAttachments(userBody, payload.previews);
  payload.renderedInChat = true;
}
async function postPromptPayload(payload, streamingBehavior) {
  const res = await fetch('/api/prompt', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ ...payload, streamingBehavior }) });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}
function markRequestActive() {
  awaitingAgent = true;
  busy = true;
  send.classList.add('generating');
  updateSendButtonState();
  send.title = 'Stop';
  status.textContent = 'queued/running…';
}
async function sendQueuedOrDirect(payload) {
  renderOutgoingPayload(payload);
  markRequestActive();
  try {
    const response = await postPromptPayload(payload, undefined);
    if (response && response.command !== 'prompt') {
      awaitingAgent = false;
      busy = false;
      finishAssistantSpinner();
      send.classList.remove('generating');
      updateSendButtonState();
      send.title = 'Send';
      status.textContent = 'ready';
      if (response.command === 'compact') { await loadState(); const messages = await loadMessages(); setEstimatedContextFromMessages(messages); await loadState(); }
      drainQueue();
    }
  } catch (error) {
    awaitingAgent = false;
    busy = false;
    send.classList.remove('generating');
    updateSendButtonState();
    send.title = 'Send';
    throw error;
  }
}
async function drainQueue() {
  if (sendingQueue || busy || awaitingAgent || queuedMessages.length === 0) return;
  sendingQueue = true;
  try {
    const item = queuedMessages.shift();
    renderQueue();
    await sendQueuedOrDirect(item);
  } catch (err) {
    showEvent(String(err), null, 'tool error');
  } finally {
    sendingQueue = false;
  }
}
function ensureAssistantMessage() {
  if (assistantEl) return assistantEl;
  assistantEl = add('assistant generating', 'Assistant', '');
  const spinner = document.createElement('div'); spinner.className = 'assistant-spinner';
  assistantEl.parentElement.appendChild(spinner);
  return assistantEl;
}
function appendAssistant(delta) {
  ensureAssistantMessage().textContent += delta; window.scrollTo(0, document.body.scrollHeight);
}
function finishAssistantSpinner() {
  document.querySelectorAll('.assistant.generating').forEach(el => el.classList.remove('generating'));
}
function appendThinking(delta) {
  if (!thinkingEl) thinkingEl = add('tool thinking', 'Thinking', '');
  thinkingEl.textContent += delta; window.scrollTo(0, document.body.scrollHeight);
}
function pretty(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
function contentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part && (part.text || part.content || pretty(part))).filter(Boolean).join('\n');
  return pretty(content);
}
function toolResultText(result) {
  if (!result) return '';
  if (result.content) return contentText(result.content);
  if (result.output) return result.output;
  return pretty(result);
}
function baseName(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || String(filePath || 'file');
}
function formatToolTitle(name, args) {
  if (!args || typeof args !== 'object') return name;
  if (name === 'bash' && args.command) return String(args.command);
  if (name === 'read' && args.path) return 'Read ' + baseName(args.path);
  if (name === 'edit') return 'Edit';
  if (name === 'write' && args.path) return 'Write ' + baseName(args.path);
  if ((name === 'grep' || name === 'find' || name === 'ls') && (args.path || args.pattern)) return name + ' ' + (args.path || args.pattern);
  return name;
}
function renderDiff(output, args) {
  output.className = 'diff';
  output.style.display = 'block';
  output.innerHTML = '';
  const file = document.createElement('div'); file.className = 'diff-file'; file.textContent = args && args.path ? args.path : 'Edit'; output.appendChild(file);
  const edits = Array.isArray(args && args.edits) ? args.edits : [];
  for (const edit of edits) {
    const oldLines = String(edit.oldText || '').split('\n');
    const newLines = String(edit.newText || '').split('\n');
    for (const line of oldLines) { const div = document.createElement('div'); div.className = 'diff-line del'; div.textContent = '- ' + line; output.appendChild(div); }
    for (const line of newLines) { const div = document.createElement('div'); div.className = 'diff-line add'; div.textContent = '+ ' + line; output.appendChild(div); }
  }
}
function createToolBlock(id, title, args, toolName) {
  if (toolName === 'bash' && String(title).length > 120) {
    const details = document.createElement('details'); details.className = 'tool-details command-details';
    const summary = document.createElement('summary'); summary.textContent = String(title).slice(0, 120) + '…';
    const output = document.createElement('div'); output.className = 'tool-output'; output.textContent = title; output.style.display = 'block';
    details.appendChild(summary); details.appendChild(output); log.appendChild(details);
    const block = { wrapper: details, icon: null, label: summary, output, args, toolName };
    activeTools.set(id, block); window.scrollTo(0, document.body.scrollHeight); return block;
  }
  if (toolName === 'read') {
    const details = document.createElement('details'); details.className = 'tool-details';
    const summary = document.createElement('summary'); summary.textContent = title;
    const output = document.createElement('div'); output.className = 'tool-output'; output.style.display = 'none';
    details.appendChild(summary); details.appendChild(output); log.appendChild(details);
    const block = { wrapper: details, icon: null, label: summary, output, args, toolName };
    activeTools.set(id, block); window.scrollTo(0, document.body.scrollHeight); return block;
  }
  const wrapper = document.createElement('div'); wrapper.className = 'tool-line running';
  const icon = document.createElement('span'); icon.className = 'tool-icon'; icon.textContent = '◌';
  const label = document.createElement('span'); label.textContent = title;
  wrapper.appendChild(icon); wrapper.appendChild(label); log.appendChild(wrapper);
  const output = document.createElement('div'); output.className = 'tool-output'; output.style.display = 'none';
  if (toolName === 'edit') renderDiff(output, args);
  const block = { wrapper, icon, label, output, args, toolName };
  activeTools.set(id, block);
  window.scrollTo(0, document.body.scrollHeight);
  return block;
}
function updateToolBlock(id, text, done=false, error=false) {
  const block = activeTools.get(id);
  if (!block) return;
  if (text && block.toolName !== 'bash' && block.toolName !== 'edit') { block.output.textContent = text; block.output.style.display = 'block'; }
  if (done) {
    block.wrapper.classList.remove('running');
    if (block.icon) block.icon.textContent = error ? '✕' : '✓';
    else if (block.toolName === 'bash') block.label.textContent = (error ? '✕ ' : '✓ ') + block.label.textContent;
    if (error) block.wrapper.classList.add('error');
    activeTools.delete(id);
  }
  window.scrollTo(0, document.body.scrollHeight);
}
function showEvent(title, data, kind='tool') {
  const row = document.createElement('div'); row.className = kind.includes('error') ? 'tool-line error' : 'tool-line';
  const icon = document.createElement('span'); icon.className = 'tool-icon'; icon.textContent = kind.includes('error') ? '✕' : '•';
  const label = document.createElement('span'); label.textContent = title;
  row.appendChild(icon); row.appendChild(label); log.appendChild(row);
  if (data !== undefined && data !== null && typeof data !== 'string') {
    const output = document.createElement('div'); output.className = 'tool-output'; output.textContent = pretty(data); log.appendChild(output);
  }
}
function handleAssistantDelta(d) {
  if (d.type === 'text_delta') appendAssistant(d.delta || '');
  else if (d.type === 'thinking_delta') appendThinking(d.delta || '');
  else if (d.type === 'thinking_start') thinkingEl = add('tool thinking', 'Thinking', '');
  else if (d.type === 'thinking_end') thinkingEl = null;
  else if (d.type === 'toolcall_start' || d.type === 'toolcall_delta' || d.type === 'toolcall_end') {
    // Tool execution events provide cleaner, CLI-like rendering. Ignore raw tool-call deltas.
  } else if (d.type === 'error') {
    showEvent('Assistant error', d, 'tool error');
  }
}
function handleToolEvent(e) {
  const id = e.toolCallId || e.id || (e.toolName + '-' + activeTools.size);
  if (e.type === 'tool_execution_start') {
    finishAssistantSpinner();
    assistantEl = null;
    thinkingEl = null;
    createToolBlock(id, formatToolTitle(e.toolName, e.args), e.args || {}, e.toolName);
  } else if (e.type === 'tool_execution_update') {
    updateToolBlock(id, toolResultText(e.partialResult) || pretty(e));
  } else if (e.type === 'tool_execution_end') {
    updateToolBlock(id, toolResultText(e.result) || pretty(e.result || e), true, e.error || e.isError);
  }
}
function summarizeTool(e) {
  if (e.type === 'rpc_stderr') return e.line;
  if (e.type === 'rpc_exit') return 'RPC exited code=' + e.code + ' signal=' + e.signal;
  if (e.type === 'queue_update') return 'Steering: ' + (e.steering || []).length + ', follow-up: ' + (e.followUp || []).length;
  if (e.type === 'compaction_start') return 'Compaction started: ' + (e.reason || 'manual');
  if (e.type === 'compaction_end') return 'Compaction finished: ' + (e.reason || 'manual');
  if (e.type === 'auto_retry_start') return 'Auto-retry started';
  if (e.type === 'auto_retry_end') return 'Auto-retry finished';
  if (e.type === 'extension_error') return pretty(e);
  return null;
}
async function loadCommands() {
  try {
    const res = await fetch('/api/commands');
    const json = await res.json();
    commands = (json.data && json.data.commands ? json.data.commands : []).map(c => ({ ...c, slash: '/' + c.name }));
  } catch {}
}
function currentSlashToken() {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const match = before.match(/(^|\s)(\/[\w:-]*)$/);
  return match ? match[2] : null;
}
function renderSuggestions() {
  const token = currentSlashToken();
  if (!token) { suggestions.classList.remove('visible'); suggestions.innerHTML = ''; return; }
  const q = token.slice(1).toLowerCase();
  const matches = commands.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
  if (matches.length === 0) { suggestions.classList.remove('visible'); suggestions.innerHTML = ''; return; }
  selectedSuggestion = Math.min(selectedSuggestion, matches.length - 1);
  suggestions.innerHTML = '';
  matches.forEach((cmd, i) => {
    const row = document.createElement('div'); row.className = 'suggestion' + (i === selectedSuggestion ? ' active' : '');
    row.innerHTML = '<div class="suggestion-name"></div><div class="suggestion-desc"></div>';
    row.querySelector('.suggestion-name').textContent = cmd.slash;
    row.querySelector('.suggestion-desc').textContent = cmd.description || cmd.source || '';
    row.addEventListener('mousedown', ev => { ev.preventDefault(); applySuggestion(cmd.slash); });
    suggestions.appendChild(row);
  });
  suggestions.classList.add('visible');
}
function updateSendButtonState() {
  send.classList.toggle('active', input.value.trim().length > 0 || selectedFiles.length > 0 || busy || awaitingAgent);
}
function updateMainBottomPadding() {
  const formHeight = form.getBoundingClientRect().height;
  const extra = window.matchMedia('(max-width: 820px)').matches ? 14 : 18;
  log.style.paddingBottom = Math.ceil(formHeight + extra) + 'px';
}
function autoResizeInput() {
  input.style.height = 'auto';
  const max = window.matchMedia('(max-width: 820px)').matches ? 130 : 160;
  const next = Math.min(input.scrollHeight, max);
  input.style.height = next + 'px';
  input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden';
  updateMainBottomPadding();
}
function renderAttachmentPreview() {
  attachmentPreview.innerHTML = '';
  attachmentPreview.classList.toggle('visible', selectedFiles.length > 0);
  updateSendButtonState();
  requestAnimationFrame(updateMainBottomPadding);
  selectedFiles.forEach((file, index) => {
    const chip = document.createElement('div'); chip.className = 'attachment-chip';
    if (file.type.startsWith('image/')) {
      const img = document.createElement('img'); img.src = URL.createObjectURL(file); img.onload = () => URL.revokeObjectURL(img.src); chip.appendChild(img);
    } else {
      const icon = document.createElement('div'); icon.className = 'attachment-icon'; icon.textContent = 'FILE'; chip.appendChild(icon);
    }
    const info = document.createElement('div'); info.className = 'attachment-info';
    const name = document.createElement('div'); name.className = 'attachment-name'; name.textContent = file.name;
    const meta = document.createElement('div'); meta.className = 'attachment-meta'; meta.textContent = (file.type || 'file') + ' · ' + formatBytes(file.size);
    info.appendChild(name); info.appendChild(meta); chip.appendChild(info);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×';
    remove.addEventListener('click', () => { selectedFiles.splice(index, 1); renderAttachmentPreview(); });
    chip.appendChild(remove); attachmentPreview.appendChild(chip);
  });
}
function readAsDataURL(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
}
function readAsText(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(file); });
}
async function buildPromptWithAttachments(message) {
  const images = [];
  const textParts = [];
  const previews = [];
  for (const file of selectedFiles) {
    if (file.type.startsWith('image/')) {
      const dataUrl = await readAsDataURL(file);
      const data = dataUrl.split(',')[1] || '';
      images.push({ type: 'image', data, mimeType: file.type });
      previews.push({ kind: 'image', name: file.name, size: file.size, mimeType: file.type, url: dataUrl });
    } else if (file.type.startsWith('text/') || /\.(md|txt|json|js|ts|tsx|jsx|css|html|py|go|rs|java|c|cpp|h|hpp|yaml|yml|toml|xml|csv)$/i.test(file.name)) {
      const text = await readAsText(file);
      textParts.push('Attached file: ' + file.name + '\n~~~\n' + text.slice(0, 200000) + '\n~~~');
      previews.push({ kind: 'file', name: file.name, size: file.size, mimeType: file.type });
    } else {
      textParts.push('Attached file: ' + file.name + ' (' + (file.type || 'unknown type') + ', ' + formatBytes(file.size) + '). Binary content was not included.');
      previews.push({ kind: 'file', name: file.name, size: file.size, mimeType: file.type });
    }
  }
  return { message: [message, ...textParts].filter(Boolean).join('\n\n'), images, previews };
}
function applySuggestion(slash) {
  const start = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(input.selectionEnd ?? start);
  const replaced = before.replace(/(^|\s)(\/[\w:-]*)$/, '$1' + slash + ' ');
  input.value = replaced + after;
  const pos = replaced.length;
  input.setSelectionRange(pos, pos);
  suggestions.classList.remove('visible');
  input.focus();
}
function formatK(tokens) {
  if (tokens === undefined || tokens === null || Number.isNaN(Number(tokens))) return '--';
  return Math.round(Number(tokens) / 1000) + 'K';
}
function estimateMessageTokens(message) {
  let chars = 0;
  const addContent = (content) => {
    if (!content) return;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part) continue;
        if (part.type === 'image') chars += 4800;
        else chars += (part.text || part.content || part.thinking || JSON.stringify(part)).length;
      }
    } else chars += JSON.stringify(content).length;
  };
  addContent(message.content);
  if (message.command) chars += String(message.command).length;
  if (message.output) chars += String(message.output).length;
  if (message.summary) chars += String(message.summary).length;
  return Math.ceil(chars / 4);
}
function setEstimatedContextFromMessages(messages) {
  const tokens = (messages || []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const contextWindow = (currentState && currentState.model && currentState.model.contextWindow) || (sessionStats && sessionStats.contextUsage && sessionStats.contextUsage.contextWindow) || (sessionStats && sessionStats.estimatedContextUsage && sessionStats.estimatedContextUsage.contextWindow) || null;
  sessionStats = sessionStats || {};
  sessionStats.estimatedContextUsage = { tokens, contextWindow, percent: contextWindow ? (tokens / contextWindow) * 100 : null };
  updateContextUsage();
}
function updateContextUsage() {
  const usage = (currentState && currentState.contextUsage) || (sessionStats && sessionStats.contextUsage);
  const estimated = sessionStats && sessionStats.estimatedContextUsage;
  const effective = usage && usage.tokens ? usage : estimated;
  if (!effective || effective.tokens === undefined || effective.contextWindow === undefined || effective.tokens === null || effective.contextWindow === null) {
    contextUsage.textContent = 'Context: waiting for usage';
    return;
  }
  const used = Number(effective.tokens);
  const total = Number(effective.contextWindow);
  const left = Math.max(0, total - used);
  const pct = effective.percent !== undefined && effective.percent !== null ? Math.round(Number(effective.percent)) : (total > 0 ? Math.round((used / total) * 100) : 0);
  contextUsage.textContent = 'Context: ' + formatK(used) + ' used · ' + formatK(left) + ' left · ' + pct + '%';
}
function modelDisplayName(model) {
  return model && (model.name || model.id) || 'No model';
}
function modelKey(model) {
  return ((model && model.provider) || '') + '::' + ((model && model.id) || '');
}
function updateModelControls() {
  const model = currentState && currentState.model;
  if (model) modelSelect.value = modelKey(model);
  if (currentState && currentState.thinkingLevel) thinkingSelect.value = currentState.thinkingLevel;
}
async function loadState() {
  try {
    const res = await fetch('/api/state');
    const json = await res.json();
    currentState = json.data || null;
  } catch {}
  try {
    const statsRes = await fetch('/api/stats');
    const statsJson = await statsRes.json();
    sessionStats = statsJson.data || null;
  } catch {}
  updateModelControls();
  updateContextUsage();
}
async function loadAvailableModels() {
  try {
    const res = await fetch('/api/models');
    const json = await res.json();
    availableModels = json.data && json.data.models ? json.data.models : [];
    renderModelSelect();
  } catch { availableModels = []; }
}
function renderModelSelect() {
  const groups = new Map();
  for (const model of availableModels) {
    const provider = model.provider || 'unknown';
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }
  modelSelect.innerHTML = '';
  const providers = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const provider of providers) {
    const group = document.createElement('optgroup');
    group.label = provider;
    const models = groups.get(provider).sort((a, b) => modelDisplayName(a).localeCompare(modelDisplayName(b)));
    for (const model of models) {
      const option = document.createElement('option');
      option.value = modelKey(model);
      option.textContent = modelDisplayName(model);
      option.title = (model.provider || '') + '/' + (model.id || '');
      group.appendChild(option);
    }
    modelSelect.appendChild(group);
  }
  updateModelControls();
}
function shortPath(cwd) {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd || 'Unknown';
}
function relTime(value) {
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minute = 60000, hour = 60 * minute, day = 24 * hour, week = 7 * day, month = 30 * day;
  if (diff < hour) return Math.max(1, Math.floor(diff / minute)) + ' m';
  if (diff < day) return Math.floor(diff / hour) + ' h';
  if (diff < week) return Math.floor(diff / day) + ' d';
  if (diff < month) return Math.floor(diff / week) + ' w';
  return Math.floor(diff / month) + ' m';
}
function sessionTitle(session) {
  return session.name || session.firstMessage || '(no messages)';
}
function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part && (part.text || part.content || '')).filter(Boolean).join('\\n');
  return '';
}
function slugPart(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}
function hashString(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
function projectRouteId(project) {
  const cwd = typeof project === 'string' ? project : (project && project.cwd) || '';
  return slugPart(shortPath(cwd)) + '-' + hashString(cwd);
}
function conversationRouteId(session) {
  return slugPart((session && session.id) || baseName(session && session.path));
}
function sessionRoute(project, session) {
  return '/' + projectRouteId(project || (session && session.cwd)) + '/' + conversationRouteId(session);
}
function setRoute(path, replace=false) {
  if (applyingRoute || !path || location.pathname === path) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
}
function routeInfo(pathname=location.pathname) {
  const segments = pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  if (segments.length === 0) return { page: 'chat' };
  if (segments[0] === 'skills') return { page: 'skills' };
  if (segments[0] === 'tools') return { page: 'tools' };
  if (segments[0] === 'agents') return { page: 'agents' };
  if (segments.length >= 2) return { page: 'conversation', projectId: segments[0], conversationId: segments[1] };
  return { page: 'chat' };
}
function findProjectForSession(session) {
  return allProjects.find(project => project.sessions.some(item => item.path === session.path || item.id === session.id)) || (session && session.cwd ? { cwd: session.cwd, sessions: [session] } : null);
}
function setActiveSessionRow(sessionPath) {
  document.querySelectorAll('.session-row.active').forEach(el => el.classList.remove('active'));
  if (!sessionPath) return;
  document.querySelectorAll('.session-row').forEach(el => { if (el.dataset.path === sessionPath) el.classList.add('active'); });
}
async function openSession(session, project=null, updateUrl=true) {
  if (!session || !session.path) return;
  document.body.classList.remove('sidebar-open');
  showChatPage();
  const owningProject = project || findProjectForSession(session);
  if (updateUrl) setRoute(sessionRoute(owningProject, session));
  if (currentSessionPath === session.path) { setActiveSessionRow(session.path); return; }
  status.textContent = 'switching session…';
  const res = await fetch('/api/switch-session', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionPath: session.path }) });
  if (!res.ok) { add('tool error', 'Session error', await res.text()); status.textContent = 'ready'; return; }
  currentSessionPath = session.path;
  setActiveSessionRow(session.path);
  await loadMessages();
  await loadState();
  status.textContent = 'ready';
}
async function applyRoute() {
  const route = routeInfo();
  applyingRoute = true;
  try {
    if (route.page === 'skills') { showSkillsPage(); return true; }
    if (route.page === 'tools') { showToolsPage(); return true; }
    if (route.page === 'agents') { showAgentsPage(); return true; }
    if (route.page === 'conversation') {
      if (allProjects.length === 0) return false;
      const project = allProjects.find(item => projectRouteId(item) === route.projectId);
      const session = project && project.sessions.find(item => conversationRouteId(item) === route.conversationId || item.id === route.conversationId);
      if (!project || !session) { showChatPage(); return false; }
      if (collapsedProjectPaths.has(project.cwd)) {
        collapsedProjectPaths.delete(project.cwd);
        localStorage.setItem('piWebCollapsedProjects', JSON.stringify([...collapsedProjectPaths]));
        renderProjects();
      }
      await openSession(session, project, false);
      return true;
    }
    showChatPage();
    return true;
  } finally {
    applyingRoute = false;
  }
}
function showChatPage() {
  log.style.display = '';
  agentsPage.style.display = 'none';
  skillsPage.style.display = 'none';
  toolsPage.style.display = 'none';
  form.style.display = '';
}
function agentListText(values) {
  return Array.isArray(values) && values.length ? values.join(', ') : 'None selected';
}
function splitAgentList(value) {
  return String(value || '').split(',').map(v => v.trim()).filter(Boolean);
}
function selectedPickerValues(container) {
  return Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
}
function renderAgentPicker(container, items, selected=[]) {
  const selectedSet = new Set(selected || []);
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="agent-desc">No items available.</div>';
    return;
  }
  for (const item of items) {
    const row = document.createElement('label'); row.className = 'agent-picker-row';
    row.innerHTML = '<input type="checkbox"><div><div class="agent-picker-name"></div><div class="agent-picker-desc"></div></div>';
    const checkbox = row.querySelector('input');
    checkbox.value = item.name;
    checkbox.checked = selectedSet.has(item.name);
    row.querySelector('.agent-picker-name').textContent = item.name;
    row.querySelector('.agent-picker-desc').textContent = item.description || '';
    container.appendChild(row);
  }
}
function saveCustomAgents() {
  localStorage.setItem('piWebCustomAgents', JSON.stringify(customAgents));
}
function renderAgentAvatar(container, agent) {
  container.innerHTML = '';
  if (agent.icon) {
    const img = document.createElement('img'); img.src = agent.icon; img.alt = '';
    container.appendChild(img);
  } else {
    container.textContent = (agent.name || 'A').slice(0, 1).toUpperCase();
  }
}
function renderCustomAgents() {
  customAgentsList.innerHTML = '';
  if (customAgents.length === 0) {
    customAgentsList.innerHTML = '<div class="agent-desc">No custom agents yet.</div>';
  }
  for (const agent of customAgents) {
    const card = document.createElement('div'); card.className = 'agent-card';
    card.innerHTML = '<div class="agent-avatar"></div><div class="agent-info"><div class="agent-name"><span class="agent-name-text"></span><span class="agent-status"></span></div><div class="agent-desc"></div><div class="agent-meta"></div><div class="skill-actions"><button type="button" class="skill-action agent-delete">Delete</button></div></div>';
    renderAgentAvatar(card.querySelector('.agent-avatar'), agent);
    card.querySelector('.agent-name-text').textContent = agent.name || 'Untitled agent';
    const badge = card.querySelector('.agent-status');
    badge.textContent = agent.enabled === false ? 'Disabled' : 'Enabled';
    badge.classList.toggle('disabled', agent.enabled === false);
    card.querySelector('.agent-desc').textContent = agent.description || 'Custom agent';
    card.querySelector('.agent-meta').textContent = 'Tools: ' + agentListText(agent.tools) + ' · Skills: ' + agentListText(agent.skills);
    card.querySelector('.agent-delete').addEventListener('click', () => {
      if (!confirm('Delete agent "' + (agent.name || 'Untitled agent') + '"?')) return;
      customAgents = customAgents.filter(item => item !== agent && item.id !== agent.id);
      saveCustomAgents();
      renderCustomAgents();
    });
    customAgentsList.appendChild(card);
  }
}
function updateAgentIconPreview() {
  agentIconPreview.innerHTML = '';
  if (pendingAgentIcon) {
    const img = document.createElement('img'); img.src = pendingAgentIcon; img.alt = '';
    agentIconPreview.appendChild(img);
  } else {
    agentIconPreview.textContent = (agentNameInput.value || 'A').slice(0, 1).toUpperCase();
  }
}
async function showAgentModal() {
  pendingAgentIcon = '';
  agentNameInput.value = '';
  agentEnabledInput.checked = true;
  agentDescriptionInput.value = '';
  agentSystemPromptInput.value = '';
  renderAgentPicker(agentToolsPicker, toolList(), []);
  if (skillsCache.length === 0) {
    try { const res = await fetch('/api/skills'); const json = await res.json(); skillsCache = json.skills || []; } catch {}
  }
  renderAgentPicker(agentSkillsPicker, skillsCache, []);
  updateAgentIconPreview();
  closeAllModals();
  agentModal.classList.add('visible');
  setTimeout(() => agentNameInput.focus(), 0);
}
function hideAgentModal() { agentModal.classList.remove('visible'); }
function saveAgentFromModal() {
  const name = agentNameInput.value.trim();
  if (!name) { agentNameInput.focus(); return; }
  customAgents.push({
    id: 'agent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
    name,
    icon: pendingAgentIcon,
    enabled: agentEnabledInput.checked,
    description: agentDescriptionInput.value.trim(),
    systemPrompt: agentSystemPromptInput.value.trim(),
    tools: selectedPickerValues(agentToolsPicker),
    skills: selectedPickerValues(agentSkillsPicker),
    createdAt: new Date().toISOString()
  });
  saveCustomAgents();
  hideAgentModal();
  renderCustomAgents();
}
function showAgentsPage() {
  setRoute('/agents');
  document.body.classList.remove('sidebar-open');
  renderCustomAgents();
  log.style.display = 'none';
  agentsPage.style.display = '';
  skillsPage.style.display = 'none';
  toolsPage.style.display = 'none';
  form.style.display = 'none';
}
function renderSkills() {
  skillsList.innerHTML = '';
  if (skillsCache.length === 0) {
    skillsList.innerHTML = '<div class="agent-desc">No skills found.</div>';
    return;
  }
  for (const skill of skillsCache) {
    const card = document.createElement('div'); card.className = 'agent-card'; card.style.alignItems = 'flex-start';
    card.innerHTML = '<div class="agent-avatar">✦</div><div class="agent-info"><div class="agent-name"></div><div class="agent-desc"></div><div class="agent-meta"></div><div class="skill-actions"><button type="button" class="skill-action skill-toggle">Expand</button><button type="button" class="skill-action skill-edit">Edit</button><button type="button" class="skill-action skill-delete">Delete</button></div><pre class="skill-content"></pre></div>';
    card.querySelector('.agent-name').textContent = skill.name || 'Untitled skill';
    card.querySelector('.agent-desc').textContent = skill.description || 'No description';
    card.querySelector('.agent-meta').textContent = skill.path || '';
    const content = card.querySelector('.skill-content');
    content.textContent = skill.content || '';
    const toggle = card.querySelector('.skill-toggle');
    toggle.addEventListener('click', () => {
      content.classList.toggle('visible');
      toggle.textContent = content.classList.contains('visible') ? 'Collapse' : 'Expand';
    });
    card.querySelector('.skill-edit').addEventListener('click', () => showSkillModal(skill));
    card.querySelector('.skill-delete').addEventListener('click', async () => {
      if (!confirm('Delete skill "' + (skill.name || 'Untitled skill') + '"?')) return;
      const res = await fetch('/api/skills', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ path: skill.path }) });
      if (!res.ok) { alert(await res.text()); return; }
      await loadSkills();
    });
    skillsList.appendChild(card);
  }
}
async function loadSkills() {
  skillsList.innerHTML = '<div class="agent-desc">Loading skills…</div>';
  try {
    const res = await fetch('/api/skills');
    const json = await res.json();
    skillsCache = json.skills || [];
    renderSkills();
  } catch (err) {
    skillsList.innerHTML = '<div class="agent-desc">Failed to load skills.</div>';
  }
}
function showSkillModal(skill=null) {
  editingSkill = skill;
  skillNameInput.value = skill ? (skill.name || '') : '';
  skillNameInput.disabled = !!skill;
  skillDescriptionInput.value = skill ? (skill.description || '') : '';
  skillContentInput.value = skill ? (skill.content || '') : '';
  skillModal.querySelector('h2').textContent = skill ? 'Edit skill' : 'Create skill';
  closeAllModals();
  skillModal.classList.add('visible');
  setTimeout(() => (skill ? skillContentInput : skillNameInput).focus(), 0);
}
function hideSkillModal() { skillModal.classList.remove('visible'); editingSkill = null; skillNameInput.disabled = false; }
async function saveSkillFromModal() {
  const name = skillNameInput.value.trim();
  const description = skillDescriptionInput.value.trim();
  let content = skillContentInput.value.trim();
  if (!name) { skillNameInput.focus(); return; }
  if (!description) { skillDescriptionInput.focus(); return; }
  if (!content) { skillContentInput.focus(); return; }
  if (!editingSkill) {
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    content = '---\nname: ' + slug + '\ndescription: ' + description.replace(/\r?\n/g, ' ') + '\n---\n\n# ' + name + '\n\n' + content;
  }
  const res = await fetch('/api/skills', { method: editingSkill ? 'PUT' : 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name, description, content, path: editingSkill && editingSkill.path }) });
  if (!res.ok) { alert(await res.text()); return; }
  hideSkillModal();
  await loadSkills();
}
function showSkillsPage() {
  setRoute('/skills');
  document.body.classList.remove('sidebar-open');
  log.style.display = 'none';
  agentsPage.style.display = 'none';
  skillsPage.style.display = '';
  toolsPage.style.display = 'none';
  form.style.display = 'none';
  loadSkills();
}
function toolList() { return [...builtinTools, ...customTools]; }
function saveCustomTools() { localStorage.setItem('piWebCustomTools', JSON.stringify(customTools)); }
function renderTools() {
  toolsList.innerHTML = '';
  const tools = toolList();
  if (tools.length === 0) { toolsList.innerHTML = '<div class="agent-desc">No tools yet.</div>'; return; }
  for (const tool of tools) {
    const card = document.createElement('div'); card.className = 'agent-card'; card.style.alignItems = 'flex-start';
    card.innerHTML = '<div class="agent-avatar">⚙</div><div class="agent-info"><div class="agent-name"><span class="tool-name-text"></span><span class="agent-status"></span></div><div class="agent-desc"></div><div class="skill-actions"><button type="button" class="skill-action tool-toggle">Expand</button><button type="button" class="skill-action tool-edit">Edit</button><button type="button" class="skill-action tool-delete">Delete</button></div><pre class="skill-content"></pre></div>';
    card.querySelector('.tool-name-text').textContent = tool.name || 'Untitled tool';
    const badge = card.querySelector('.agent-status'); badge.textContent = tool.builtin ? 'Built-in' : 'Custom'; badge.classList.toggle('disabled', !tool.builtin);
    card.querySelector('.agent-desc').textContent = tool.description || 'No description';
    const content = card.querySelector('.skill-content'); content.textContent = tool.content || '';
    const toggle = card.querySelector('.tool-toggle');
    toggle.addEventListener('click', () => { content.classList.toggle('visible'); toggle.textContent = content.classList.contains('visible') ? 'Collapse' : 'Expand'; });
    const edit = card.querySelector('.tool-edit');
    const del = card.querySelector('.tool-delete');
    if (tool.builtin) {
      edit.disabled = true; edit.title = 'Built-in tools cannot be edited here';
      del.disabled = true; del.title = 'Built-in tools cannot be deleted';
    } else {
      edit.addEventListener('click', () => showToolModal(tool));
      del.addEventListener('click', () => {
        if (!confirm('Delete tool "' + (tool.name || 'Untitled tool') + '"?')) return;
        customTools = customTools.filter(item => item !== tool && item.id !== tool.id);
        saveCustomTools();
        renderTools();
      });
    }
    toolsList.appendChild(card);
  }
}
function showToolModal(tool=null) {
  editingTool = tool;
  toolNameInput.value = tool ? (tool.name || '') : '';
  toolNameInput.disabled = !!tool;
  toolDescriptionInput.value = tool ? (tool.description || '') : '';
  toolContentInput.value = tool ? (tool.content || '') : '';
  toolModal.querySelector('h2').textContent = tool ? 'Edit tool' : 'Create tool';
  closeAllModals();
  toolModal.classList.add('visible');
  setTimeout(() => (tool ? toolContentInput : toolNameInput).focus(), 0);
}
function hideToolModal() { toolModal.classList.remove('visible'); editingTool = null; toolNameInput.disabled = false; }
function saveToolFromModal() {
  const name = toolNameInput.value.trim();
  const description = toolDescriptionInput.value.trim();
  const content = toolContentInput.value.trim();
  if (!name) { toolNameInput.focus(); return; }
  if (!description) { toolDescriptionInput.focus(); return; }
  if (!content) { toolContentInput.focus(); return; }
  if (editingTool) {
    Object.assign(editingTool, { description, content, updatedAt: new Date().toISOString() });
  } else {
    const exists = toolList().some(t => String(t.name).toLowerCase() === name.toLowerCase());
    if (exists) { alert('A tool with this name already exists.'); return; }
    customTools.push({ id: 'tool-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2), name, description, content, createdAt: new Date().toISOString() });
  }
  saveCustomTools(); hideToolModal(); renderTools();
}
function showToolsPage() {
  setRoute('/tools');
  document.body.classList.remove('sidebar-open');
  log.style.display = 'none'; agentsPage.style.display = 'none'; skillsPage.style.display = 'none'; toolsPage.style.display = ''; form.style.display = 'none';
  renderTools();
}
function clearConversation() {
  showChatPage();
  log.innerHTML = '<div class="msg system"><div class="meta">System</div>Pi web UI is ready. It talks to a headless <code>pi --mode rpc</code> process.</div>';
  assistantEl = null;
}
function renderMessageRange(messages, start, end, prepend=false) {
  if (prepend) {
    const anchor = log.firstChild;
    const oldScrollHeight = document.documentElement.scrollHeight;
    const oldChildCount = log.childNodes.length;
    for (let i = start; i < end; i++) renderOneMessage(messages[i], messages);
    const appendedNodes = Array.from(log.childNodes).slice(oldChildCount);
    for (const node of appendedNodes) log.insertBefore(node, anchor);
    const newScrollHeight = document.documentElement.scrollHeight;
    window.scrollBy(0, newScrollHeight - oldScrollHeight);
  } else {
    for (let i = start; i < end; i++) renderOneMessage(messages[i], messages);
  }
}
function renderOneMessage(msg, allMessages) {
  if (!msg || msg.role === 'toolResult') return;
  if (msg.role === 'user') {
    const text = messageText(msg);
    if (text) add('user', 'You', text);
  } else if (msg.role === 'assistant') {
    const toolResults = renderOneMessage.toolResults || new Map();
    if (!renderOneMessage.toolResults) {
      for (const m of allMessages) if (m.role === 'toolResult') toolResults.set(m.toolCallId, m);
      renderOneMessage.toolResults = toolResults;
    }
    let assistantText = '';
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) assistantText += block.text;
      else if (block.type === 'toolCall') {
        if (assistantText.trim()) { add('assistant', 'Assistant', assistantText); assistantText = ''; }
        renderStoredToolCall(block, toolResults.get(block.id));
      }
    }
    const text = messageText(msg);
    if (assistantText.trim()) add('assistant', 'Assistant', assistantText);
    else if (!blocks.length && text) add('assistant', 'Assistant', text);
  } else if (msg.role === 'bashExecution') {
    showStoredCommand(msg.command, msg.output, msg.exitCode !== 0);
  }
}
renderOneMessage.toolResults = null;
function renderInitialMessages(messages) {
  renderOneMessage.toolResults = null;
  clearConversation();
  loadedConversationMessages = messages;
  renderedMessageStart = Math.max(0, messages.length - MESSAGE_CHUNK_SIZE);
  renderMessageRange(messages, renderedMessageStart, messages.length, false);
  window.scrollTo(0, document.body.scrollHeight);
}
function renderOlderMessagesIfNeeded() {
  if (loadedConversationMessages.length === 0 || renderedMessageStart <= 0) return;
  if (window.scrollY > 160) return;
  const newStart = Math.max(0, renderedMessageStart - MESSAGE_CHUNK_SIZE);
  renderMessageRange(loadedConversationMessages, newStart, renderedMessageStart, true);
  renderedMessageStart = newStart;
}
function showStoredCommand(command, output, error=false) {
  const id = 'stored-' + Math.random().toString(36).slice(2);
  createToolBlock(id, command || 'bash', { command }, 'bash');
  updateToolBlock(id, output || '', true, error);
}
function renderStoredToolCall(toolCall, result) {
  const id = toolCall.id || ('stored-' + Math.random().toString(36).slice(2));
  const name = toolCall.name || 'tool';
  const args = toolCall.arguments || {};
  createToolBlock(id, formatToolTitle(name, args), args, name);
  updateToolBlock(id, toolResultText(result) || '', true, result && result.isError);
}
async function loadMessages() {
  try {
    const res = await fetch('/api/messages');
    const json = await res.json();
    const messages = json.data && json.data.messages ? json.data.messages : [];
    clearConversation();
    renderInitialMessages(messages);
    setEstimatedContextFromMessages(messages);
    return messages;
  } catch { return []; }
}
async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const json = await res.json();
    const rawProjects = json.projects || [];
    allProjects = rawProjects.filter(project => !hiddenProjectPaths.has(project.cwd));
    if (allProjects.length === 0 && rawProjects.length > 0) {
      hiddenProjectPaths.clear();
      localStorage.setItem('piWebHiddenProjects', '[]');
      allProjects = rawProjects;
    }
    renderProjects();
    await applyRoute();
  } catch (err) {
    projectsEl.innerHTML = '<div class="show-more">Failed to load sessions</div>';
  }
}
function renderProjects() {
    const q = projectSearchQuery.trim().toLowerCase();
    const projects = allProjects.map(project => {
      if (!q) return project;
      const projectMatches = project.cwd.toLowerCase().includes(q) || shortPath(project.cwd).toLowerCase().includes(q);
      const sessions = project.sessions.filter(session => sessionTitle(session).toLowerCase().includes(q) || (session.firstMessage || '').toLowerCase().includes(q));
      if (projectMatches) return project;
      if (sessions.length > 0) return { ...project, sessions, searchExpanded: true };
      return null;
    }).filter(Boolean);
    knownProjectPaths = new Set(allProjects.map(project => project.cwd));
    projectsEl.innerHTML = '';
    if (projects.length === 0) {
      projectsEl.innerHTML = '<div class="show-more">No projects yet. Use Add project to open a folder.</div>';
      return;
    }
    for (const project of projects) {
      const isCollapsed = !project.searchExpanded && collapsedProjectPaths.has(project.cwd);
      const wrap = document.createElement('div'); wrap.className = 'project' + (isCollapsed ? ' collapsed' : '');
      const head = document.createElement('div'); head.className = 'project-head';
      head.innerHTML = '<span class="project-caret">⌄</span><span class="project-icon"></span><span class="project-name"></span><button type="button" class="project-menu-button">…</button>';
      renderProjectIcon(head.querySelector('.project-icon'), project.cwd);
      head.querySelector('.project-name').textContent = shortPath(project.cwd);
      head.title = project.cwd + ' — click to expand/collapse';
      head.addEventListener('click', () => toggleProjectCollapsed(project.cwd));
      head.querySelector('.project-menu-button').addEventListener('click', ev => { ev.stopPropagation(); showProjectMenu(project.cwd, ev.currentTarget); });
      wrap.appendChild(head);
      const sessions = project.sessions.slice(0, (project.expanded || project.searchExpanded) ? project.sessions.length : 5);
      for (const session of sessions) {
        const row = document.createElement('div'); row.className = 'session-row' + (currentSessionPath === session.path ? ' active' : ''); row.dataset.path = session.path;
        row.innerHTML = '<div class="session-title"></div><div class="session-time"></div><button type="button" class="session-menu-button">…</button>';
        row.querySelector('.session-title').textContent = sessionTitle(session);
        row.querySelector('.session-time').textContent = relTime(session.modified);
        row.title = sessionTitle(session);
        row.querySelector('.session-menu-button').addEventListener('click', ev => { ev.stopPropagation(); showSessionMenu(session, ev.currentTarget); });
        row.addEventListener('click', () => openSession(session, project, true));
        wrap.appendChild(row);
      }
      if (project.sessions.length > sessions.length) {
        const more = document.createElement('div'); more.className = 'show-more'; more.textContent = 'Show more';
        more.addEventListener('click', () => { project.expanded = true; loadProjectsFromData(projects); });
        wrap.appendChild(more);
      }
      projectsEl.appendChild(wrap);
    }
}
function loadProjectsFromData(projects) {
  projectsEl.innerHTML = '';
  for (const project of projects) {
    const wrap = document.createElement('div'); wrap.className = 'project' + (collapsedProjectPaths.has(project.cwd) ? ' collapsed' : '');
    const head = document.createElement('div'); head.className = 'project-head';
    head.innerHTML = '<span class="project-caret">⌄</span><span class="project-icon"></span><span class="project-name"></span><button type="button" class="project-menu-button">…</button>';
    renderProjectIcon(head.querySelector('.project-icon'), project.cwd);
    head.querySelector('.project-name').textContent = shortPath(project.cwd); head.title = project.cwd + ' — click to expand/collapse'; head.addEventListener('click', () => toggleProjectCollapsed(project.cwd)); head.querySelector('.project-menu-button').addEventListener('click', ev => { ev.stopPropagation(); showProjectMenu(project.cwd, ev.currentTarget); }); wrap.appendChild(head);
    for (const session of project.sessions) {
      const row = document.createElement('div'); row.className = 'session-row' + (currentSessionPath === session.path ? ' active' : ''); row.dataset.path = session.path;
      row.innerHTML = '<div class="session-title"></div><div class="session-time"></div><button type="button" class="session-menu-button">…</button>';
      row.querySelector('.session-title').textContent = sessionTitle(session); row.querySelector('.session-time').textContent = relTime(session.modified);
      row.querySelector('.session-menu-button').addEventListener('click', ev => { ev.stopPropagation(); showSessionMenu(session, ev.currentTarget); });
      row.addEventListener('click', () => openSession(session, project, true));
      wrap.appendChild(row);
    }
    projectsEl.appendChild(wrap);
  }
}
mobileSidebarToggle.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
document.addEventListener('click', ev => {
  if (document.body.classList.contains('sidebar-open') && !ev.target.closest('aside') && !ev.target.closest('#mobileSidebarToggle')) document.body.classList.remove('sidebar-open');
});
document.addEventListener('touchstart', ev => {
  if (ev.touches.length !== 1) return;
  touchStartX = ev.touches[0].clientX;
  touchStartY = ev.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', ev => {
  if (!touchStartX || ev.changedTouches.length !== 1) return;
  const dx = ev.changedTouches[0].clientX - touchStartX;
  const dy = ev.changedTouches[0].clientY - touchStartY;
  const isPhone = window.matchMedia('(max-width: 820px)').matches;
  if (isPhone && !document.body.classList.contains('sidebar-open') && dx > 80 && Math.abs(dy) < 60) {
    document.body.classList.add('sidebar-open');
  }
  if (isPhone && document.body.classList.contains('sidebar-open') && dx < -80 && Math.abs(dy) < 60) {
    document.body.classList.remove('sidebar-open');
  }
  touchStartX = 0; touchStartY = 0;
}, { passive: true });
window.addEventListener('resize', updateMainBottomPadding, { passive: true });
window.addEventListener('scroll', renderOlderMessagesIfNeeded, { passive: true });
const es = new EventSource('/events');
es.onopen = () => { status.textContent = 'connected'; };
es.onerror = () => { status.textContent = 'disconnected'; };
es.onmessage = ev => {
  const e = JSON.parse(ev.data);
  if (e.type === 'agent_start') { awaitingAgent = false; busy = true; send.disabled = false; send.classList.add('generating'); updateSendButtonState(); send.title = 'Stop'; status.textContent = 'thinking…'; assistantEl = null; thinkingEl = null; }
  if (e.type === 'agent_end') { awaitingAgent = false; busy = false; finishAssistantSpinner(); send.classList.remove('generating'); updateSendButtonState(); send.title = 'Send'; status.textContent = 'ready'; assistantEl = null; thinkingEl = null; loadProjects(); loadState(); drainQueue(); }
  if (e.type === 'message_start') { assistantEl = null; thinkingEl = null; }
  if (e.type === 'message_end') finishAssistantSpinner();
  if (e.type === 'message_update') handleAssistantDelta(e.assistantMessageEvent || {});
  if (e.type === 'tool_execution_start' || e.type === 'tool_execution_update' || e.type === 'tool_execution_end') handleToolEvent(e);
  const tool = summarizeTool(e); if (tool) showEvent(tool, null, e.type === 'extension_error' ? 'tool error' : 'tool');
  if (e.type === 'response' && !e.success) showEvent(e.error || JSON.stringify(e), null, 'tool error');
};
form.addEventListener('submit', async ev => {
  ev.preventDefault(); const message = input.value.trim(); if (!message) return;
  input.value = ''; autoResizeInput(); updateSendButtonState(); send.disabled = true;
  try {
    const payload = await buildPromptWithAttachments(message);
    payload.originalMessage = message;
    payload.silentInChat = message.trim().toLowerCase().startsWith('/compact');
    selectedFiles = []; renderAttachmentPreview();
    if (busy || awaitingAgent || sendingQueue || queuedMessages.length > 0) {
      queuedMessages.push(payload);
      renderQueue();
    } else {
      await sendQueuedOrDirect(payload);
    }
  } catch (err) { add('tool', 'Error', String(err)); }
  finally { send.disabled = false; input.focus(); }
});
function addFiles(files) {
  const incoming = Array.from(files || []).filter(file => file && file.size >= 0);
  if (incoming.length === 0) return;
  selectedFiles.push(...incoming);
  renderAttachmentPreview();
}
attachButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
window.addEventListener('paste', ev => {
  const files = [];
  for (const item of Array.from(ev.clipboardData?.items || [])) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    ev.preventDefault();
    addFiles(files);
    input.focus();
  }
});
window.addEventListener('dragover', ev => { ev.preventDefault(); });
window.addEventListener('drop', ev => {
  const files = ev.dataTransfer?.files;
  if (files && files.length > 0) {
    ev.preventDefault();
    addFiles(files);
    input.focus();
  }
});
input.addEventListener('input', () => { selectedSuggestion = 0; renderSuggestions(); autoResizeInput(); updateSendButtonState(); });
input.addEventListener('blur', () => setTimeout(() => suggestions.classList.remove('visible'), 120));
input.addEventListener('keydown', ev => {
  if (suggestions.classList.contains('visible') && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    ev.preventDefault();
    const count = suggestions.children.length;
    selectedSuggestion = (selectedSuggestion + (ev.key === 'ArrowDown' ? 1 : -1) + count) % count;
    renderSuggestions();
    return;
  }
  if (suggestions.classList.contains('visible') && (ev.key === 'Tab' || ev.key === 'Enter') && !ev.shiftKey) {
    const active = suggestions.children[selectedSuggestion];
    if (active) { ev.preventDefault(); applySuggestion(active.querySelector('.suggestion-name').textContent); return; }
  }
  if (ev.key === 'Escape') { suggestions.classList.remove('visible'); return; }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
});
loadCommands().then(renderSuggestions);
loadState().then(async () => {
  if (routeInfo().page === 'chat') await loadMessages();
  await applyRoute();
});
loadAvailableModels();
loadProjects();
window.addEventListener('popstate', () => applyRoute());
newChat.addEventListener('click', async () => { await fetch('/api/new-session', { method:'POST' }); currentSessionPath = ''; setRoute('/'); clearConversation(); loadProjects(); input.focus(); });
searchFocus.addEventListener('click', showSearchModal);
agentsNav.addEventListener('click', showAgentsPage);
skillsNav.addEventListener('click', showSkillsPage);
toolsNav.addEventListener('click', showToolsPage);
addCustomAgent.addEventListener('click', () => showAgentModal());
agentCancel.addEventListener('click', hideAgentModal);
agentCancelFooter.addEventListener('click', hideAgentModal);
agentModal.addEventListener('click', ev => { if (ev.target === agentModal) hideAgentModal(); });
agentNameInput.addEventListener('input', updateAgentIconPreview);
agentIconButton.addEventListener('click', () => agentIconInput.click());
agentIconInput.addEventListener('change', () => {
  const file = agentIconInput.files && agentIconInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { pendingAgentIcon = String(reader.result); updateAgentIconPreview(); };
  reader.readAsDataURL(file);
  agentIconInput.value = '';
});
agentSave.addEventListener('click', saveAgentFromModal);
addSkill.addEventListener('click', () => showSkillModal());
skillCancel.addEventListener('click', hideSkillModal);
skillCancelFooter.addEventListener('click', hideSkillModal);
skillModal.addEventListener('click', ev => { if (ev.target === skillModal) hideSkillModal(); });
skillSave.addEventListener('click', saveSkillFromModal);
addTool.addEventListener('click', () => showToolModal());
toolCancel.addEventListener('click', hideToolModal);
toolCancelFooter.addEventListener('click', hideToolModal);
toolModal.addEventListener('click', ev => { if (ev.target === toolModal) hideToolModal(); });
toolSave.addEventListener('click', saveToolFromModal);
searchModal.addEventListener('click', ev => { if (ev.target === searchModal) hideSearchModal(); });
searchModalInput.addEventListener('input', () => { activeSearchIndex = 0; renderSearchModalResults(); });
searchModalInput.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') { hideSearchModal(); return; }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (searchResultItems.length === 0) return;
    activeSearchIndex = (activeSearchIndex + (ev.key === 'ArrowDown' ? 1 : -1) + searchResultItems.length) % searchResultItems.length;
    renderSearchModalResults();
    return;
  }
  if (ev.key === 'Enter') { ev.preventDefault(); activateSearchResult(searchResultItems[activeSearchIndex]); }
});
micButton.addEventListener('click', () => input.focus());
function searchHaystack(session) {
  return [sessionTitle(session), session.firstMessage || '', session.name || '', session.cwd || ''].join(' ').toLowerCase();
}
function buildSearchResults(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results = [];
  for (const project of allProjects) {
    const projectName = shortPath(project.cwd);
    const projectMatches = project.cwd.toLowerCase().includes(q) || projectName.toLowerCase().includes(q);
    if (projectMatches) results.push({ type: 'project', title: projectName, sub: project.cwd, project });
    for (const session of project.sessions) {
      if (searchHaystack(session).includes(q)) results.push({ type: 'session', title: sessionTitle(session), sub: projectName + ' · ' + relTime(session.modified), session, project });
    }
  }
  return results.slice(0, 60);
}
function renderSearchModalResults() {
  const results = buildSearchResults(searchModalInput.value);
  searchResultItems = results;
  activeSearchIndex = Math.min(activeSearchIndex, Math.max(0, results.length - 1));
  searchResults.innerHTML = '';
  if (!searchModalInput.value.trim()) {
    searchResults.innerHTML = '<div class="search-empty">Type to search projects and sessions</div>';
    return;
  }
  if (results.length === 0) {
    searchResults.innerHTML = '<div class="search-empty">No results</div>';
    return;
  }
  let lastType = '';
  results.forEach((result, index) => {
    if (result.type !== lastType) {
      lastType = result.type;
      const section = document.createElement('div'); section.className = 'search-section'; section.textContent = result.type === 'project' ? 'Projects' : 'Sessions'; searchResults.appendChild(section);
    }
    const row = document.createElement('button'); row.type = 'button'; row.className = 'search-result' + (index === activeSearchIndex ? ' active' : '');
    row.innerHTML = '<div class="search-result-icon"></div><div class="search-result-main"><div class="search-result-title"></div><div class="search-result-sub"></div></div>';
    row.querySelector('.search-result-icon').textContent = result.type === 'project' ? '▱' : '●';
    row.querySelector('.search-result-title').textContent = result.title;
    row.querySelector('.search-result-sub').textContent = result.sub;
    row.addEventListener('click', () => activateSearchResult(result));
    searchResults.appendChild(row);
  });
}
async function activateSearchResult(result) {
  if (!result) return;
  hideSearchModal();
  if (result.type === 'project') {
    collapsedProjectPaths.delete(result.project.cwd);
    localStorage.setItem('piWebCollapsedProjects', JSON.stringify([...collapsedProjectPaths]));
    renderProjects();
    return;
  }
  await openSession(result.session, result.project, true);
}
function showSearchModal() {
  document.body.classList.remove('sidebar-open');
  closeAllModals();
  searchModal.classList.add('visible');
  searchModalInput.value = '';
  activeSearchIndex = 0;
  renderSearchModalResults();
  setTimeout(() => searchModalInput.focus(), 0);
}
function hideSearchModal() { searchModal.classList.remove('visible'); }
function renderProjectIcon(container, cwd) {
  const icon = projectIcons[cwd];
  container.innerHTML = '';
  if (icon) {
    const img = document.createElement('img'); img.src = icon; img.alt = '';
    container.appendChild(img);
  } else {
    container.textContent = '▱';
  }
}
function chooseProjectIcon(cwd) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      projectIcons[cwd] = String(reader.result);
      localStorage.setItem('piWebProjectIcons', JSON.stringify(projectIcons));
      closeProjectMenu();
      renderProjects();
    };
    reader.readAsDataURL(file);
  });
  input.click();
}
function toggleProjectCollapsed(cwd) {
  if (collapsedProjectPaths.has(cwd)) collapsedProjectPaths.delete(cwd);
  else collapsedProjectPaths.add(cwd);
  localStorage.setItem('piWebCollapsedProjects', JSON.stringify([...collapsedProjectPaths]));
  loadProjects();
}
function closeProjectMenu() {
  document.querySelectorAll('.project-menu').forEach(menu => menu.remove());
}
function showProjectMenu(cwd, anchor) {
  closeProjectMenu();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div'); menu.className = 'project-menu';
  menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
  menu.style.top = (rect.bottom + 6) + 'px';
  const icon = document.createElement('button'); icon.type = 'button'; icon.className = 'project-menu-item'; icon.style.color = '#344054'; icon.textContent = 'Set Icon';
  icon.addEventListener('click', () => chooseProjectIcon(cwd));
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'project-menu-item'; remove.textContent = 'Remove Project';
  remove.addEventListener('click', () => {
    hiddenProjectPaths.add(cwd);
    localStorage.setItem('piWebHiddenProjects', JSON.stringify([...hiddenProjectPaths]));
    closeProjectMenu();
    loadProjects();
  });
  menu.appendChild(icon); menu.appendChild(remove); document.body.appendChild(menu);
}
function showSessionMenu(session, anchor) {
  closeProjectMenu();
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div'); menu.className = 'project-menu';
  menu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
  menu.style.top = (rect.bottom + 6) + 'px';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'project-menu-item'; remove.textContent = 'Delete Conversation';
  remove.addEventListener('click', async () => {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    const deletingActive = currentSessionPath === session.path;
    closeProjectMenu();
    status.textContent = 'deleting conversation…';
    const res = await fetch('/api/session', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionPath: session.path }) });
    if (!res.ok) { alert(await res.text()); status.textContent = 'ready'; return; }
    if (deletingActive) { await fetch('/api/new-session', { method:'POST' }); currentSessionPath = ''; setRoute('/'); clearConversation(); await loadState(); }
    await loadProjects();
    status.textContent = 'ready';
  });
  menu.appendChild(remove); document.body.appendChild(menu);
}
document.addEventListener('click', closeProjectMenu);
async function browseFolder(targetPath) {
  const res = await fetch('/api/browse?path=' + encodeURIComponent(targetPath || ''));
  if (!res.ok) { folderList.innerHTML = '<div class="show-more">' + await res.text() + '</div>'; return; }
  const data = await res.json();
  currentBrowsePath = data.path;
  folderPath.textContent = currentBrowsePath;
  folderList.innerHTML = '';
  const rows = [];
  if (data.parent) rows.push({ name: '..', path: data.parent, type: 'directory', parent: true });
  rows.push(...(data.entries || []));
  for (const entry of rows) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'folder-row ' + (entry.type === 'directory' ? 'directory' : 'file');
    row.innerHTML = '<span class="folder-icon"></span><span class="folder-name"></span>';
    row.querySelector('.folder-icon').textContent = entry.parent ? '↰' : (entry.type === 'directory' ? '▱' : '·');
    row.querySelector('.folder-name').textContent = entry.name;
    if (entry.type === 'directory') row.addEventListener('click', () => browseFolder(entry.path));
    folderList.appendChild(row);
  }
}
function closeAllModals() {
  folderModal.classList.remove('visible');
  searchModal.classList.remove('visible');
  agentModal.classList.remove('visible');
  skillModal.classList.remove('visible');
  toolModal.classList.remove('visible');
}
async function showFolderModal() {
  document.body.classList.remove('sidebar-open');
  closeAllModals();
  folderModal.classList.add('visible');
  await browseFolder(currentBrowsePath || '');
}
function hideFolderModal() { folderModal.classList.remove('visible'); }
async function openProject(cwd) {
  status.textContent = 'opening project…';
  const res = await fetch('/api/open-project', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ cwd }) });
  if (!res.ok) { add('tool', 'Error', await res.text()); status.textContent = 'ready'; return; }
  clearConversation();
  await loadProjects();
  await loadCommands();
  await loadState();
  await loadAvailableModels();
  status.textContent = 'ready';
  input.focus();
}
addProject.addEventListener('click', showFolderModal);
folderCancel.addEventListener('click', hideFolderModal);
folderModal.addEventListener('click', ev => { if (ev.target === folderModal) hideFolderModal(); });
folderSelect.addEventListener('click', async () => {
  if (!currentBrowsePath) return;
  if (knownProjectPaths.has(currentBrowsePath)) { hideFolderModal(); return; }
  hideFolderModal();
  await openProject(currentBrowsePath);
});
modelSelect.addEventListener('change', async () => {
  const selected = availableModels.find(model => modelKey(model) === modelSelect.value);
  if (!selected) return;
  const res = await fetch('/api/model', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ provider: selected.provider, modelId: selected.id }) });
  if (!res.ok) add('tool error', 'Model error', await res.text());
  await loadState();
});
thinkingSelect.addEventListener('change', async () => {
  const res = await fetch('/api/thinking', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ level: thinkingSelect.value }) });
  if (!res.ok) add('tool error', 'Reasoning error', await res.text());
  await loadState();
});
autoResizeInput();
updateMainBottomPadding();
updateSendButtonState();
input.focus();
</script>
</body>
</html>`;

export async function runWebMode(args: string[] = []) {
	const opts = parseArgs(args);
	if (opts.help) {
		usage();
		return;
	}

	const clients = new Set();
	let rpcBusy = false;
	let eventReplayBuffer = [];
	const broadcast = (event) => {
		if (event && event.type === "agent_start") {
			rpcBusy = true;
			eventReplayBuffer = [event];
		} else if (rpcBusy) {
			eventReplayBuffer.push(event);
			if (eventReplayBuffer.length > 1000) eventReplayBuffer = eventReplayBuffer.slice(-1000);
			if (event && event.type === "agent_end") rpcBusy = false;
		}
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of clients) res.write(payload);
	};
	const terminalManager = createTerminalManager(broadcast);
	let mainSystemPromptOverride = await readWebMainSystemPromptOverride();
	let activeCwd = process.cwd();
	let rpc = createRpc(opts.rpcArgs, broadcast, process.cwd());
	const applyMainSystemPromptOverride = async (targetRpc = rpc) => {
		if (mainSystemPromptOverride && mainSystemPromptOverride.trim()) {
			await targetRpc.send({ type: "set_system_prompt", systemPrompt: mainSystemPromptOverride }, 120000);
		}
	};
	await applyMainSystemPromptOverride(rpc).catch((error) =>
		broadcast({ type: "system_prompt_apply_error", error: error instanceof Error ? error.message : String(error) }),
	);
	const restartRpc = async (cwd, startNewSession = true) => {
		const resolvedCwd = path.resolve(cwd);
		if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
			throw new Error(`Project path is not a directory: ${resolvedCwd}`);
		}
		const previous = rpc;
		rpc = createRpc(opts.rpcArgs, broadcast, resolvedCwd);
		previous.child.kill("SIGTERM");
		if (startNewSession) {
			await rpc.send({ type: "new_session" });
		}
		await applyMainSystemPromptOverride(rpc);
		activeCwd = resolvedCwd;
		broadcast({ type: "project_opened", cwd: resolvedCwd });
		return resolvedCwd;
	};

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (req.method === "GET" && url.pathname.startsWith("/web/")) {
			try {
				const requested = path.resolve(webDir, "." + url.pathname.slice("/web".length));
				if (!requested.startsWith(path.resolve(webDir) + path.sep)) throw new Error("Invalid web asset path");
				const data = await fs.promises.readFile(requested);
				const ext = path.extname(requested).toLowerCase();
				const type =
					ext === ".tsx" || ext === ".ts"
						? "text/babel; charset=utf-8"
						: ext === ".js"
							? "text/javascript; charset=utf-8"
							: ext === ".css"
								? "text/css; charset=utf-8"
								: "application/octet-stream";
				res.writeHead(200, { "content-type": type });
				res.end(data);
			} catch {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("Not found");
			}
			return;
		}
		if (
			req.method === "GET" &&
			(url.pathname === "/" ||
				(!url.pathname.startsWith("/api/") &&
					!url.pathname.startsWith("/web/") &&
					url.pathname !== "/events" &&
					url.pathname !== "/favicon.svg"))
		) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(await fs.promises.readFile(path.join(webDir, "index.html"), "utf8"));
			return;
		}
		if (req.method === "GET" && url.pathname === "/favicon.svg") {
			res.writeHead(200, {
				"content-type": "image/svg+xml; charset=utf-8",
				"cache-control": "public, max-age=86400",
			});
			res.end(
				`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6d5dfc"/><text x="32" y="43" text-anchor="middle" font-family="ui-serif, Georgia, serif" font-size="38" font-weight="700" fill="white">π</text></svg>`,
			);
			return;
		}
		if (req.method === "GET" && url.pathname === "/events") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(`data: ${JSON.stringify({ type: "web_connected", rpcBusy })}\n\n`);
			if (rpcBusy) {
				for (const event of eventReplayBuffer) {
					res.write(`data: ${JSON.stringify({ ...event, replay: true })}\n\n`);
				}
			}
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/prompt") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (!data.message || typeof data.message !== "string") throw new Error("Missing message");
					const trimmed = data.message.trim();
					let response;
					if (trimmed.startsWith("/")) {
						const [rawCommand, ...rest] = trimmed.slice(1).split(/\s+/);
						const commandName = rawCommand.toLowerCase();
						const args = rest.join(" ").trim();
						if (commandName === "compact") {
							response = await rpc.send(
								args ? { type: "compact", customInstructions: args } : { type: "compact" },
								120000,
							);
						} else if (commandName === "new") {
							response = await rpc.send({ type: "new_session" });
							await applyMainSystemPromptOverride(rpc);
						} else if (commandName === "export") {
							response = await rpc.send(
								args ? { type: "export_html", outputPath: args } : { type: "export_html" },
								120000,
							);
						} else if (commandName === "session") {
							response = await rpc.send({ type: "get_session_stats" });
						} else if (commandName === "copy") {
							response = await rpc.send({ type: "get_last_assistant_text" });
						} else if (commandName === "abort") {
							response = await rpc.send({ type: "abort" });
						} else if (commandName === "commands") {
							response = await mergeCommands(await rpc.send({ type: "get_commands" }));
						} else if (commandName === "name") {
							if (!args) throw new Error("Usage: /name <session name>");
							response = await rpc.send({ type: "set_session_name", name: args });
						} else if (commandName === "clone") {
							response = await rpc.send({ type: "clone" });
						} else if (commandName === "reload") {
							const previous = rpc;
							rpc = createRpc(opts.rpcArgs, broadcast, activeCwd);
							previous.child.kill("SIGTERM");
							await applyMainSystemPromptOverride(rpc);
							response = { type: "response", command: "reload", success: true };
						} else if (commandName === "model") {
							if (args) {
								const modelsResponse = await rpc.send({ type: "get_available_models" });
								const models = modelsResponse.data?.models || [];
								const needle = args.toLowerCase();
								const model = models.find(
									(m) =>
										`${m.provider}/${m.id}`.toLowerCase() === needle ||
										m.id.toLowerCase() === needle ||
										(m.name || "").toLowerCase() === needle ||
										`${m.provider}/${m.id}`.toLowerCase().includes(needle),
								);
								if (!model) throw new Error(`Model not found: ${args}`);
								response = await rpc.send({ type: "set_model", provider: model.provider, modelId: model.id });
							} else {
								response = await rpc.send({ type: "get_state" });
							}
						} else if (commandName === "settings") {
							response = await rpc.send({ type: "get_state" });
						} else if (commandName === "scoped-models") {
							response = await rpc.send({ type: "get_available_models" });
						} else if (commandName === "hotkeys") {
							response = {
								type: "response",
								command: "hotkeys",
								success: true,
								data: {
									text: "Web hotkeys: Enter send, Shift+Enter newline, / for commands, ↑/↓ navigate slash commands, Tab/Enter apply slash command, mobile swipe opens sidebar.",
								},
							};
						} else if (commandName === "changelog") {
							const changelog = await fs.promises
								.readFile(path.join(__dirname, "..", "CHANGELOG.md"), "utf8")
								.catch(() => "Changelog not found.");
							response = {
								type: "response",
								command: "changelog",
								success: true,
								data: { text: changelog.split(/\r?\n/).slice(0, 120).join("\n") },
							};
						} else if (commandName === "resume") {
							const sessions = await SessionManager.listAll();
							response = {
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
							};
						} else if (commandName === "tree") {
							response = {
								type: "response",
								command: "tree",
								success: true,
								data: {
									text: "Tree navigation is not available in the web UI yet. Use the conversation list/sidebar or the TUI /tree command.",
								},
							};
						} else if (commandName === "fork") {
							response = {
								type: "response",
								command: "fork",
								success: true,
								data: { text: "Fork selection is not available in the web UI yet. Use the TUI /fork command." },
							};
						} else if (commandName.startsWith("skill:")) {
							const skillName = commandName.slice("skill:".length);
							response = await rpc.sendDetached({
								type: "prompt",
								message: `Use the ${skillName} skill. ${args}`.trim(),
							});
						} else if (["import", "share", "login", "logout", "quit"].includes(commandName)) {
							throw new Error(`/${commandName} is interactive-only and is not available in Pi web yet`);
						} else {
							const commands =
								(await mergeCommands(await rpc.send({ type: "get_commands" }))).data?.commands || [];
							const dynamic = commands.find(
								(command) => command.name === commandName || command.name.toLowerCase() === commandName,
							);
							if (!dynamic) throw new Error(`/${commandName} is not supported in Pi web yet`);
							response = await rpc.sendDetached({
								type: "prompt",
								message: `${trimmed}\n\nExecute the slash command above as requested.`,
							});
						}
					} else {
						const command = { type: "prompt", message: data.message };
						if (Array.isArray(data.images) && data.images.length > 0) command.images = data.images;
						if (data.streamingBehavior) command.streamingBehavior = data.streamingBehavior;
						response = await rpc.send(command);
					}
					res.writeHead(response.success ? 200 : 400, { "content-type": "application/json" });
					res.end(JSON.stringify(response));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/projects") {
			try {
				const sessions = await SessionManager.listAll();
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ projects: groupSessionsByProject(sessions, activeCwd) }));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/terminal/state") {
			try {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ success: true, data: terminalManager.state(activeCwd) }));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/terminal/start") {
			try {
				const terminal = terminalManager.ensure(activeCwd);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						success: true,
						data: {
							cwd: terminal.cwd,
							pid: terminal.child.pid,
							running: !terminal.exited,
							buffer: terminal.buffer,
						},
					}),
				);
			} catch (error) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/terminal/input") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (typeof data.data !== "string") throw new Error("Missing terminal input");
					const terminal = terminalManager.write(activeCwd, data.data);
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ success: true, data: { cwd: terminal.cwd, pid: terminal.child.pid } }));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/terminal/restart") {
			try {
				terminalManager.stop(activeCwd);
				const terminal = terminalManager.ensure(activeCwd);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						success: true,
						data: {
							cwd: terminal.cwd,
							pid: terminal.child.pid,
							running: !terminal.exited,
							buffer: terminal.buffer,
						},
					}),
				);
			} catch (error) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/browse") {
			try {
				const requested = url.searchParams.get("path") || activeCwd || process.cwd();
				const target = path.resolve(requested);
				const stat = await fs.promises.stat(target);
				if (!stat.isDirectory()) throw new Error(`Not a directory: ${target}`);
				const entries = await fs.promises.readdir(target, { withFileTypes: true });
				const data = entries
					.filter((entry) => !entry.name.startsWith("."))
					.map((entry) => ({
						name: entry.name,
						type: entry.isDirectory() ? "directory" : "file",
						path: path.join(target, entry.name),
					}))
					.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
				const parent = path.dirname(target) !== target ? path.dirname(target) : null;
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ path: target, parent, entries: data }));
			} catch (error) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/open-project") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (!data.cwd || typeof data.cwd !== "string") throw new Error("Missing cwd");
					const cwd = await restartRpc(data.cwd, true);
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ success: true, cwd }));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/models") {
			try {
				const response = await rpc.send({ type: "get_available_models" });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(response));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/model") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (!data.provider || !data.modelId) throw new Error("Missing provider or modelId");
					const response = await rpc.send({ type: "set_model", provider: data.provider, modelId: data.modelId });
					res.writeHead(response.success ? 200 : 400, { "content-type": "application/json" });
					res.end(JSON.stringify(response));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/thinking") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (!data.level || typeof data.level !== "string") throw new Error("Missing level");
					const response = await rpc.send({ type: "set_thinking_level", level: data.level });
					res.writeHead(response.success ? 200 : 400, { "content-type": "application/json" });
					res.end(JSON.stringify(response));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/commands") {
			try {
				const response = await rpc.send({ type: "get_commands" });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(await mergeCommands(response)));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/skills") {
			try {
				const skills = await listWebSkills();
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ skills }));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if ((req.method === "POST" || req.method === "PUT") && url.pathname === "/api/skills") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					const name = String(data.name || "").trim();
					const description = String(data.description || "").trim();
					const rawContent = String(data.content || "").trim();
					const slug = skillSlug(name);
					if (!slug) throw new Error("Missing skill name");
					if (!description) throw new Error("Missing skill description");
					if (!rawContent) throw new Error("Missing skill content");
					const root = path.join(os.homedir(), ".pi", "agent", "skills");
					let dir = path.join(root, slug);
					let file = path.join(dir, "SKILL.md");
					if (req.method === "POST") {
						try {
							await fs.promises.mkdir(dir, { recursive: false });
						} catch (error) {
							if (error && error.code === "EEXIST") throw new Error(`Skill already exists: ${slug}`);
							throw error;
						}
					} else {
						const requested = path.resolve(String(data.path || ""));
						if (!requested.startsWith(path.resolve(root) + path.sep) || path.basename(requested) !== "SKILL.md")
							throw new Error("Invalid skill path");
						file = requested;
						dir = path.dirname(file);
						await fs.promises.stat(file);
					}
					const content = rawContent;
					await fs.promises.writeFile(file, content, "utf8");
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ success: true, skill: { name: slug, description, content, path: file } }));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/skills") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					const root = path.join(os.homedir(), ".pi", "agent", "skills");
					const requested = path.resolve(String(data.path || ""));
					const allowedRoot = path.resolve(root) + path.sep;
					if (!requested.startsWith(allowedRoot) || path.basename(requested) !== "SKILL.md")
						throw new Error("Invalid skill path");
					await fs.promises.rm(path.dirname(requested), { recursive: true, force: true });
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ success: true }));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/messages") {
			try {
				const response = await rpc.send({ type: "get_messages" });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(response));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/new-session") {
			try {
				const response = await rpc.send({ type: "new_session" });
				await applyMainSystemPromptOverride(rpc);
				res.writeHead(response.success ? 200 : 400, { "content-type": "application/json" });
				res.end(JSON.stringify(response));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/switch-session") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (!data.sessionPath || typeof data.sessionPath !== "string") throw new Error("Missing sessionPath");
					let response;
					const requested = path.resolve(data.sessionPath);
					try {
						const state = await rpc.send({ type: "get_state" }, 5000);
						const current = state?.data?.sessionFile ? path.resolve(state.data.sessionFile) : undefined;
						if (state.success && current === requested) {
							response = {
								type: "response",
								command: "switch_session",
								success: true,
								data: { cancelled: false, unchanged: true },
							};
						}
					} catch {}
					response = response || (await rpc.send({ type: "switch_session", sessionPath: data.sessionPath }));
					if (response.success) await applyMainSystemPromptOverride(rpc);
					if (response.success) {
						const sessions = await SessionManager.listAll();
						const match = sessions.find((session) => session.path && path.resolve(session.path) === requested);
						if (match?.cwd) activeCwd = path.resolve(match.cwd);
					}
					res.writeHead(response.success ? 200 : 400, { "content-type": "application/json" });
					res.end(JSON.stringify(response));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "DELETE" && url.pathname === "/api/session") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (!data.sessionPath || typeof data.sessionPath !== "string") throw new Error("Missing sessionPath");
					const requested = path.resolve(data.sessionPath);
					const sessions = await SessionManager.listAll();
					const match = sessions.find((session) => session.path && path.resolve(session.path) === requested);
					if (!match) throw new Error("Unknown session");
					await fs.promises.rm(requested, { force: true });
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ success: true }));
				} catch (error) {
					res.writeHead(400, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/stats") {
			try {
				const response = await rpc.send({ type: "get_session_stats" });
				const messagesResponse = await rpc.send({ type: "get_messages" });
				const modelResponse = await rpc.send({ type: "get_state" });
				if (response.success && messagesResponse.success) {
					const messages = messagesResponse.data?.messages ?? [];
					const estimated = estimateContextTokens(messages);
					const contextWindow =
						modelResponse.data?.model?.contextWindow ?? response.data?.contextUsage?.contextWindow ?? null;
					response.data = response.data ?? {};
					response.data.estimatedContextUsage = {
						tokens: estimated.tokens,
						contextWindow,
						percent: contextWindow ? (estimated.tokens / contextWindow) * 100 : null,
					};
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(response));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			try {
				const response = await rpc.send({ type: "get_state" });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(response));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/system-prompt") {
			try {
				const response = await rpc.send({ type: "get_system_prompt" });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(response));
			} catch (error) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/system-prompt") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (typeof data.systemPrompt !== "string" || !data.systemPrompt.trim())
						throw new Error("Missing systemPrompt");
					mainSystemPromptOverride = data.systemPrompt;
					await writeWebMainSystemPromptOverride(mainSystemPromptOverride);
					const response = await rpc.send({ type: "set_system_prompt", systemPrompt: data.systemPrompt }, 120000);
					res.writeHead(response.success ? 200 : 400, { "content-type": "application/json" });
					res.end(JSON.stringify(response));
				} catch (error) {
					res.writeHead(500, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			});
			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("Not found");
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port, opts.host, resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : opts.port;
	const url = `http://${opts.host}:${port}`;
	console.log(`Pi web UI running at ${url}`);
	console.log(`Headless Pi RPC PID: ${rpc.child.pid}`);
	if (opts.open) openBrowser(url);

	const shutdown = () => {
		server.close();
		terminalManager.stopAll();
		rpc.child.kill("SIGTERM");
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
