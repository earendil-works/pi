// Rex CLI transport and owned terminal panes, shared by all pi views.
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { type ExecResult, execCommand } from "./exec.ts";

export type RexLocation = { sessionId: string; blockId: string };
export type RexPane = RexLocation & { layerId?: string };
export type RexPaneOptions = {
	title: string;
	cwd: string;
	command: string[];
	placement: "split" | "floating";
	minimized?: boolean;
};

const inspectValidator = Compile(
	Type.Object({ block: Type.Object({ window_id: Type.Union([Type.String(), Type.Null()]) }) }),
);
const createdValidator = Compile(
	Type.Object({ block_ids: Type.Array(Type.String(), { minItems: 1 }), layer_id: Type.Optional(Type.String()) }),
);
const blocksValidator = Compile(
	Type.Object({ blocks: Type.Array(Type.Object({ block_id: Type.String(), label: Type.String() })) }),
);

/** Use Rex automatically only when pi inherited a concrete Rex session and block. */
export function getRexLocation(): RexLocation | undefined {
	const sessionId = process.env.REX_SESSION;
	const blockId = process.env.REX_BLOCK;
	return sessionId && blockId ? { sessionId, blockId } : undefined;
}

/** Execute CLI arguments without shell interpolation; callers retain Rex's real exit status. */
export function runRex(args: string[], cwd: string, signal?: AbortSignal, timeout = 10000): Promise<ExecResult> {
	return execCommand("rex", args, cwd, { signal, timeout, maxBuffer: 512 * 1024 });
}

/** Open a terminal beside this pi or in a floating layer, preserving its originating window. */
export async function openRexPane(location: RexLocation, options: RexPaneOptions): Promise<RexPane> {
	const label = `pi ${options.title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 75)} ${randomUUID().slice(0, 8)}`;
	if (options.placement === "split") {
		const created = await createRexPane(
			[
				"--autostart=false",
				"split",
				"--session",
				location.sessionId,
				"--block",
				location.blockId,
				"--split=right",
				"--ratio",
				"40",
				"--focus=true",
				"--shell=none",
				"--label",
				label,
				"--cwd",
				options.cwd,
				"--json",
				"--",
				...options.command,
			],
			label,
			location.sessionId,
			options.cwd,
		);
		return { sessionId: location.sessionId, blockId: created.block_ids[0] };
	}
	const inspected = await runRex(
		["--autostart=false", "block", "inspect", "--session", location.sessionId, location.blockId, "--json"],
		options.cwd,
	);
	assertRexSuccess(inspected);
	const block: unknown = JSON.parse(inspected.stdout);
	if (!inspectValidator.Check(block) || !block.block.window_id)
		throw new Error("Originating Rex block is not in a window");
	const created = await createRexPane(
		[
			"--autostart=false",
			"api",
			"call",
			"--session",
			location.sessionId,
			"session.new_layer",
			JSON.stringify({
				session_id: location.sessionId,
				window_id: block.block.window_id,
				bounds: [0.1, 0.1, 0.8, 0.8],
				focus: !options.minimized,
				layout: {
					block: {
						flavor: "com.superlogical.terminal.shell",
						label,
						options: {
							shell: "none",
							command: options.command,
							cwd: options.cwd,
							exit: { on_completion: true, quick_exit_threshold_ms: 0 },
						},
					},
				},
			}),
		],
		label,
		location.sessionId,
		options.cwd,
	);
	if (!created.layer_id) throw new Error("Rex did not return its floating layer ID");
	const pane = { sessionId: location.sessionId, blockId: created.block_ids[0], layerId: created.layer_id };
	try {
		if (options.minimized) await setRexPaneMinimized(pane, true, options.cwd);
		return pane;
	} catch (error) {
		await closeRexPane(pane, options.cwd);
		throw error;
	}
}

/** Minimize or restore one owned floating pane, never a whole Rex session. */
export async function setRexPaneMinimized(pane: RexPane, minimized: boolean, cwd: string): Promise<void> {
	if (!pane.layerId) throw new Error("Only floating Rex panes can be minimized");
	assertRexSuccess(
		await runRex(
			[
				"--autostart=false",
				"api",
				"call",
				"--session",
				pane.sessionId,
				"session.set_layer_state",
				JSON.stringify({
					session_id: pane.sessionId,
					layer_id: pane.layerId,
					state: minimized ? "minimized" : "normal",
					focus: !minimized,
				}),
			],
			cwd,
		),
	);
}

/** Restore an owned floating view or focus its regular split without touching other panes. */
export async function showRexPane(pane: RexPane, cwd: string): Promise<void> {
	if (pane.layerId) await setRexPaneMinimized(pane, false, cwd);
	else assertRexSuccess(await runRex(["--autostart=false", "focus", "--session", pane.sessionId, pane.blockId], cwd));
}

/** Update one owned pane's label without focusing it or changing its process. */
export async function setRexPaneTitle(pane: RexPane, title: string, cwd: string): Promise<void> {
	const label = `pi ${title.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 75)}`;
	assertRexSuccess(
		await runRex(["--autostart=false", "block", "rename", "--session", pane.sessionId, pane.blockId, label], cwd),
	);
}

/** Close only the pane pi opened; independently supervised jobs are unaffected. */
export async function closeRexPane(pane: RexPane, cwd: string): Promise<void> {
	const result = await runRex(["--autostart=false", "block", "close", "--session", pane.sessionId, pane.blockId], cwd);
	// These are immutable full IDs returned at creation; status 3 means the owned pane is already gone.
	if (result.code === 3 && !result.killed && !result.truncated) return;
	assertRexSuccess(result);
}

async function createRexPane(args: string[], label: string, sessionId: string, cwd: string) {
	try {
		return parseCreated(await runRex(args, cwd));
	} catch (error) {
		// A timed-out CLI may already have created its pane. Reconcile our unique label
		// before falling back, and never touch panes that existed before this request.
		const result = await runRex(["--autostart=false", "block", "ls", "--session", sessionId, "--json"], cwd);
		if (result.code === 0 && !result.truncated) {
			const value: unknown = JSON.parse(result.stdout);
			if (blocksValidator.Check(value)) {
				for (const block of value.blocks) {
					if (block.label === label) await closeRexPane({ sessionId, blockId: block.block_id }, cwd);
				}
			}
		}
		throw error;
	}
}

function parseCreated(result: ExecResult) {
	assertRexSuccess(result);
	const value: unknown = JSON.parse(result.stdout);
	if (!createdValidator.Check(value)) throw new Error("Invalid Rex pane creation response");
	return value;
}

function assertRexSuccess(result: ExecResult): void {
	if (result.code !== 0 || result.killed || result.truncated)
		throw new Error(
			result.stderr.trim() || `Rex command failed (${result.code}); inspect before retrying a mutation`,
		);
}
