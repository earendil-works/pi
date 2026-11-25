// How long an invite through Radius opens (see `Shares` in contract.ts): the choices the owner picks from when copying a
// link, in the share sheet, the command menu and the TUI, and how its end is shown.

/** The longest an invite may open: what Radius allows (gateway `servers/guests.ts`). */
export const MAX_INVITE_SECONDS = 7 * 24 * 60 * 60;

/** The choices, shortest first. */
export const INVITE_DURATIONS: readonly { readonly seconds: number; readonly label: string }[] = [
	{ seconds: 15 * 60, label: "15 minutes" },
	{ seconds: 60 * 60, label: "1 hour" },
	{ seconds: 24 * 60 * 60, label: "1 day" },
	{ seconds: MAX_INVITE_SECONDS, label: "7 days" },
];

/** The choice preselected. */
export const DEFAULT_INVITE_SECONDS = 60 * 60;

/** When an invite stops opening, for "valid until …": the time, with the day unless it is today. */
export function validUntil(expiresAt: number): string {
	const date = new Date(expiresAt);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: date.toLocaleString([], {
				weekday: "short",
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			});
}
