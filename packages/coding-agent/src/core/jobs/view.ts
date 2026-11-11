// Live job list/detail view shared by pi overlays and Rex terminals.
import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { getKeybindings, Input, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { PaneControls, PaneView } from "../panes/host.ts";
import type { JobManager } from "./manager.ts";
import type { JobInfo } from "./state.ts";

type Editing = { type: "rename" | "command"; id: string; input: Input };

/** Display persistent jobs and their live output with configurable management controls. */
export class JobsView implements PaneView {
	private readonly manager: JobManager;
	private readonly cwd: string;
	private readonly controls: PaneControls;
	private readonly onSubmitted: (job: JobInfo) => void;
	private jobs: JobInfo[] = [];
	private selected = 0;
	private detail: string | undefined;
	private detailJob: JobInfo | undefined;
	private editing: Editing | undefined;
	private error: string | undefined;
	private log = "";
	private logTruncated = false;
	private scroll = 0;
	private busy = false;
	private disposed = false;
	private refreshing = false;
	private refreshAgain = false;
	private refreshTimer: NodeJS.Timeout | undefined;
	private readonly clock: NodeJS.Timeout;
	private readonly rootWatcher: FSWatcher;
	private readonly watches = new Map<string, () => void>();

	constructor(
		manager: JobManager,
		cwd: string,
		controls: PaneControls,
		onSubmitted: (job: JobInfo) => void,
		id?: string,
	) {
		this.manager = manager;
		this.cwd = cwd;
		this.controls = controls;
		this.onSubmitted = onSubmitted;
		this.detail = id;
		mkdirSync(manager.directory, { recursive: true, mode: 0o700 });
		this.rootWatcher = watch(manager.directory, { persistent: false }, (_event, name) => {
			if (!this.detail || name === this.detail) this.scheduleRefresh();
		});
		this.rootWatcher.on("error", (error) => {
			this.error = error.message;
			controls.invalidate();
		});
		let ticks = 0;
		this.clock = setInterval(() => {
			controls.invalidate();
			const job = this.detail ? this.selectedJob() : undefined;
			// A killed supervisor cannot publish a status-file event.
			if (++ticks % 8 === 0 && (job ? isActiveJob(job) : this.jobs.some(isActiveJob))) {
				this.scheduleRefresh();
			}
		}, 250);
		this.clock.unref();
		void this.refresh();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.pane.minimize")) {
			void this.controls.minimize().catch((error: unknown) => {
				this.error = String(error);
				this.controls.invalidate();
			});
			return;
		}
		if (this.editing) {
			this.editing.input.handleInput(data);
			this.controls.invalidate();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.detail) {
				this.detail = undefined;
				this.scroll = 0;
				this.scheduleRefresh();
			} else this.controls.close();
		} else if (this.detail && kb.matches(data, "tui.select.pageUp")) this.scroll += 10;
		else if (this.detail && kb.matches(data, "tui.select.pageDown")) this.scroll = Math.max(0, this.scroll - 10);
		else if (!this.detail && kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (!this.detail && kb.matches(data, "tui.select.down"))
			this.selected = Math.min(this.jobs.length - 1, this.selected + 1);
		else {
			const job = this.selectedJob();
			if (!job || this.busy) return;
			if (kb.matches(data, "tui.select.confirm")) {
				this.detail = job.id;
				this.scroll = 0;
				this.scheduleRefresh();
			} else if (kb.matches(data, "app.jobs.stop")) void this.run(() => this.manager.stop(job.id));
			else if (kb.matches(data, "app.jobs.restart")) void this.run(() => this.restart(job.id));
			else if (kb.matches(data, "app.jobs.delete")) void this.run(() => this.manager.remove(job.id));
			else if (kb.matches(data, "app.jobs.rename")) this.edit(job, "rename");
			else if (kb.matches(data, "app.jobs.editCommand")) this.edit(job, "command");
		}
		this.controls.invalidate();
	}

	render(width: number, height: number): string[] {
		const lines: string[] = [];
		const job = this.detail ? this.selectedJob() : undefined;
		if (job) {
			lines.push(
				theme.bold(singleLine(job.name, width)),
				`${job.id}  ${job.runtime.state}  ${duration(job)}`,
				progress(job, Math.min(30, Math.max(4, width - 10))),
			);
			lines.push(singleLine(`$ ${job.command}`, width), singleLine(`Directory: ${job.cwd}`, width));
			if (job.progress?.message) lines.push(singleLine(job.progress.message, width));
			if (job.progressError) lines.push(theme.fg("warning", singleLine(job.progressError, width)));
			if (job.naming?.status === "failed")
				lines.push(theme.fg("warning", singleLine(`Name generation failed: ${job.naming.error}`, width)));
			if (job.runtime.state === "failed" || job.runtime.state === "lost" || job.runtime.state === "unreachable") {
				if (job.runtime.error) lines.push(theme.fg("error", singleLine(job.runtime.error, width)));
			}
			const output = new Text(clean(this.log), 0, 0).render(width);
			const available = Math.max(0, height - lines.length - 5);
			this.scroll = Math.min(this.scroll, Math.max(0, output.length - available));
			const end = Math.max(0, output.length - this.scroll);
			if (available > 0) lines.push(...output.slice(Math.max(0, end - available), end));
			lines.push(
				theme.fg("muted", `${this.logTruncated ? "Log tail; full output" : "Full output"}: ${clean(job.logPath)}`),
			);
		} else {
			lines.push(theme.fg("muted", clean(this.cwd)));
			if (this.jobs.length === 0) lines.push("No background jobs in this project. Start one with bash async:true.");
			const available = Math.max(1, height - 5);
			const start = Math.max(0, this.selected - available + 1);
			for (let index = start; index < Math.min(this.jobs.length, start + available); index++) {
				const entry = this.jobs[index];
				const summary = `${entry.runtime.state} ${progress(entry, 10)} ${duration(entry)}`;
				const name = singleLine(entry.name, Math.max(0, width - visibleWidth(summary) - 13));
				const row = `${index === this.selected ? ">" : " "} ${entry.id.slice(0, 8)} ${name}  ${summary}`;
				lines.push(index === this.selected ? theme.fg("accent", row) : row);
			}
		}
		if (this.error) lines.push(theme.fg("error", clean(this.error)));
		if (this.editing) {
			lines.push(
				this.editing.type === "rename"
					? "Rename job:"
					: "Replace command and restart (one-line input; use jobs restart for multiline commands):",
			);
			lines.push(...this.editing.input.render(width));
		} else {
			lines.push(
				theme.fg(
					"muted",
					`${keyText("tui.select.confirm")} view · ${keyText("app.jobs.stop")} stop · ${keyText("app.jobs.restart")} restart · ${keyText("app.jobs.rename")} rename`,
				),
			);
			lines.push(
				theme.fg(
					"muted",
					`${keyText("app.jobs.editCommand")} command · ${keyText("app.jobs.delete")} delete · ${keyText("app.pane.minimize")} minimize · ${keyText("tui.select.cancel")} ${this.detail ? "back" : "close"}${this.busy ? " · working" : ""}`,
				),
			);
		}
		return lines.slice(0, height);
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.clock);
		clearTimeout(this.refreshTimer);
		this.rootWatcher.close();
		for (const stop of this.watches.values()) stop();
		this.watches.clear();
	}

	private edit(job: JobInfo, type: Editing["type"]) {
		const input = new Input();
		input.focused = true;
		input.setValue(
			type === "rename" ? clean(job.name).replace(/\n/g, " ") : job.command.includes("\n") ? "" : job.command,
		);
		input.onEscape = () => {
			this.editing = undefined;
			this.controls.invalidate();
		};
		input.onSubmit = (value) => {
			this.editing = undefined;
			if (!value.trim()) {
				this.controls.invalidate();
				return;
			}
			void this.run(async () => {
				if (type === "rename") await this.manager.rename(job.id, value);
				else await this.restart(job.id, value);
			});
		};
		this.editing = { type, id: job.id, input };
	}

	private async restart(id: string, command?: string): Promise<void> {
		const next = await this.manager.restart(id, command);
		this.onSubmitted(next);
		if (!this.disposed) this.detail = next.id;
	}

	private async run(action: () => Promise<unknown>) {
		this.busy = true;
		this.error = undefined;
		this.controls.invalidate();
		try {
			await action();
			await this.refresh();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			if (!this.disposed) this.controls.invalidate();
		}
	}

	private selectedJob(): JobInfo | undefined {
		if (!this.detail) return this.jobs[this.selected];
		return this.detailJob?.id === this.detail ? this.detailJob : this.jobs.find((job) => job.id === this.detail);
	}

	private scheduleRefresh() {
		if (this.disposed || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, 75);
	}

	private async refresh() {
		if (this.disposed) return;
		if (this.refreshing) {
			this.refreshAgain = true;
			return;
		}
		this.refreshing = true;
		try {
			const id = this.detail;
			let detailJob: JobInfo | undefined;
			if (id) {
				try {
					detailJob = await this.manager.inspect(id);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					if (this.detail === id) this.detail = undefined;
					this.refreshAgain = true;
					return;
				}
			}
			// Automatic panes inspect only their own job, rather than rescanning every other job per pane.
			const jobs = detailJob ? [detailJob] : await this.manager.list(this.cwd);
			if (this.disposed) return;
			if (id !== this.detail) {
				this.refreshAgain = true;
				return;
			}
			this.detailJob = detailJob;
			void this.controls
				.setTitle(detailJob ? `Job ${detailJob.id.slice(0, 8)} — ${detailJob.name}` : "Background jobs")
				.catch((error: unknown) => {
					if (!this.disposed) {
						this.error = String(error);
						this.controls.invalidate();
					}
				});
			if (!id) {
				this.jobs = jobs;
				this.selected = Math.max(0, Math.min(this.selected, jobs.length - 1));
			}
			const wanted = new Set(
				jobs
					.filter(
						(job) =>
							isActiveJob(job) ||
							job.id === this.detail ||
							job.naming?.status === "pending" ||
							job.naming?.status === "running",
					)
					.map((job) => job.id),
			);
			for (const [id, stop] of this.watches)
				if (!wanted.has(id)) {
					stop();
					this.watches.delete(id);
				}
			for (const id of wanted)
				if (!this.watches.has(id))
					this.watches.set(
						id,
						this.manager.watch(id, () => this.scheduleRefresh()),
					);
			if (this.detail) {
				const log = this.manager.logs(this.detail, 2000);
				this.log = log.text;
				this.logTruncated = log.truncated;
			}
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.refreshing = false;
			if (!this.disposed) this.controls.invalidate();
			if (this.refreshAgain) {
				this.refreshAgain = false;
				this.scheduleRefresh();
			}
		}
	}
}

function isActiveJob(job: JobInfo): boolean {
	return job.runtime.state === "starting" || job.runtime.state === "running" || job.runtime.state === "unreachable";
}

function clean(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}

function singleLine(text: string, width: number): string {
	return truncateToWidth(clean(text).replace(/\n/g, "\\n"), width);
}

function duration(job: JobInfo): string {
	const runtime = job.runtime;
	const end =
		runtime.state === "completed" ||
		runtime.state === "failed" ||
		runtime.state === "stopped" ||
		runtime.state === "timed_out"
			? runtime.endedAt
			: Date.now();
	return `${Math.max(0, (end - job.runtime.startedAt) / 1000).toFixed(1)}s`;
}

function progress(job: JobInfo, width: number): string {
	if (job.progress) {
		const count = Math.floor((job.progress.percent * width) / 100);
		return `[${"=".repeat(count)}${" ".repeat(width - count)}] ${job.progress.percent}%`;
	}
	if (job.runtime.state !== "running" && job.runtime.state !== "starting") return "";
	const at = Math.floor(Date.now() / 250) % width;
	return `[${" ".repeat(at)}=${" ".repeat(width - at - 1)}]`;
}
