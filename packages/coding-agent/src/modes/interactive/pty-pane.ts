/**
 * PTY shell pane — wraps node-pty + @xterm/headless for terminal emulation.
 *
 * Renders a real shell inside a split pane. Lazily spawns the PTY on first
 * render to avoid overhead when the pane hasn't been laid out yet.
 *
 * Implements BoundsAwareComponent so PaneContainer can allocate a rectangular
 * region and read the screen buffer from xterm.
 */

import type { BoundsAwareComponent } from "@mariozechner/pi-tui";

// Lazy-loaded deps (node-pty may not be installed)
// biome-ignore lint: dynamic imports for optional deps
let pty: any;
// biome-ignore lint: dynamic imports for optional deps
let xtermLib: any;

// Use a variable to prevent TypeScript from resolving the optional dependency at compile time
const NODE_PTY_MODULE = "node-pty";

async function loadPty() {
	if (!pty) {
		try {
			pty = await import(NODE_PTY_MODULE);
		} catch {
			throw new Error("node-pty is not installed. Install it with: pnpm add node-pty");
		}
	}
	return pty;
}

async function loadXterm() {
	if (!xtermLib) {
		try {
			xtermLib = await import("@xterm/headless");
		} catch {
			throw new Error("@xterm/headless is not installed.");
		}
	}
	return xtermLib;
}

// ---------------------------------------------------------------------------
// PtyPane
// ---------------------------------------------------------------------------

export class PtyPane implements BoundsAwareComponent {
	private cwd: string;
	private shell: string;
	private ptyProcess: any | undefined;
	private terminal: any | undefined;
	/** True after spawn() has been called (regardless of success/failure). No automatic retry. */
	private spawnAttempted = false;
	private spawnError: string | undefined;
	private lastWidth = 80;
	private lastHeight = 24;

	constructor(cwd: string, shell?: string) {
		this.cwd = cwd;
		this.shell = shell || (process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash");
	}

	/**
	 * Spawn the PTY process. Called lazily on first render.
	 */
	async spawn(cols: number, rows: number): Promise<void> {
		if (this.spawnAttempted) return;
		this.spawnAttempted = true;

		try {
			const ptyMod = await loadPty();
			const xtermMod = await loadXterm();

			// Create headless xterm terminal for screen state
			this.terminal = new xtermMod.Terminal({
				cols,
				rows,
				scrollback: 1000,
				allowProposedApi: true,
			});

			// Spawn PTY
			this.ptyProcess = ptyMod.spawn(this.shell, [], {
				name: "xterm-256color",
				cols,
				rows,
				cwd: this.cwd,
				env: process.env as Record<string, string>,
			});

			// Pipe PTY output to xterm
			this.ptyProcess.onData((data: string) => {
				this.terminal.write(data);
			});

			this.ptyProcess.onExit(() => {
				this.ptyProcess = undefined;
			});

			// Apply any dimensions that arrived during the async spawn window
			this.resize(this.lastWidth, this.lastHeight);
		} catch (err) {
			this.spawnError = err instanceof Error ? err.message : String(err);
		}
	}

	/**
	 * Forward keyboard input to the PTY process.
	 */
	handleInput(data: string): void {
		if (this.ptyProcess) {
			this.ptyProcess.write(data);
		}
	}

	/**
	 * Resize the PTY to match the new pane dimensions.
	 */
	resize(cols: number, rows: number): void {
		this.lastWidth = cols;
		this.lastHeight = rows;
		if (this.ptyProcess) {
			this.ptyProcess.resize(cols, rows);
		}
		if (this.terminal) {
			this.terminal.resize(cols, rows);
		}
	}

	// ── BoundsAwareComponent ─────────────────────────────────────────────────

	renderBounded(width: number, height: number): string[] {
		// Lazily spawn on first render
		if (!this.spawnAttempted) {
			this.spawn(width, height).catch(() => {});
		}

		this.resize(width, height);

		if (this.spawnError) {
			const lines: string[] = [];
			lines.push(`\x1b[31m  Shell error: ${this.spawnError}\x1b[0m`);
			while (lines.length < height) lines.push(" ".repeat(width));
			return lines;
		}

		if (!this.terminal) {
			const lines: string[] = [];
			lines.push("\x1b[90m  Starting shell...\x1b[0m");
			while (lines.length < height) lines.push(" ".repeat(width));
			return lines;
		}

		// Read screen buffer from xterm
		const lines: string[] = [];
		const buffer = this.terminal.buffer.active;
		for (let row = 0; row < height; row++) {
			const line = buffer.getLine(row);
			if (line) {
				lines.push(line.translateToString(true));
			} else {
				lines.push("");
			}
		}

		return lines;
	}

	render(width: number): string[] {
		return this.renderBounded(width, this.lastHeight);
	}

	invalidate(): void {
		// Terminal buffer is always fresh — no caching needed
	}

	// ── Cleanup ──────────────────────────────────────────────────────────────

	dispose(): void {
		if (this.ptyProcess) {
			this.ptyProcess.kill();
			this.ptyProcess = undefined;
		}
		if (this.terminal) {
			this.terminal.dispose();
			this.terminal = undefined;
		}
	}
}
