// The terminals' commands for the command menu, the owner's as the terminal button is: Open terminal and New terminal on
// a session or a subagent's conversation (new terminals open where the viewed conversation works).
import { type Command, type CommandContext, PlusIcon, TerminalIcon, useCommandTarget, useRoute } from "@p2/app/v1/web";
import type { ReactNode } from "react";
import { commandSession, NotArchived, openPanelIn } from "../sessions/contract.web.tsx";
import { requestNewTerminal } from "./new-terminal.ts";
import { terminalShown, withTerminal } from "./Terminal.tsx";

const TARGETS = ["session", "conversation"];

/** The commands, by id. */
export const TERMINAL_COMMANDS: Readonly<Record<string, Command>> = {
	"terminals.open": {
		title: "Open terminal",
		group: "Terminal",
		order: 33,
		icon: TerminalIcon,
		keywords: ["show terminal", "shell"],
		target: TARGETS,
		owner: true,
		Shown: NotShown,
		action: { kind: "run", run: openTerminal },
	},
	"terminals.new": {
		title: "New terminal",
		group: "Terminal",
		order: 33,
		icon: PlusIcon,
		keywords: ["start terminal", "shell"],
		target: TARGETS,
		owner: true,
		Shown: NotArchived,
		action: { kind: "run", run: openNew },
	},
};

/** Shows the command's session's terminal as the terminal button does: where the reader last had it, one started if none. */
function openTerminal(ctx: CommandContext): void {
	const id = commandSession(ctx.target, ctx.route);
	if (id !== undefined) openPanelIn(id, withTerminal);
}

/** Opens a new terminal in the command's session, as the terminal's "+" does, showing the terminal first if it is not. */
function openNew(ctx: CommandContext): void {
	const id = commandSession(ctx.target, ctx.route);
	if (id === undefined) return;
	requestNewTerminal(id);
	if (id !== ctx.route.session || !terminalShown(ctx.route)) openPanelIn(id, withTerminal);
}

/** Renders `children` unless the command's session shows its terminal already (or is archived). */
function NotShown({ children }: { children: ReactNode }) {
	const route = useRoute();
	const shown = commandSession(useCommandTarget(), route) === route.session && terminalShown(route);
	return shown ? null : <NotArchived>{children}</NotArchived>;
}
