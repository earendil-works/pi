// A session's share links on the page, for the share sheet and the command menu: their labels, copying a link (made
// first when there is none) and resetting one.
import { BACKGROUND_CONTEXT, type Held } from "@p2/app/v1";
import { readValue } from "@p2/app/v1/web";
import type { ShareMode, Sharing } from "./contract.ts";

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
 * The URL of the session's link of `mode`, made first when there is none; a first read/write link on a remote
 * environment needs `remoteConfirmed` (the server refuses it otherwise).
 */
export async function linkUrl(
	sharing: Held<typeof Sharing>,
	mode: ShareMode,
	remoteConfirmed = false,
): Promise<string | undefined> {
	const urlOf = () => readValue(sharing.links)?.find((link) => link.mode === mode)?.url;
	if (urlOf() === undefined)
		await sharing.link({ mode, ...(remoteConfirmed ? { remoteConfirmed } : {}) }, BACKGROUND_CONTEXT);
	// The answer follows its state: the new link is in `links` when the call resolves.
	return urlOf();
}

/**
 * Replaces the session's link of `mode` (a new token): the guests who joined through the old one lose access. A
 * read/write link on a remote environment was confirmed when it was made.
 */
export async function resetLink(sharing: Held<typeof Sharing>, mode: ShareMode): Promise<void> {
	const remote = mode === "full" && Boolean(readValue(sharing.env));
	await sharing.link({ mode, reset: true, ...(remote ? { remoteConfirmed: true } : {}) }, BACKGROUND_CONTEXT);
}
