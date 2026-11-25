// The ports tool's card in the TUI, after the web card (src/web/Chat.tsx `ports`): action, port, name and public flag,
// the tool's text, and the forward's addresses as text once opened. Opening them in a browser is a launcher capability
// (p2-tui-port.md section 3.5); OSC 8 hyperlinks stay stripped. `/ports` (P11f) is the web's ports panel.

import { Text } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT, contribute, defineFacet, type HeldIn, liveIn, whenLive } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import {
	confirm,
	getTextOutput,
	ListOverlay,
	type ListRow,
	lineText,
	num,
	record,
	str,
	type ToolRenderers,
	type TuiCommand,
	TuiCommands,
	TuiToolRenderers,
} from "@p2/app/v1/tui";
import { Ports } from "./contract.ts";
import type { ForwardView } from "./protocol.ts";

/** Only Radius forward addresses (the web card's pattern): never arbitrary server-reported URLs. */
const FORWARD = /^https?:\/\/(?:fwd|pub)--[0-9a-f]{32}--[a-z0-9]+\.[^/\s]+\/$/;
const forwardUrl = (value: unknown): string | undefined =>
	typeof value === "string" && FORWARD.test(value) ? value : undefined;

export const portsRenderers: ToolRenderers = {
	renderCall(args, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const port = num(args.port);
		const summary = [
			str(args.action) ?? "",
			port === undefined ? "" : String(port),
			str(args.name) ?? "",
			args.public === true ? "public" : "",
		]
			.filter(Boolean)
			.join(" · ");
		text.setText(`${theme.fg("toolTitle", theme.bold("ports"))} ${theme.fg("accent", lineText(summary))}`);
		return text;
	},
	renderResult(result, _options, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const output = getTextOutput(result).trim();
		const forward = record(record(result.details)?.forward);
		const url = forwardUrl(forward?.url);
		const publicUrl = forwardUrl(forward?.publicUrl);
		const lines = [
			...(output ? [theme.fg(context.isError ? "error" : "toolOutput", output)] : []),
			...(!context.isError && url ? [`${theme.fg("muted", "Open: ")}${theme.fg("mdLink", url)}`] : []),
			...(!context.isError && publicUrl ? [`${theme.fg("muted", "Public: ")}${theme.fg("mdLink", publicUrl)}`] : []),
		];
		text.setText(lines.length ? `\n${lines.join("\n")}` : "");
		return text;
	},
};

/** A change of the list while its call is in flight; an added forward's id and addresses are the server's. */
type PortGuess =
	| { kind: "add"; key: string; port: number; name?: string; public?: boolean }
	| { kind: "remove"; id: string }
	| { kind: "public"; id: string; open: boolean };

function applyPort(forwards: ForwardView[], guess: PortGuess): ForwardView[] {
	if (guess.kind === "add")
		return [
			...forwards,
			{ id: guess.key, port: guess.port, ...(guess.name ? { name: guess.name } : {}), public: guess.public },
		];
	if (guess.kind === "remove") return forwards.filter((forward) => forward.id !== guess.id);
	return forwards.map((forward) => (forward.id === guess.id ? { ...forward, public: guess.open } : forward));
}

/**
 * `/ports [open <port> [name] [public]]` (P11f), after the web's ports panel: the owner's forwards with their
 * addresses; Ctrl+P makes one public or private (public only after a confirmation: anyone with the address can open
 * it), Ctrl+D closes one. `open` adds a forward; a public one is confirmed first.
 */
function openPorts(ctx: TuiContext, args: string | undefined): void {
	const scope = ctx.scope();
	let received: ForwardView[] = [];
	const ref = scope.watch(Ports, {}, (held, follow) => {
		if (held.variant === "owner")
			follow(held.forwards, (value) => {
				received = value;
			});
	});
	// Adding, closing and the public switch show at once; a refused one rolls back with its error.
	const [forwards, changing] = scope.optimistic(() => received, applyPort);
	const change = (guess: PortGuess, call: (service: HeldIn<typeof Ports, "owner">) => Promise<unknown>) =>
		ctx.perform(
			changing(
				guess,
				(async () => {
					// `/ports open` runs before the list arrived: the call waits for the reference.
					await whenLive(ref);
					const service = liveIn(ref, "owner");
					if (!service) throw new Error("Ports are the owner's");
					await call(service);
				})(),
			),
		);
	const publicWarning = (port: number) => [
		`Make port ${port} public?`,
		"Anyone with its public address can open it without signing in.",
	];
	const byRow = (row: ListRow | undefined) => forwards().find((forward) => forward.id === row?.key);
	const overlay = ctx.overlay(
		"ports",
		new ListOverlay(ctx, {
			title: () => `Ports (${forwards().length})`,
			rows: () =>
				forwards().map((forward) => ({
					key: forward.id,
					label: `${forward.name ?? `Port ${forward.port}`}  localhost:${forward.port}${forward.public ? "  public" : ""}`,
					detail: forward.session ? `by ${forward.sessionTitle ?? "another session"}` : "",
					// The card's rule: only Radius forward addresses are shown, never other server-reported URLs.
					description:
						[forwardUrl(forward.url), forwardUrl(forward.publicUrl) && `public: ${forward.publicUrl}`]
							.filter(Boolean)
							.join("  ·  ") || "no address yet (Radius)",
					...(forward.public ? { color: "warning" as const } : {}),
				})),
			actions: [
				{
					key: "ctrl+p",
					label: "public/private",
					run: (row) => {
						const forward = byRow(row);
						if (!forward || forward.id.startsWith("adding-")) return;
						const setPublic = (open: boolean) =>
							change({ kind: "public", id: forward.id, open }, (service) =>
								service.setPublic({ id: forward.id, public: open }, BACKGROUND_CONTEXT),
							);
						if (forward.public) setPublic(false);
						else void confirm(ctx, publicWarning(forward.port)).then((yes) => yes && setPublic(true));
					},
				},
				{
					key: "ctrl+d",
					label: "close",
					run: (row) => {
						const forward = byRow(row);
						if (forward && !forward.id.startsWith("adding-"))
							change({ kind: "remove", id: forward.id }, (service) =>
								service.remove({ id: forward.id }, BACKGROUND_CONTEXT),
							);
					},
				},
			],
			footer: () => [ctx.theme.current.fg("dim", "  /ports open <port> [name] [public] adds one")],
			onClose: () => {
				scope.dispose();
				overlay.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
	// After the overlay: a confirmation opens on top of it.
	const words = args?.trim().split(/\s+/).filter(Boolean) ?? [];
	if (words[0] === "open") {
		const port = Number(words[1]);
		const isPublic = words.includes("public");
		const name = words.slice(2).find((word) => word !== "public");
		if (!Number.isInteger(port) || port < 1 || port > 65535) ctx.notify("Usage: /ports open <port> [name] [public]");
		else
			void (async () => {
				if (isPublic && !(await confirm(ctx, publicWarning(port)))) return;
				const added = { port, ...(name ? { name } : {}), ...(isPublic ? { public: true } : {}) };
				change({ kind: "add", key: `adding-${crypto.randomUUID()}`, ...added }, async (service) => {
					await service.add(added, BACKGROUND_CONTEXT);
					ctx.notify(`Forwarding port ${port}`);
				});
			})();
	}
}

const PORT_COMMANDS: Record<string, TuiCommand> = {
	"p2.ports": {
		title: "Ports",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "ports", argumentHint: "[open <port> [name] [public]]" },
		run: (ctx, args) => openPorts(ctx, args),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-ports", (self) => {
		self.contribute(TuiToolRenderers, { ports: portsRenderers });
		self.contribute(TuiCommands, PORT_COMMANDS);
	}),
);
