// The subagent tool's card in the TUI, after the web card: action and name, the message, the child's configuration,
// and the reply (an answer as Markdown). A running spawn says where the subagent works (DTUI `apply`). Also the
// session selector's subagent conversations (threaded sort, p2-tui-port.md section 1.17).

import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, contribute, defineFacet, liveIn, locationText } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	getTextOutput,
	ListOverlay,
	type ListRow,
	lineText,
	moreLinesHint,
	record,
	safeText,
	shortenPath,
	str,
	type ToolRenderers,
	type TuiCommand,
	TuiCommands,
	TuiScope,
	type TuiSessionSource,
	TuiSessionSources,
	TuiToolRenderers,
} from "@p2/app/v1/tui";
import { type Child, SubagentControl, Subagents } from "./contract.ts";

const PREVIEW_LINES = 10;

const subagentRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		const action = str(args.action);
		const title = theme.fg("toolTitle", theme.bold(action ? `subagent ${lineText(action)}` : "subagent"));
		const name = str(args.name);
		component.addChild(new Text(`${title}${name ? ` ${theme.fg("accent", lineText(name))}` : ""}`, 0, 0));
		const message = str(args.message);
		if (message) {
			const lines = safeText(message).split("\n");
			const shown = context.expanded ? lines : lines.slice(0, PREVIEW_LINES);
			let text = theme.fg("muted", shown.join("\n"));
			if (shown.length < lines.length) text += `\n${moreLinesHint(context.ui, theme, lines.length - shown.length)}`;
			component.addChild(new Text(text, 0, 0));
		}
		return component;
	},
	renderResult(result, options, theme, context) {
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
		component.clear();
		const details = record(result.details);
		const config = [
			typeof details?.model === "string" ? lineText(details.model) : "",
			typeof details?.thinkingLevel === "string" ? `thinking ${lineText(details.thinkingLevel)}` : "",
			Array.isArray(details?.tools)
				? `tools ${details.tools.map((tool) => lineText(String(tool))).join(", ") || "none"}`
				: "",
			typeof details?.cwd === "string"
				? `cwd ${
						typeof details.env === "string"
							? lineText(`${details.env}:${details.cwd}`)
							: lineText(shortenPath(details.cwd, context.cwd) || ".")
					}`
				: "",
		].filter(Boolean);
		if (config.length) component.addChild(new Text(theme.fg("dim", config.join(" · ")), 0, 0));
		const output = getTextOutput(result).trim();
		const conversation = typeof details?.conversationId === "number" ? details.conversationId : undefined;
		if (!output && options.isPartial && conversation !== undefined) {
			component.addChild(new Spacer(1));
			component.addChild(new Text(theme.fg("muted", `Subagent ${conversation} is working.`), 0, 0));
		} else if (output) {
			component.addChild(new Spacer(1));
			component.addChild(
				str(context.args.action) === "answer" && !context.isError
					? new Markdown(output, 0, 0, context.ui.theme.markdown)
					: new Text(theme.fg(context.isError ? "error" : "toolOutput", output), 0, 0),
			);
		}
		return component;
	},
};

/** Named subagents by session (one-shot agents and archived ones are not listed), as the sidebar shows them. */
const sessionSource: TuiSessionSource = {
	children(runtime, onChange) {
		const scope = new TuiScope(runtime);
		scope.watch(Subagents, {}, (ref, follow) => {
			if (ref.variant !== "reader") return;
			follow(ref.children, (children) => {
				const named: Record<string, { name: string; conversationId: number; model: string }[]> = {};
				for (const [session, rows] of Object.entries(children))
					named[session] = rows
						.filter((child) => child.kind !== "agent" && !child.archived)
						.map(({ name, conversationId, model }) => ({ name, conversationId, model }));
				onChange(named);
			});
		});
		return () => scope.dispose();
	},
};

/**
 * `/agents` (pi's DurableTui `selectConversation`, the web sidebar's subagent rows): the session's main conversation,
 * its subagents and one-shot agents. Enter opens one, keeping each conversation's draft and reading position (P0c);
 * participants archive or restore a subagent (one-shot agents are read-only), the archived ones shown on request.
 */
function openAgents(ctx: TuiContext): void {
	const session = ctx.identity.session;
	if (!session) {
		ctx.notify("Open a session first");
		return;
	}
	const scope = ctx.scope();
	let received: Child[] = [];
	scope.watch(Subagents, {}, (ref, follow) => {
		if (ref.variant === "reader")
			follow(ref.children, (value) => {
				received = value[session] ?? [];
			});
	});
	const control = scope.watch(SubagentControl, { session }, () => {});
	// Archive and restore show at once; a refused one flips back with the error.
	const [shown, archiving] = scope.optimistic(
		() => received,
		(children, { conversation, archived }: { conversation: number; archived: boolean }) =>
			children.map((child) => (child.conversationId === conversation ? { ...child, archived } : child)),
	);
	let showArchived = false;
	const close = () => {
		scope.dispose();
		overlay.close();
	};
	const rows = (): ListRow[] => [
		{
			key: String(ctx.identity.main),
			label: "main",
			detail: ctx.identity.conversation === ctx.identity.main ? "✓ shown" : `conversation ${ctx.identity.main}`,
		},
		...shown()
			.filter((child) => showArchived || !child.archived)
			.map((child) => ({
				key: String(child.conversationId),
				label: `${child.kind === "agent" ? "agent " : ""}${child.name}${child.archived ? " (archived)" : ""}`,
				detail: `${ctx.identity.conversation === child.conversationId ? "✓ shown · " : ""}${child.model} · ${child.thinkingLevel}`,
				description: `${child.tools.length ? `tools: ${child.tools.join(", ")}` : "no tools"}${child.location ? ` · in ${lineText(locationText(child.location))}` : " · follows the session"}`,
				...(child.archived ? { color: "muted" as const } : {}),
			})),
	];
	const overlay = ctx.overlay(
		"agents",
		new ListOverlay(ctx, {
			title: () => `Conversations · ${showArchived ? "with archived" : "active"}`,
			rows,
			selected: String(ctx.identity.conversation),
			onSelect: (row) => {
				close();
				ctx.navigate("chat", session, Number(row.key));
			},
			actions: [
				{
					id: "app.session.toggleArchived",
					label: "archived",
					run: () => {
						showArchived = !showArchived;
					},
				},
				{
					id: "app.session.delete",
					label: "archive/restore",
					run: (row) => {
						const child = shown().find((candidate) => String(candidate.conversationId) === row?.key);
						if (!child || child.kind === "agent") return;
						const participant = liveIn(control, "participant");
						if (!participant) {
							ctx.notify("Only participants archive subagents", "warning");
							return;
						}
						const change = { conversation: child.conversationId, archived: !child.archived };
						ctx.perform(
							archiving(change, participant.archive(change, BACKGROUND_CONTEXT)).then(() =>
								ctx.notify(`${change.archived ? "Archived" : "Restored"} ${child.name}`),
							),
						);
					},
				},
			],
			onClose: close,
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

const AGENT_COMMANDS: Record<string, TuiCommand> = {
	"p2.agents": {
		title: "Conversations of this session (subagents)",
		category: "Session",
		when: "chat && !overlay",
		slash: { name: "agents" },
		run: (ctx) => openAgents(ctx),
	},
	"p2.agents.main": {
		title: "Back to the main conversation",
		category: "Session",
		when: "chat && !overlay",
		slash: { name: "main" },
		run: (ctx) => ctx.navigate("chat", ctx.identity.session, ctx.identity.main),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-subagents", (self) => {
		self.contribute(TuiToolRenderers, { subagent: subagentRenderers });
		self.contribute(TuiSessionSources, { subagents: sessionSource });
		self.contribute(TuiCommands, AGENT_COMMANDS);
	}),
);
