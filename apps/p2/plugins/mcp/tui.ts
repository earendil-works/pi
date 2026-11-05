// `/mcp` in the TUI (owners), after the web's MCP sheet: the running servers with status, place, tools and errors;
// Ctrl+R restarts one, Ctrl+S signs in to an HTTP server using OAuth (the authorization page opens through the
// launcher's `openUrl`, confirmed in its own screen), Ctrl+O signs out. The sign-in returns to a loopback callback on
// the p2 host; a browser elsewhere ends on a page that does not load, whose address `/mcp paste <url>` completes.

import {
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	type Held,
	type HeldIn,
	liveIn,
	locationText,
	until,
	whenLive,
} from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import { ListOverlay, type ListRow, lineText, type TuiCommand, TuiCommands } from "@p2/app/v1/tui";
import { type Instance, Mcp, type SignIn } from "./contract.ts";

type OwnerView = HeldIn<typeof Mcp, "owner">;

const STATUS: Record<Instance["status"], string> = {
	starting: "starting",
	connected: "connected",
	"sign-in": "sign-in needed",
	failed: "failed",
};

const COLOR: Record<Instance["status"], ListRow["color"]> = {
	starting: "muted",
	connected: "success",
	"sign-in": "warning",
	failed: "error",
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `/mcp [paste <url>]`: the overlay, or a pasted redirect URL for the sign-in waiting for it. */
function openMcp(ctx: TuiContext, args: string | undefined): void {
	const words = args?.trim().split(/\s+/).filter(Boolean) ?? [];
	if (words[0] === "paste") {
		const ref = ctx.host.hold(Mcp, {}, BACKGROUND_CONTEXT);
		void paste(ctx, ref, words[1]).finally(() => ref.release());
		return;
	}
	const scope = ctx.scope();
	let received: Instance[] = [];
	let signIns: SignIn[] = [];
	let status = "";
	const held = scope.watch(Mcp, {}, (mcp, follow) => {
		const view = liveIn(mcp, "owner");
		if (!view) return;
		follow(view.instances, (value) => {
			received = value;
		});
		follow(view.signIns, (value) => {
			signIns = value;
		});
	});
	// A restart shows the server starting and a sign-out signed out at once; the status line follows the call.
	type StatusGuess = { instance: string; status: Instance["status"] };
	const [instances, changing] = scope.optimistic(
		() => received,
		(list, guess: StatusGuess) =>
			list.map((instance) => (instance.id === guess.instance ? { ...instance, status: guess.status } : instance)),
	);
	const run = (label: string, action: (view: OwnerView) => Promise<unknown>, guess?: StatusGuess) => {
		const view = liveIn(held, "owner");
		if (view === undefined) return;
		status = `${label}…`;
		const call = (async () => {
			try {
				await action(view);
				status = `${label}: done`;
			} catch (error) {
				status = `${label}: ${messageOf(error)}`;
				throw error;
			}
		})();
		// The status line shows how it ended, a failure included.
		void (guess ? changing(guess, call) : call).catch(() => ctx.requestRender());
		ctx.requestRender();
	};
	const byRow = (row: ListRow | undefined) => instances().find((instance) => instance.id === row?.key);
	const signIn = (view: OwnerView, server: string) =>
		view.signIn({ server }, BACKGROUND_CONTEXT).then(async (start) => {
			if (start.kind === "authorized") return;
			const opened = await ctx.grant("openUrl", { kind: "external", url: start.url });
			status = opened.ok
				? `Signing in to ${server}: finish in the browser; if it ends on a page that does not load, /mcp paste <its address>`
				: `Open the sign-in page in a browser (${opened.error}); /mcp paste <final address> if it does not return`;
		});
	const overlay = ctx.overlay(
		"mcp",
		new ListOverlay(ctx, {
			title: () => `MCP servers (${instances().length})`,
			rows: () =>
				instances().map((instance) => {
					const flow = signIns.find((entry) => entry.server === instance.server);
					const place = [
						instance.location ? locationText(instance.location) : "",
						instance.runsOn === "host" ? "" : `on ${instance.runsOn.env}`,
					]
						.filter(Boolean)
						.join(" · ");
					return {
						key: instance.id,
						label: lineText(`${instance.server}  ${STATUS[instance.status]}`),
						detail: lineText(
							instance.status === "connected"
								? `${instance.tools.length} tool${instance.tools.length === 1 ? "" : "s"}`
								: place,
						),
						description: lineText(
							flow?.status === "waiting"
								? "sign-in waiting for the browser (/mcp paste <url> completes it)"
								: flow?.status === "failed"
									? `sign-in failed: ${flow.error ?? ""}`
									: (instance.error ?? place),
						),
						color: COLOR[instance.status],
					};
				}),
			actions: [
				{
					key: "ctrl+r",
					label: "restart",
					run: (row) => {
						const instance = byRow(row);
						if (instance)
							run(
								`Restarting ${instance.server}`,
								(view) => view.restart({ instance: instance.id }, BACKGROUND_CONTEXT),
								{ instance: instance.id, status: "starting" },
							);
					},
				},
				{
					key: "ctrl+s",
					label: "sign in",
					run: (row) => {
						const instance = byRow(row);
						if (instance?.auth === "oauth")
							run(`Signing in to ${instance.server}`, (view) => signIn(view, instance.server));
					},
				},
				{
					key: "ctrl+o",
					label: "sign out",
					run: (row) => {
						const instance = byRow(row);
						if (instance?.auth === "oauth")
							run(
								`Signing out of ${instance.server}`,
								(view) => view.signOut({ server: instance.server }, BACKGROUND_CONTEXT),
								{ instance: instance.id, status: "sign-in" },
							);
					},
				},
			],
			footer: () => (status ? [ctx.theme.current.fg("muted", `  ${lineText(status)}`)] : []),
			onClose: () => {
				scope.dispose();
				overlay.close();
			},
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

/** Completes the waiting sign-in whose redirect URL `url` is (each waiting one is tried: the URL's state picks it). */
async function paste(ctx: TuiContext, ref: Held<typeof Mcp>, url: string | undefined): Promise<void> {
	if (!url) return ctx.notify("Usage: /mcp paste <final redirect URL>");
	try {
		await whenLive(ref);
		const view = liveIn(ref, "owner");
		if (view === undefined) return ctx.notify("MCP servers are for the owner", "error");
		const signIns = await until(view.signIns, () => true, BACKGROUND_CONTEXT);
		const waiting = signIns.filter((entry) => entry.status === "waiting");
		if (waiting.length === 0) return ctx.notify("No MCP sign-in is waiting", "error");
		let failure: unknown;
		for (const entry of waiting) {
			try {
				await view.paste({ id: entry.id, redirectUrl: url }, BACKGROUND_CONTEXT);
				return ctx.notify(`Signed in to ${entry.server}`);
			} catch (error) {
				failure = error;
			}
		}
		ctx.notify(messageOf(failure), "error");
	} catch (error) {
		ctx.notify(messageOf(error), "error");
	}
}

const COMMANDS: Record<string, TuiCommand> = {
	"p2.mcp": {
		title: "MCP servers",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "mcp", argumentHint: "[paste <url>]" },
		run: (ctx, args) => openMcp(ctx, args),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-mcp", (self) => {
		self.contribute(TuiCommands, COMMANDS);
	}),
);
