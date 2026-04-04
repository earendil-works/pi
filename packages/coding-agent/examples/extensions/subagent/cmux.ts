import { execFile, execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
	const cached = commandAvailability.get(command);
	if (cached !== undefined) {
		return cached;
	}

	let available = false;
	try {
		execSync(`command -v ${command}`, { stdio: "ignore" });
		available = true;
	} catch {
		available = false;
	}

	commandAvailability.set(command, available);
	return available;
}

function muxPreference(): MuxBackend | null {
	const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
	if (pref === "cmux" || pref === "tmux" || pref === "zellij") {
		return pref;
	}
	return null;
}

function isCmuxRuntimeAvailable(): boolean {
	return Boolean(process.env.CMUX_SOCKET_PATH) && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
	return Boolean(process.env.TMUX) && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
	return Boolean(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

export function getMuxBackend(): MuxBackend | null {
	const preferred = muxPreference();
	if (preferred === "cmux") {
		return isCmuxRuntimeAvailable() ? "cmux" : null;
	}
	if (preferred === "tmux") {
		return isTmuxRuntimeAvailable() ? "tmux" : null;
	}
	if (preferred === "zellij") {
		return isZellijRuntimeAvailable() ? "zellij" : null;
	}

	if (isCmuxRuntimeAvailable()) {
		return "cmux";
	}
	if (isTmuxRuntimeAvailable()) {
		return "tmux";
	}
	if (isZellijRuntimeAvailable()) {
		return "zellij";
	}
	return null;
}

export function isMuxAvailable(): boolean {
	return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
	const preferred = muxPreference();
	if (preferred === "cmux") {
		return "Start pi inside cmux (`cmux pi`).";
	}
	if (preferred === "tmux") {
		return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
	}
	if (preferred === "zellij") {
		return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
	}
	return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), or zellij (`zellij --session pi`, then run `pi`).";
}

function requireMuxBackend(): MuxBackend {
	const backend = getMuxBackend();
	if (!backend) {
		throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
	}
	return backend;
}

export function isFishShell(): boolean {
	return basename(process.env.SHELL ?? "") === "fish";
}

export function exitStatusVar(): string {
	return isFishShell() ? "$status" : "$?";
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function tailLines(text: string, lines: number): string {
	const split = text.split("\n");
	if (split.length <= lines) {
		return text;
	}
	return split.slice(-lines).join("\n");
}

function zellijPaneId(surface: string): string {
	return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (surface) {
		env.ZELLIJ_PANE_ID = zellijPaneId(surface);
	}
	return env;
}

function waitForFile(filePath: string, timeoutMs = 5000): string {
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(filePath)) {
			return readFileSync(filePath, "utf8").trim();
		}
		Atomics.wait(sleeper, 0, 0, 20);
	}
	throw new Error(`Timed out waiting for zellij pane id file: ${filePath}`);
}

function zellijActionSync(args: string[], surface?: string): string {
	return execFileSync("zellij", ["action", ...args], {
		encoding: "utf8",
		env: zellijEnv(surface),
	});
}

async function zellijActionAsync(args: string[], surface?: string): Promise<string> {
	const { stdout } = await execFileAsync("zellij", ["action", ...args], {
		encoding: "utf8",
		env: zellijEnv(surface),
	});
	return stdout;
}

export function createSurface(name: string): string {
	return createSurfaceSplit(name, "right");
}

export function createSurfaceSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const backend = requireMuxBackend();

	if (backend === "cmux") {
		const surfaceArg = fromSurface ? ` --surface ${shellEscape(fromSurface)}` : "";
		const output = execSync(`cmux new-split ${direction}${surfaceArg}`, { encoding: "utf8" }).trim();
		const match = output.match(/surface:\d+/);
		if (!match) {
			throw new Error(`Unexpected cmux new-split output: ${output}`);
		}
		const surface = match[0];
		execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, { encoding: "utf8" });
		execSync(`cmux focus-panel --panel ${shellEscape(surface)}`, { encoding: "utf8" });
		return surface;
	}

	if (backend === "tmux") {
		const args = ["split-window"];
		if (direction === "left" || direction === "right") {
			args.push("-h");
		} else {
			args.push("-v");
		}
		if (direction === "left" || direction === "up") {
			args.push("-b");
		}
		if (fromSurface) {
			args.push("-t", fromSurface);
		}
		args.push("-P", "-F", "#{pane_id}");

		const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
		if (!pane.startsWith("%")) {
			throw new Error(`Unexpected tmux split-window output: ${pane}`);
		}

		try {
			execFileSync("tmux", ["select-pane", "-t", pane, "-T", name], { encoding: "utf8" });
		} catch {
			// Optional tmux title support.
		}
		execFileSync("tmux", ["select-pane", "-t", pane], { encoding: "utf8" });
		return pane;
	}

	const directionArg = direction === "left" || direction === "right" ? "right" : "down";
	const tokenPath = join(tmpdir(), `pi-subagent-zellij-pane-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
	const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

	try {
		zellijActionSync(args, fromSurface);
	} catch {
		if (!fromSurface) {
			throw new Error("Failed to create zellij pane");
		}
		zellijActionSync(args);
	}

	const captureIdCommand = `echo "$ZELLIJ_PANE_ID" > ${shellEscape(tokenPath)}`;
	zellijActionSync(["write-chars", captureIdCommand]);
	zellijActionSync(["write", "13"]);

	const paneId = waitForFile(tokenPath);
	try {
		rmSync(tokenPath, { force: true });
	} catch {
		// Best-effort temp cleanup.
	}

	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(`Unexpected zellij pane id: ${paneId || "(empty)"}`);
	}

	const surface = `pane:${paneId}`;

	if (direction === "left" || direction === "up") {
		try {
			zellijActionSync(["move-pane", direction], surface);
		} catch {
			// Optional layout polish.
		}
	}

	try {
		zellijActionSync(["rename-pane", name], surface);
	} catch {
		// Optional.
	}

	return surface;
}

export function renameCurrentTab(title: string): void {
	const backend = requireMuxBackend();

	if (backend === "cmux") {
		const surfaceId = process.env.CMUX_SURFACE_ID;
		if (!surfaceId) {
			throw new Error("CMUX_SURFACE_ID not set");
		}
		execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, { encoding: "utf8" });
		return;
	}

	if (backend === "tmux") {
		const paneId = process.env.TMUX_PANE;
		if (!paneId) {
			throw new Error("TMUX_PANE not set");
		}
		const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
			encoding: "utf8",
		}).trim();
		execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
		return;
	}

	zellijActionSync(["rename-tab", title]);
}

export function renameWorkspace(title: string): void {
	const backend = requireMuxBackend();

	if (backend === "cmux") {
		execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, { encoding: "utf8" });
		return;
	}

	if (backend === "tmux") {
		if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
			return;
		}
		const paneId = process.env.TMUX_PANE;
		if (!paneId) {
			throw new Error("TMUX_PANE not set");
		}
		const sessionId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_id}"], {
			encoding: "utf8",
		}).trim();
		execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
		return;
	}

	zellijActionSync(["rename-session", title]);
}

export function sendCommand(surface: string, command: string): void {
	const backend = requireMuxBackend();

	if (backend === "cmux") {
		execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(`${command}\n`)}`, { encoding: "utf8" });
		return;
	}

	if (backend === "tmux") {
		execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
		execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
		return;
	}

	zellijActionSync(["write-chars", command], surface);
	zellijActionSync(["write", "13"], surface);
}

export function readScreen(surface: string, lines = 50): string {
	const backend = requireMuxBackend();

	if (backend === "cmux") {
		return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, { encoding: "utf8" });
	}

	if (backend === "tmux") {
		return execFileSync("tmux", ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`], {
			encoding: "utf8",
		});
	}

	const tempPath = join(
		tmpdir(),
		`pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
	);
	try {
		zellijActionSync(["dump-screen", tempPath], surface);
		return tailLines(readFileSync(tempPath, "utf8"), lines);
	} finally {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Best-effort temp cleanup.
		}
	}
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
	const backend = requireMuxBackend();

	if (backend === "cmux") {
		const { stdout } = await execFileAsync("cmux", ["read-screen", "--surface", surface, "--lines", String(lines)], {
			encoding: "utf8",
		});
		return stdout;
	}

	if (backend === "tmux") {
		const { stdout } = await execFileAsync(
			"tmux",
			["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
			{
				encoding: "utf8",
			},
		);
		return stdout;
	}

	const tempPath = join(
		tmpdir(),
		`pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
	);
	try {
		await zellijActionAsync(["dump-screen", tempPath], surface);
		return tailLines(readFileSync(tempPath, "utf8"), lines);
	} finally {
		try {
			rmSync(tempPath, { force: true });
		} catch {
			// Best-effort temp cleanup.
		}
	}
}

export function closeSurface(surface: string): void {
	const backend = requireMuxBackend();

	if (backend === "cmux") {
		execSync(`cmux close-surface --surface ${shellEscape(surface)}`, { encoding: "utf8" });
		return;
	}

	if (backend === "tmux") {
		execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
		return;
	}

	zellijActionSync(["close-pane"], surface);
}

export async function pollForExit(
	surface: string,
	signal: AbortSignal,
	options: { interval: number; onTick?: (elapsedSeconds: number) => void },
): Promise<number> {
	const start = Date.now();

	while (true) {
		if (signal.aborted) {
			throw new Error("Aborted while waiting for subagent to finish");
		}

		const screen = await readScreenAsync(surface, 5);
		const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
		if (match) {
			return Number.parseInt(match[1], 10);
		}

		options.onTick?.(Math.floor((Date.now() - start) / 1000));

		await new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("Aborted"));
				return;
			}
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, options.interval);
			function onAbort() {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			}
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
