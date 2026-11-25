// The sharing plugin's part of the command menu, on a session target (owner): Share session… (the share sheet), Copy
// read-only link, Copy read/write link and Reset share link…, with the page that picks the link to reset. Through Radius
// the copy commands open a page that asks how long the invite is valid.
import { BACKGROUND_CONTEXT, keptWith, withHeld } from "@p2/app/v1";
import {
	type Command,
	type CommandContext,
	CommandMenu,
	type CommandPage,
	CopyIcon,
	copyText,
	knownMain,
	openLayerIn,
	RefreshIcon,
	ShareIcon,
	useCommandMatches,
	useCommandMenu,
	useCommandTarget,
	useComposerState,
	useHost,
	useObject,
	useReadable,
} from "@p2/app/v1/web";
import { type ReactNode, useMemo } from "react";
import { SESSIONS_OWNER, Sessions } from "../sessions/contract.ts";
import { ShareInvite, type ShareMode, Sharing } from "./contract.ts";
import { DEFAULT_INVITE_SECONDS, INVITE_DURATIONS } from "./durations.ts";
import { confirmsFirst, LINK_LABEL, linkToShare, resetLink } from "./links.ts";

/** The commands, by id. */
export const SHARING_COMMANDS: Readonly<Record<string, Command>> = {
	"sharing.share": {
		title: "Share session…",
		group: "Sharing",
		order: 40,
		icon: ShareIcon,
		keywords: ["invite", "guests", "people"],
		target: ["session"],
		owner: true,
		Shown: Shareable,
		action: { kind: "run", run: openShareSheet },
	},
	"sharing.copy-view-link": {
		title: "Copy read-only link",
		group: "Sharing",
		order: 40,
		icon: CopyIcon,
		keywords: ["share link", "invite link"],
		target: ["session"],
		owner: true,
		Shown: copyShown("view", "link"),
		action: { kind: "run", run: (ctx) => copyLink(ctx, "view") },
	},
	"sharing.copy-view-invite": {
		title: "Copy read-only link…",
		group: "Sharing",
		order: 40,
		icon: CopyIcon,
		keywords: ["share link", "invite link"],
		target: ["session"],
		owner: true,
		Shown: copyShown("view", "invite"),
		action: { kind: "page", page: "copy-view-invite" },
	},
	"sharing.copy-full-link": {
		title: "Copy read/write link",
		group: "Sharing",
		order: 40,
		icon: CopyIcon,
		keywords: ["share link", "invite link", "write access"],
		target: ["session"],
		owner: true,
		Shown: copyShown("full", "link"),
		action: { kind: "run", run: (ctx) => copyLink(ctx, "full") },
	},
	"sharing.copy-full-invite": {
		title: "Copy read/write link…",
		group: "Sharing",
		order: 40,
		icon: CopyIcon,
		keywords: ["share link", "invite link", "write access"],
		target: ["session"],
		owner: true,
		Shown: copyShown("full", "invite"),
		action: { kind: "page", page: "copy-full-invite" },
	},
	"sharing.reset-link": {
		title: "Reset share link…",
		group: "Sharing",
		order: 40,
		icon: RefreshIcon,
		keywords: ["revoke", "stop sharing", "disconnect guests"],
		target: ["session"],
		owner: true,
		Shown: HasLink,
		action: { kind: "page", page: "reset-share-link" },
	},
};

/** The pages, by name. */
export const SHARING_PAGES: Readonly<Record<string, CommandPage>> = {
	"reset-share-link": { label: "Reset link", placeholder: "Search links…", Body: ResetPage },
	"copy-view-invite": { label: "Valid for", placeholder: "How long…", Body: () => <InvitePage mode="view" /> },
	"copy-full-invite": { label: "Valid for", placeholder: "How long…", Body: () => <InvitePage mode="full" /> },
};

/** The session a command acts on: the target's, when it is a session (a shortcut may run a command without one). */
const targetSession = (target: CommandContext["target"]): string | undefined =>
	target?.type === "session" ? target.id : undefined;

/** Opens the target session's share sheet, over its main conversation (opening it first when another one shows). */
function openShareSheet(ctx: CommandContext): void {
	const id = targetSession(ctx.target);
	if (id !== undefined) openLayerIn(id, knownMain(id), { kind: "sheet", name: "share" });
}

/**
 * Copies the target session's link of `mode`, made first when there is none, as the share sheet's Copy link does. A
 * first read/write link on a remote environment is confirmed in the sheet, not here (the menu has no place to say what
 * it lets guests do there).
 */
async function copyLink(ctx: CommandContext, mode: ShareMode): Promise<void> {
	const id = targetSession(ctx.target);
	if (id !== undefined) await copyFor(ctx.host, id, mode, DEFAULT_INVITE_SECONDS);
}

/** Copies the link of `mode` of `session`, an invite valid for `validFor` seconds when it is one. */
async function copyFor(
	host: CommandContext["host"],
	session: string,
	mode: ShareMode,
	validFor: number,
): Promise<void> {
	await withHeld(host.hold(Sharing, { session }, BACKGROUND_CONTEXT), async (sharing) => {
		if (confirmsFirst(mode, sharing.links.value, sharing.env.value))
			throw new Error("This session works on a remote environment: create its read/write link in the Share sheet");
	});
	const link = await withHeld(host.hold(ShareInvite, { session }, BACKGROUND_CONTEXT), (invites) =>
		linkToShare(invites, mode, validFor),
	);
	if (!(await copyText(link.url))) throw new Error("Could not copy the link");
}

/** Renders `children` while the target session can be shared: known and not archived (its links ended). */
function Shareable({ children }: { children: ReactNode }) {
	return useTargetShares() === undefined ? null : children;
}

/**
 * Shows a copy command for the link of `mode`: the plain one (`link`) while copying hands out the link itself, the one
 * that asks how long (`invite`) while it makes an invite. A read/write link that needs a confirmation (see
 * `confirmsFirst`) is copied in the share sheet only.
 */
function copyShown(mode: ShareMode, kind: "link" | "invite") {
	return function CopyShown({ children }: { children: ReactNode }) {
		const shares = useTargetShares();
		if (shares?.links === undefined || shares.invites === undefined) return null;
		if (shares.invites !== (kind === "invite")) return null;
		return mode === "full" && confirmsFirst("full", shares.links, shares.env) ? null : children;
	};
}

/** How long the invite copied for the target session's link of `mode` is valid; picking one copies it. */
function InvitePage({ mode }: { mode: ShareMode }) {
	const host = useHost();
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const shares = useTargetShares();
	const matches = useCommandMatches(INVITE_DURATIONS, (duration) => duration.label);
	if (!shares) return null;
	return (
		<CommandMenu.Group heading={`${LINK_LABEL[mode]} link valid for`}>
			{matches.map(({ seconds, label }) => (
				<CommandMenu.Row
					key={seconds}
					title={label}
					icon={CopyIcon}
					{...(seconds === DEFAULT_INVITE_SECONDS ? { suffix: "Default" } : {})}
					onSelect={async () => {
						await close();
						await copyFor(host, shares.session, mode, seconds).catch(fail);
					}}
				/>
			))}
		</CommandMenu.Group>
	);
}

/** Renders `children` while the target session has a link to reset. */
function HasLink({ children }: { children: ReactNode }) {
	return useTargetShares()?.links?.length ? children : null;
}

/**
 * The target session's sharing while it can be shared: its id, links and remote environment (the last two undefined
 * until they arrive); undefined for an archived or unknown session, whose sharing is not held.
 */
function useTargetShares() {
	const id = targetSession(useCommandTarget());
	const session = useReadable(keptWith(useObject(Sessions, {}), ...SESSIONS_OWNER)?.sessions)?.find(
		(each) => each.id === id,
	);
	const open = session?.archivedAt === null;
	const sharing = useObject(Sharing, open ? { session: session.id } : undefined);
	const invites = useObject(ShareInvite, open ? { session: session.id } : undefined);
	const links = useReadable(sharing?.links);
	const env = useReadable(sharing?.env);
	const inviting = useReadable(invites?.invites);
	return open ? { session: session.id, links, env, invites: inviting } : undefined;
}

const MODES: readonly ShareMode[] = ["view", "full"];

const resetTitle = (mode: ShareMode): string => `Reset ${LINK_LABEL[mode].toLowerCase()} link`;

/** The target session's links; picking one replaces it, as the share sheet's Reset does. */
function ResetPage() {
	const host = useHost();
	const { close } = useCommandMenu();
	const { fail } = useComposerState();
	const shares = useTargetShares();
	const links = shares?.links;
	const modes = useMemo(() => MODES.filter((mode) => links?.some((link) => link.mode === mode)), [links]);
	const matches = useCommandMatches(modes, resetTitle);
	if (!shares) return null;
	return (
		<CommandMenu.Group heading="Share links">
			{matches.map((mode) => (
				<CommandMenu.Row
					key={mode}
					title={resetTitle(mode)}
					icon={RefreshIcon}
					suffix="Its guests lose access"
					onSelect={async () => {
						await close();
						await withHeld(host.hold(Sharing, { session: shares.session }, BACKGROUND_CONTEXT), (sharing) =>
							resetLink(sharing, mode),
						).catch(fail);
					}}
				/>
			))}
		</CommandMenu.Group>
	);
}
