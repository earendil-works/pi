/**
 * Wrapper for packages/coding-agent/src/main.ts.
 *
 * Adds hub profile support on top of the original CLI entry:
 * - `pipi completion <bash|zsh>` is owned by pi-plus and dispatched before
 *   everything else; it prints a shell completion script and ends the process
 * - hub subcommands (`pipi profile …`, `pipi use`/`pipi unuse`)
 *   are dispatched before pi starts and end the process
 * - `pipi --as <name>` and the stored default profile resolve to a
 *   materialized isolated agent dir; PI_CODING_AGENT_DIR is set in-process
 *   before delegating (getAgentDir() is read lazily, so this is safe)
 * - anything else passes through untouched, with the π+ welcome banner
 *   registered as a hidden built-in extension (TUI startup header)
 */
export * from "../../../coding-agent/src/main.ts";

import type { LaunchPlan } from "@earendil-works/pi-hub";
import {
	dispatchHubCommand,
	findProfile,
	HUB_SUBCOMMANDS,
	materializeProfile,
	resolveLaunch,
	syncProfilePackagesToSource,
} from "@earendil-works/pi-hub";
import { ENV_AGENT_DIR } from "../../../coding-agent/src/config.ts";
import type { MainOptions } from "../../../coding-agent/src/main.ts";
import { main as upstreamMain } from "../../../coding-agent/src/main.ts";
import {
	registerAskUser,
	registerCd,
	registerContextGuard,
	registerInit,
	registerMemory,
	registerPlan,
	registerSubagent,
	registerTasks,
	registerUserHooks,
} from "../../../plus/src/extensions/index.ts";
import { dispatchCompletion } from "../completion/index.ts";
import { registerPlainTools, registerTabTitle } from "../extensions/index.ts";
import { registerBanner } from "./ui/banner.ts";
import { registerVim } from "./ui/vim/extension.ts";

export async function main(args: string[], options?: MainOptions) {
	// Plus-owned: completes the whole pipi CLI (hub + native pi commands).
	if (args[0] === "completion") {
		try {
			dispatchCompletion(args.slice(1));
			return;
		} catch (err) {
			console.error("Error:", err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	}

	let plan: LaunchPlan;
	try {
		if (args[0] && HUB_SUBCOMMANDS.has(args[0])) {
			dispatchHubCommand(args);
			return;
		}
		plan = resolveLaunch(args);
	} catch (err) {
		console.error("Error:", err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	if (plan.kind === "profile") {
		const profile = findProfile(plan.name);
		if (!profile) {
			console.error(`Error: Profile '${plan.name}' not found. Use 'pipi profile list' to see available profiles.`);
			process.exit(1);
		}
		// ENV_AGENT_DIR is the original config module's constant
		// ("PI_CODING_AGENT_DIR"); the plus config wrapper shadows only the
		// display name, not the env var layout.
		const profileDir = materializeProfile(plan.name, profile);
		process.env[ENV_AGENT_DIR] = profileDir;
		// The profile's settings.json is a per-profile copy, but packages are
		// global (npm/extensions are shared symlinks): install/remove and
		// resource toggles persist `packages` into the profile copy, which the
		// next materialization would discard — syncing it back to the source at
		// exit (synchronous, runs after upstream's settings write queue has
		// drained and even when upstream called process.exit for the command).
		process.on("exit", () => {
			syncProfilePackagesToSource(profileDir);
		});
	}

	// The upstream version check polls pi.dev for pi's release train, not pi-plus's.
	process.env.PI_SKIP_VERSION_CHECK = "1";

	// Hidden built-ins: the π+ welcome banner replaces pi's startup header in TUI
	// mode; pi-plus-cd adds /cd, moving the session to a different working
	// directory (the session file relocates to the target cwd's session dir
	// with only its header cwd rewritten, then the runtime switches to it —
	// same conversation, new project context); pi-plus-vim enables vim modal
	// editing when the "vim" setting is on;
	// pi-plus-subagent delegates tasks to isolated sub-agent processes;
	// pi-plus-tasks adds the TaskCreate/TaskUpdate/TaskList/TaskGet tools and the
	// /tasks command (ctrl+y); pi-plus-memory adds per-project long-term memory
	// (memory_save/memory_recall tools, MEMORY.md index injected into the system
	// prompt, /memory command, background extraction of noteworthy facts at turn
	// end); pi-plus-plan adds plan mode (EnterPlanMode /
	// ExitPlanMode tools, /plan command, ctrl+alt+p toggle) — a read-only
	// research phase whose plan file is the only writable target until the user
	// approves via ExitPlanMode; pi-plus-ask-user adds the ask_user tool, letting
	// the model ask 1-4 structured questions (options, multi-select, free-text
	// Other) mid-task in TUI/RPC modes; pi-plus-hooks fires command hooks
	// declared in settings.json under a "hooks" key on PermissionRequest /
	// PreToolUse / Stop analogues; pi-plus-tab-title owns the terminal tab
	// title ("pi+ - [name -] dir") and prepends a spinner frame while the
	// agent is working; pi-plus-plain-tools strips the background fills from
	// tool result blocks (upstream paints them pending/success/error) so tool
	// status reads as text, consistent with the subagent tool's word-based
	// status; pi-plus-init adds /init (create or improve the project
	// instructions file PI.md at the cwd root) and auto-loads PI.md into every
	// agent run via the system prompt's context files, same as AGENTS.md.
	// Merged with any caller-provided factories; upstream appends its own
	// built-ins (main.ts: extensionFactories = [...builtInExtensions, ...]).
	const merged: MainOptions = {
		...options,
		extensionFactories: [
			...(options?.extensionFactories ?? []),
			{ name: "pi-plus-banner", factory: registerBanner, hidden: true },
			{ name: "pi-plus-cd", factory: registerCd, hidden: true },
			{ name: "pi-plus-vim", factory: registerVim, hidden: true },
			{ name: "pi-plus-subagent", factory: registerSubagent, hidden: true },
			{ name: "pi-plus-tasks", factory: registerTasks, hidden: true },
			{ name: "pi-plus-memory", factory: registerMemory, hidden: true },
			{ name: "pi-plus-plan", factory: registerPlan, hidden: true },
			{ name: "pi-plus-ask-user", factory: registerAskUser, hidden: true },
			{ name: "pi-plus-hooks", factory: registerUserHooks, hidden: true },
			{ name: "pi-plus-context-guard", factory: registerContextGuard, hidden: true },
			{ name: "pi-plus-init", factory: registerInit, hidden: true },
			{ name: "pi-plus-tab-title", factory: registerTabTitle, hidden: true },
			{ name: "pi-plus-plain-tools", factory: registerPlainTools, hidden: true },
		],
	};
	return upstreamMain(plan.remainingArgs, merged);
}
