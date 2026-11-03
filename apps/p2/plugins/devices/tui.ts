// `/devices` in the TUI (p2-tui-port.md P11g), after the web's Devices sheet (owner): a one-time sign-in token for
// another device (only the localhost device owner may mint one), and signing out this device or all devices. Signing
// out is the launcher's: the TUI's sign-in cookie lives there, never in this worker, so it is a C launcher action
// (`signOut`, section 3.2) whose consent UI shows the scope ("all devices, this one included").

import { BACKGROUND_CONTEXT, contribute, defineFacet, follow, statusOf } from "@p2/app/v1";
import type { TuiContext } from "@p2/app/v1/tui";
import { grantNotice, ListOverlay, lineText, TextOverlay, type TuiCommand, TuiCommands } from "@p2/app/v1/tui";
import { Devices } from "./contract.ts";

function showToken(ctx: TuiContext, token: string): void {
	const handle = ctx.overlay(
		"device-token",
		new TextOverlay(
			ctx,
			"One-time sign-in token",
			() => [
				"This token grants full owner access. Give it only to your own device, not to collaborators.",
				"Open Pi's domain on the other device, paste it into the sign-in page and sign in. It expires.",
				"",
				`  ${lineText(token)}`,
			],
			() => handle.close(),
		),
		{ width: "90%", anchor: "center" },
	);
}

/**
 * The launcher's consent UI (section 3.3) is the confirmation: it states the scope before anything is signed out. On
 * success the server revokes this connection; the launcher then forgets its cookie and asks for an owner link. The
 * device owner on loopback has no cookie, so "this device" is refused there (`denied`, like declining).
 */
async function signOut(ctx: TuiContext, all: boolean): Promise<void> {
	const result = await ctx.grant("signOut", { all });
	if (!result.ok && result.error === "denied") ctx.notify("Not signed out", "warning");
	else grantNotice(ctx, all ? "Signed out all devices" : "Signed out on this device", result);
}

function openDevices(ctx: TuiContext): void {
	const ref = ctx.host.hold(Devices, {}, BACKGROUND_CONTEXT);
	let canMint: boolean | undefined;
	let status = "";
	const stop = follow(ref.canMint, (value) => {
		canMint = value ?? undefined;
		ctx.requestRender();
	});
	const close = () => {
		stop();
		ref.release();
		overlay.close();
	};
	const overlay = ctx.overlay(
		"devices",
		new ListOverlay(ctx, {
			title: "Devices",
			rows: () => [
				...(canMint
					? [{ key: "token", label: "Generate a one-time sign-in token for another device" }]
					: [
							{
								key: "token-help",
								label: "Tokens come from the host: npm run owner-link (associated devices cannot mint)",
								color: "muted" as const,
							},
						]),
				{ key: "signout", label: "Sign out on this device" },
				{ key: "signout-all", label: "Sign out all devices", color: "error" as const },
			],
			onSelect: (row) => {
				if (row.key === "token") {
					if (statusOf(ref) !== "live" || ref.variant !== "owner") return;
					status = "Generating token…";
					void ref
						.token(BACKGROUND_CONTEXT)
						.then(({ token }) => {
							status = "";
							showToken(ctx, token);
						})
						.catch((error: unknown) => {
							status = error instanceof Error ? error.message : "Could not generate a sign-in token.";
						})
						.finally(() => ctx.requestRender());
				} else if (row.key === "signout" || row.key === "signout-all") {
					close();
					void signOut(ctx, row.key === "signout-all");
				}
			},
			footer: () => (status ? [ctx.theme.current.fg("muted", `  ${lineText(status)}`)] : []),
			onClose: close,
		}),
		{ width: "100%", anchor: "bottom-center" },
	);
}

const COMMANDS: Record<string, TuiCommand> = {
	"p2.devices": {
		title: "Devices and sign-out",
		category: "Owner",
		when: "owner && !overlay",
		slash: { name: "devices" },
		run: (ctx) => openDevices(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-devices", (self) => {
		self.contribute(TuiCommands, COMMANDS);
	}),
);
