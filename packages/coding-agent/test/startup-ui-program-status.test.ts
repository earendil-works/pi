import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiTui from "@earendil-works/pi-tui";
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectTrustContext } from "../src/cli/project-trust.ts";
import { showFirstTimeSetup, showStartupInput, showStartupSelector } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

// Hoisted with vi.mock, which replaces the startup TUI's terminal.
const { FakeTerminal } = vi.hoisted(() => {
	/** Records program status reports and lets the test type into the startup dialog. */
	class FakeTerminal implements Terminal {
		static last: FakeTerminal | undefined;
		readonly reports: ProgramStatus[] = [];
		stopped = false;
		private onInput: ((data: string) => void) | undefined;

		constructor() {
			FakeTerminal.last = this;
		}

		start(onInput: (data: string) => void): void {
			this.onInput = onInput;
		}
		stop(): void {
			this.stopped = true;
		}
		type(data: string): void {
			this.onInput?.(data);
		}
		async drainInput(): Promise<void> {}
		write(): void {}
		get columns(): number {
			return 80;
		}
		get rows(): number {
			return 24;
		}
		get kittyProtocolActive(): boolean {
			return false;
		}
		moveBy(): void {}
		hideCursor(): void {}
		showCursor(): void {}
		clearLine(): void {}
		clearFromCursor(): void {}
		clearScreen(): void {}
		setTitle(): void {}
		setProgress(): void {}
		setProgramStatus(status: ProgramStatus): void {
			this.reports.push(status);
		}
	}
	return { FakeTerminal };
});

vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
	...(await importOriginal<typeof PiTui>()),
	ProcessTerminal: FakeTerminal,
}));

/** Wait until the startup TUI has started, then return its terminal. */
async function startedTerminal(): Promise<InstanceType<typeof FakeTerminal>> {
	await vi.waitFor(() => expect(FakeTerminal.last).toBeDefined());
	return FakeTerminal.last!;
}

// #12439: startup dialogs run before interactive mode and its status reporter exist.
describe("startup dialog program status", () => {
	let agentDir: string;
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-startup-status-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		FakeTerminal.last = undefined;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("reports a selector as blocked on the first line of its title until it is answered", async () => {
		const settingsManager = SettingsManager.inMemory();
		const result = showStartupSelector(settingsManager, "Trust project folder?\n/work/project\n\nDetails", [
			{ label: "Trust", value: true },
		]);
		const terminal = await startedTerminal();
		expect(terminal.reports).toEqual([
			{ state: "blocked", app: "pi", kind: "question", message: "Trust project folder?" },
		]);

		terminal.type("\r");
		expect(await result).toBe(true);
		expect(terminal.stopped).toBe(true);
	});

	it("reports a project trust confirm as a permission request", async () => {
		const context = createProjectTrustContext({
			cwd: "/work/project",
			mode: "interactive",
			settingsManager: SettingsManager.inMemory(),
			hasUI: true,
		});
		const result = context.ui.confirm("Load project extensions?", "They run with your permissions.");
		const terminal = await startedTerminal();
		expect(terminal.reports).toEqual([
			{ state: "blocked", app: "pi", kind: "permission", message: "Load project extensions?" },
		]);

		terminal.type("\r");
		expect(await result).toBe(true);
	});

	// The spec defines permission as approval to do something; trusting a folder lets pi run its extensions.
	it("reports the project trust prompt as a permission request", async () => {
		const projectDir = join(agentDir, "project");
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "settings.json"), "{}");
		const trusted = resolveProjectTrusted({
			cwd: projectDir,
			trustStore: new ProjectTrustStore(agentDir),
			defaultProjectTrust: "ask",
			projectTrustContext: createProjectTrustContext({
				cwd: projectDir,
				mode: "interactive",
				settingsManager: SettingsManager.inMemory(),
				hasUI: true,
			}),
		});
		const terminal = await startedTerminal();
		expect(terminal.reports).toEqual([
			{ state: "blocked", app: "pi", kind: "permission", message: "Trust project folder?" },
		]);

		terminal.type("\r");
		expect(await trusted).toBe(true);
	});

	it("reports the kind an extension passes to a project trust select", async () => {
		const context = createProjectTrustContext({
			cwd: "/work/project",
			mode: "interactive",
			settingsManager: SettingsManager.inMemory(),
			hasUI: true,
		});
		const result = context.ui.select("Run project hooks?", ["Run", "Skip"], { blockedKind: "permission" });
		const terminal = await startedTerminal();
		expect(terminal.reports).toEqual([
			{ state: "blocked", app: "pi", kind: "permission", message: "Run project hooks?" },
		]);

		terminal.type("\r");
		expect(await result).toBe("Run");
	});

	it("reports first-time setup as a permission request", async () => {
		const done = showFirstTimeSetup(SettingsManager.inMemory());
		const terminal = await startedTerminal();
		expect(terminal.reports).toEqual([
			{ state: "blocked", app: "pi", kind: "permission", message: "Opt-in to anonymous usage data sharing?" },
		]);

		terminal.type("\x1b");
		await done;
	});

	it("reports an input as blocked on its title", async () => {
		const result = showStartupInput(SettingsManager.inMemory(), "Project name");
		const terminal = await startedTerminal();
		expect(terminal.reports).toEqual([{ state: "blocked", app: "pi", kind: "question", message: "Project name" }]);

		terminal.type("demo");
		terminal.type("\r");
		expect(await result).toBe("demo");
	});
});
