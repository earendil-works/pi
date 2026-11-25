// A session's share links on the page, for the share sheet and the command menu: their labels, the URL to copy (the link
// made first when there is none; through Radius a new invite) and resetting one.
import { BACKGROUND_CONTEXT, type Ref } from "@p2/app/v1";
import { readValue } from "@p2/app/v1/web";
import type { ShareInvite, ShareMode, Sharing } from "./contract.ts";

export const LINK_LABEL: Record<ShareMode, string> = { view: "Read-only", full: "Read/write" };

/**
 * Whether making the link of `mode` needs the owner's confirmation first: a first read/write link on a remote
 * environment (`env`) lets guests run commands there.
 */
export const confirmsFirst = (
	mode: ShareMode,
	links: readonly { readonly mode: ShareMode }[] | undefined,
	env: string | null | undefined,
): boolean => mode === "full" && Boolean(env) && !links?.some((link) => link.mode === mode);

/**
 * The URL to hand out for the session's link of `mode` (`Shares.invite`), the link made first when there is none; an
 * invite is valid for `validFor` seconds. A first read/write link on a remote environment needs `remoteConfirmed` (the
 * server refuses it otherwise). `expiresAt` is set for an invite, which opens until then.
 */
export const linkToShare = (
	invites: Ref<typeof ShareInvite>,
	mode: ShareMode,
	validFor: number,
	remoteConfirmed = false,
): Promise<{ url: string; expiresAt: number | null }> =>
	invites.invite({ mode, validFor, ...(remoteConfirmed ? { remoteConfirmed } : {}) }, BACKGROUND_CONTEXT);

/**
 * Replaces the session's link of `mode` (a new token): the guests who joined through the old one lose access, and its
 * invites are withdrawn. A read/write link on a remote environment was confirmed when it was made.
 */
export async function resetLink(sharing: Ref<typeof Sharing>, mode: ShareMode): Promise<void> {
	const remote = mode === "full" && Boolean(readValue(sharing.env));
	await sharing.link({ mode, reset: true, ...(remote ? { remoteConfirmed: true } : {}) }, BACKGROUND_CONTEXT);
}
