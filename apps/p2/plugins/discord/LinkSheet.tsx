// A session's Discord link (its Session sheet → Discord): linked, the bot and channel with Unlink; otherwise the form
// that links it: the bot, its server, a channel no other session has, who may wake Pi, the sandbox the session moves
// into, and what it may use there. Link stays disabled, saying what is missing, until every choice is made.
import { BACKGROUND_CONTEXT, LOCK_CAPABILITIES, type LockCapability, type SessionLock } from "@p2/app/v1";
import { closeLayers, errorText, openLayer, Sheet, useObject, useReadable } from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { Envs } from "../envs/contract.ts";
import { SessionLock as SessionLockView, Sessions } from "../sessions/contract.ts";
import { back, botName } from "./BotsSheet.tsx";
import { type Binding, Discord, type ServerDetails, type Wake } from "./contract.ts";

const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

const CAPABILITY_LABELS: Record<LockCapability, string> = {
	ports: "Forward ports",
	conversations: "Message other sessions",
};

/** Discord user IDs, one per line or comma-separated. */
const ids = (text: string): string[] =>
	text
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter((id) => /^\d{5,30}$/.test(id));

function wakeText(wake: Wake, roles?: ServerDetails["roles"]): string {
	if (wake.anyone) return "Anyone in the channel";
	const names = wake.roles.map((role) => roles?.find((each) => each.id === role)?.name ?? "a role");
	const users = wake.users.length ? [`${wake.users.length} user${wake.users.length === 1 ? "" : "s"}`] : [];
	return [...names.map((name) => `@${name}`), ...users].join(", ") || "Nobody";
}

function lockText(lock: SessionLock | undefined): string {
	if (!lock) return "Nothing extra";
	const parts = [
		...lock.mcp.map((server) => `MCP ${server}`),
		...(lock.projectMcp ? ["project MCP servers"] : []),
		...(lock.instructions ? ["your instructions"] : []),
		...lock.capabilities.map((capability) => CAPABILITY_LABELS[capability].toLowerCase()),
	];
	return parts.join(", ") || "Nothing extra";
}

/** Session `session`'s Discord sheet. */
export function LinkSheet({ session }: { session: string }) {
	const discord = useObject(Discord, {});
	const bindings = useReadable(discord?.bindings);
	const linked = bindings?.find((binding) => binding.session === session);
	return (
		<Sheet title="Discord" onClose={closeLayers} onBack={back} className="discord-sheet">
			{!bindings ? (
				<p className="empty-note">Loading…</p>
			) : linked ? (
				<Linked binding={linked} />
			) : (
				<LinkForm session={session} bindings={bindings} />
			)}
		</Sheet>
	);
}

function Linked({ binding }: { binding: Binding }) {
	const discord = useObject(Discord, {});
	const bot = useReadable(discord?.bots)?.find((each) => each.id === binding.botId);
	const row = useReadable(useObject(Sessions, {}, { variant: "owner" })?.sessions)?.find(
		(each) => each.id === binding.session,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<>
			<p className="muted small">
				Mentioning the bot in the channel wakes this session. It works in its sandbox, with only what is listed
				here.
			</p>
			<div className="list">
				<div className="discord-row">
					<span>Bot</span>
					<small className="row-value">{bot ? botName(bot) : "Removed"}</small>
				</div>
				<div className="discord-row">
					<span>Channel</span>
					<small className="row-value">
						{binding.guildName} › #{binding.channelName}
					</small>
				</div>
				<div className="discord-row">
					<span>Who may wake Pi</span>
					<small className="row-value">{wakeText(binding.wake)}</small>
				</div>
				<div className="discord-row">
					<span>Sandbox</span>
					<small className="row-value">{row?.env ?? "–"}</small>
				</div>
				<LockRow session={binding.session} />
			</div>
			{error && <output className="notice error">{error}</output>}
			<div className="list">
				<button
					type="button"
					className="row-button danger"
					disabled={busy || !discord}
					onClick={() => {
						if (!discord) return;
						setBusy(true);
						setError(undefined);
						discord
							.unlink({ session: binding.session }, BACKGROUND_CONTEXT)
							.catch((reason: unknown) => setError(errorText(reason)))
							.finally(() => setBusy(false));
					}}
				>
					<span>{busy ? "Unlinking…" : "Unlink"}</span>
				</button>
			</div>
		</>
	);
}

/** What the session may use, from its lock (the sessions plugin's). */
function LockRow({ session }: { session: string }) {
	const locks = useReadable(useObject(SessionLockView, {}, { variant: "owner" })?.locks);
	return (
		<div className="discord-row">
			<span>May use</span>
			<small className="row-value">{lockText(locks?.[session])}</small>
		</div>
	);
}

type Draft = {
	bot: string;
	guild: string;
	channel: string;
	who: "anyone" | "roles";
	roles: string[];
	users: string;
	sandbox: string;
	mcp: string[];
	projectMcp: boolean;
	instructions: boolean;
	capabilities: LockCapability[];
};

const EMPTY: Draft = {
	bot: "",
	guild: "",
	channel: "",
	who: "roles",
	roles: [],
	users: "",
	sandbox: "",
	mcp: [],
	projectMcp: false,
	instructions: false,
	capabilities: [],
};

const toggle = <T,>(list: readonly T[], value: T, on: boolean): T[] =>
	on ? [...list.filter((entry) => entry !== value), value] : list.filter((entry) => entry !== value);

function LinkForm({ session, bindings }: { session: string; bindings: readonly Binding[] }) {
	const discord = useObject(Discord, {});
	const bots = (useReadable(discord?.bots) ?? []).filter((bot) => bot.status.state === "connected");
	const sessions = useReadable(useObject(Sessions, {}, { variant: "owner" })?.sessions) ?? [];
	const sandboxes = (useReadable(useObject(Envs, {})?.envs) ?? []).filter((env) => env.config.type === "gondolin");
	const [draft, setDraft] = useState<Draft>(EMPTY);
	const [details, setDetails] = useState<{ key: string; value: ServerDetails }>();
	const [servers, setServers] = useState<string[]>([]);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
	// One bot or sandbox: chosen already.
	const onlyBot = bots.length === 1 ? bots[0]?.id : undefined;
	const onlySandbox = sandboxes.length === 1 ? sandboxes[0]?.name : undefined;
	const bot = bots.find((each) => each.id === (draft.bot || onlyBot));
	const guilds = bot?.status.state === "connected" ? bot.status.guilds : [];
	const guild = guilds.find((each) => each.id === (draft.guild || (guilds.length === 1 ? guilds[0]?.id : "")));
	const sandbox = draft.sandbox || onlySandbox || "";
	const key = bot && guild ? `${bot.id}/${guild.id}` : "";
	const server = details?.key === key ? details.value : undefined;
	useEffect(() => {
		if (!discord) return;
		discord.mcpServers(BACKGROUND_CONTEXT).then(setServers, () => {});
	}, [discord]);
	const botId = bot?.id;
	const guildId = guild?.id;
	useEffect(() => {
		if (!discord || !botId || !guildId) return;
		let current = true;
		discord.server({ bot: botId, guild: guildId }, BACKGROUND_CONTEXT).then(
			(value) => {
				if (current) setDetails({ key: `${botId}/${guildId}`, value });
			},
			(reason: unknown) => {
				if (current) setError(errorText(reason));
			},
		);
		return () => {
			current = false;
		};
	}, [discord, botId, guildId]);
	const takenBy = (channel: string) => {
		const owner = bindings.find((binding) => binding.channelId === channel);
		return owner && (sessions.find((each) => each.id === owner.session)?.title ?? "another session");
	};
	const users = ids(draft.users);
	const missing = [
		!bot && "a bot",
		bot && !guild && "a server",
		guild && (!draft.channel || takenBy(draft.channel)) && "a channel",
		draft.who === "roles" && !draft.roles.length && !users.length && "who may wake Pi",
		!sandbox && "a sandbox",
	].filter((entry): entry is string => Boolean(entry));
	return (
		<form
			className="stack discord-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!discord || !bot || !guild || missing.length) return;
				setBusy(true);
				setError(undefined);
				discord
					.link(
						{
							session,
							bot: bot.id,
							guild: guild.id,
							channel: draft.channel,
							wake: { anyone: draft.who === "anyone", users, roles: draft.who === "anyone" ? [] : draft.roles },
							sandbox,
							lock: {
								mcp: draft.mcp,
								projectMcp: draft.projectMcp,
								instructions: draft.instructions,
								capabilities: draft.capabilities,
							},
						},
						BACKGROUND_CONTEXT,
					)
					.catch((reason: unknown) => setError(errorText(reason)))
					.finally(() => setBusy(false));
			}}
		>
			<p className="muted small">
				Link this session to a Discord channel: mentioning the bot there wakes it. It moves into a sandbox and can
				use only what you pick here, for everyone who may wake it.
			</p>
			<div className="field">
				<span className="label">Bot</span>
				{bots.length ? (
					<select
						className="input"
						aria-label="Bot"
						value={bot?.id ?? ""}
						onChange={(event) => update({ bot: event.target.value, guild: "", channel: "", roles: [] })}
					>
						{!onlyBot && <option value="">Pick a bot</option>}
						{bots.map((each) => (
							<option key={each.id} value={each.id}>
								{botName(each)}
							</option>
						))}
					</select>
				) : (
					<span className="muted small">
						No connected bot.{" "}
						<button
							type="button"
							className="text-action"
							onClick={() => openLayer({ kind: "sheet", name: "discord" }, { fromDrawer: true })}
						>
							Add one under Discord
						</button>
					</span>
				)}
			</div>
			{bot && (
				<div className="field">
					<span className="label">Server</span>
					{guilds.length ? (
						<select
							className="input"
							aria-label="Server"
							value={guild?.id ?? ""}
							onChange={(event) => update({ guild: event.target.value, channel: "", roles: [] })}
						>
							{guilds.length > 1 && <option value="">Pick a server</option>}
							{guilds.map((each) => (
								<option key={each.id} value={each.id}>
									{each.name}
								</option>
							))}
						</select>
					) : (
						<span className="muted small">
							The bot is in no server yet: invite it from its sheet under Discord.
						</span>
					)}
				</div>
			)}
			{guild && (
				<label className="field">
					<span className="label">Channel</span>
					<select
						className="input"
						value={draft.channel}
						onChange={(event) => update({ channel: event.target.value })}
					>
						<option value="">{server ? "Pick a channel" : "Loading channels…"}</option>
						{server?.channels.map((channel) => {
							const taken = takenBy(channel.id);
							return (
								<option key={channel.id} value={channel.id} disabled={Boolean(taken)}>
									#{channel.name}
									{taken ? ` (taken: ${taken})` : ""}
								</option>
							);
						})}
					</select>
				</label>
			)}
			<span className="label">Who may wake Pi</span>
			<label className="check">
				<input type="radio" checked={draft.who === "anyone"} onChange={() => update({ who: "anyone" })} />
				Anyone in the channel
			</label>
			<label className="check">
				<input type="radio" checked={draft.who === "roles"} onChange={() => update({ who: "roles" })} />
				Members with these roles, or these users
			</label>
			{draft.who === "roles" && (
				<div className="discord-indent stack">
					{!guild && <span className="muted small">Pick a server to see its roles.</span>}
					{guild && !server && <span className="muted small">Loading roles…</span>}
					{server?.roles.map((role) => (
						<label key={role.id} className="check">
							<input
								type="checkbox"
								checked={draft.roles.includes(role.id)}
								onChange={(event) => update({ roles: toggle(draft.roles, role.id, event.target.checked) })}
							/>
							@{role.name}
						</label>
					))}
					{server && !server.roles.length && <span className="muted small">The server has no roles.</span>}
					<label className="field">
						<span className="label">User IDs (optional)</span>
						<textarea
							className="input mono"
							rows={2}
							placeholder="One per line"
							value={draft.users}
							onChange={(event) => update({ users: event.target.value })}
							{...NO_AUTOCORRECT}
						/>
						<span className="muted small">
							Turn on Developer Mode in Discord, then right-click a member and Copy User ID.
						</span>
					</label>
				</div>
			)}
			<div className="field">
				<span className="label">Sandbox</span>
				{sandboxes.length ? (
					<select
						className="input"
						aria-label="Sandbox"
						value={sandbox}
						onChange={(event) => update({ sandbox: event.target.value })}
					>
						{!onlySandbox && <option value="">Pick a sandbox</option>}
						{sandboxes.map((env) => (
							<option key={env.name} value={env.name}>
								{env.name}
							</option>
						))}
					</select>
				) : (
					<span className="muted small">No sandbox yet: add one under Environments.</span>
				)}
			</div>
			<span className="label">What the session may use</span>
			{servers.map((name) => (
				<label key={name} className="check">
					<input
						type="checkbox"
						checked={draft.mcp.includes(name)}
						onChange={(event) => update({ mcp: toggle(draft.mcp, name, event.target.checked) })}
					/>
					MCP server <span className="mono">{name}</span>
				</label>
			))}
			<label className="check">
				<input
					type="checkbox"
					checked={draft.projectMcp}
					onChange={(event) => update({ projectMcp: event.target.checked })}
				/>
				The project's MCP servers (.pi/mcp.json)
			</label>
			<label className="check">
				<input
					type="checkbox"
					checked={draft.instructions}
					onChange={(event) => update({ instructions: event.target.checked })}
				/>
				Your global AGENTS.md, skills and prompts
			</label>
			{LOCK_CAPABILITIES.map((capability) => (
				<label key={capability} className="check">
					<input
						type="checkbox"
						checked={draft.capabilities.includes(capability)}
						onChange={(event) =>
							update({ capabilities: toggle(draft.capabilities, capability, event.target.checked) })
						}
					/>
					{CAPABILITY_LABELS[capability]}
				</label>
			))}
			{error && <output className="notice error">{error}</output>}
			<button type="submit" className="button primary" disabled={busy || missing.length > 0 || !discord}>
				{busy ? "Moving into the sandbox and linking…" : "Link"}
			</button>
			{missing.length > 0 && <p className="muted small">Still to pick: {missing.join(", ")}.</p>}
		</form>
	);
}
