// The discord plugin's web facet: Settings › Discord (the owner's bots, BotsSheet.tsx), the Session sheet's Discord row and
// the session's link sheet (LinkSheet.tsx), and the transcript's note on a delivered batch. The sheets render from the
// sidebar foot's slot, which stays mounted while they stack on the Session sheet.
import { contribute, defineFacet } from "@p2/app/v1";
import {
	ChevronIcon,
	openLayer,
	SettingsSections,
	Slots,
	useObject,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { TranscriptEntries } from "../chat/contract.ts";
import { AddBotSheet, BotSheet, BotsSheet } from "./BotsSheet.tsx";
import { DISCORD_BATCH, Discord } from "./contract.ts";
import { HeldDiscord } from "./held.ts";
import { LinkSheet } from "./LinkSheet.tsx";
import "./style.css";

/**
 * Every Discord sheet on top: the bots' as a page of Settings, a session's link on its own. Mounted from the page's
 * start, it holds the owner's `Discord` for them (`held.ts`): they open without a round trip.
 */
function DiscordSheets() {
	const list = useSheet("discord");
	const add = useSheet("discord-add");
	const bot = useSheet("discord-bot");
	const link = useSheet("discord-link");
	const owner = useOwner();
	const discord = useObject(Discord, owner ? {} : undefined);
	if (!owner) return null;
	return (
		<HeldDiscord.Provider value={discord}>
			{list && <BotsSheet />}
			{add && <AddBotSheet />}
			{bot?.locator && <BotSheet id={bot.locator} />}
			{link?.locator && <LinkSheet session={link.locator} />}
		</HeldDiscord.Provider>
	);
}

/** The Session sheet's Discord row: the session's channel, or "Not linked". */
function SessionRow() {
	const session = useRoute().session;
	const bindings = useReadable(useObject(Discord, {})?.bindings);
	if (!session) return null;
	const linked = bindings?.find((binding) => binding.session === session);
	return (
		<button
			type="button"
			className="row-button"
			onClick={() => openLayer({ kind: "sheet", name: "discord-link", locator: session })}
		>
			<span>Discord</span>
			<small className="row-value">{linked ? `#${linked.channelName}` : "Not linked"}</small>
			<ChevronIcon />
		</button>
	);
}

/** A batch's note in the transcript: where it came from. */
function batchDisplay(data: unknown) {
	const discord = (data as { discord?: { channel?: unknown; thread?: unknown; messages?: unknown } } | null)?.discord;
	if (!discord || typeof discord.channel !== "string") return undefined;
	const where =
		typeof discord.thread === "string" ? `thread ${discord.thread} in #${discord.channel}` : `#${discord.channel}`;
	const count = typeof discord.messages === "number" ? discord.messages : 0;
	return { note: `Discord ${where} · ${count} message${count === 1 ? "" : "s"}` };
}

export default defineFacet((host) => {
	contribute(host, "p2.web-discord", (self) => {
		self.contribute(SettingsSections, { discord: { label: "Discord", order: 60, Sheet: DiscordSheets } });
		self.contribute(Slots, {
			"session-rows:discord": SessionRow,
		});
		self.contribute(TranscriptEntries, { [DISCORD_BATCH]: batchDisplay });
	});
});
