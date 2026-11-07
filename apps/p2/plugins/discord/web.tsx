// The discord plugin's web facet: the Discord sheet (sidebar foot) with the bot's token, status and invite link, the
// bound channels, and the form that binds a channel to a session (who may wake Pi, where to start, the session's lock,
// and moving the session into a sandbox first). Batches show in the transcript as the Discord author's messages.
import { BACKGROUND_CONTEXT, contribute, defineFacet, LOCK_CAPABILITIES, type LockCapability } from "@p2/app/v1";
import {
	closeLayers,
	errorText,
	openLayer,
	Sheet,
	Slots,
	useObject,
	useOwner,
	useReadable,
	useSheet,
} from "@p2/app/v1/web";
import { useEffect, useState } from "react";
import { TranscriptEntries } from "../chat/contract.ts";
import { Envs } from "../envs/contract.ts";
import { Sessions } from "../sessions/contract.ts";
import { type Binding, type Channel, DISCORD_BATCH, Discord, type Wake } from "./contract.ts";
import "./style.css";

const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

const CAPABILITY_LABELS: Record<LockCapability, string> = {
	ports: "Forward ports",
	conversations: "Message other sessions",
};

/** Discord user or role IDs, one per line or comma-separated. */
const ids = (text: string): string[] =>
	text
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter((id) => /^\d{5,30}$/.test(id));

function wakeText(wake: Wake): string {
	if (wake.anyone) return "anyone may wake Pi";
	const who = [
		wake.users.length ? `${wake.users.length} user${wake.users.length === 1 ? "" : "s"}` : "",
		wake.roles.length ? `${wake.roles.length} role${wake.roles.length === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return who.length ? `${who.join(" and ")} may wake Pi` : "nobody may wake Pi";
}

function DiscordSheet() {
	const discord = useObject(Discord, {});
	const status = useReadable(discord?.status);
	const bindings = useReadable(discord?.bindings) ?? [];
	const sessions = useReadable(useObject(Sessions, {}, { variant: "owner" })?.sessions) ?? [];
	const [token, setToken] = useState("");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = async (operation: () => Promise<unknown>) => {
		setBusy(true);
		setError(undefined);
		try {
			await operation();
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setBusy(false);
		}
	};
	const title = (id: string) => sessions.find((session) => session.id === id)?.title ?? id;
	return (
		<Sheet title="Discord" onClose={closeLayers} className="discord-sheet">
			<div className="stack">
				<span className="label">Bot</span>
				<p className="muted small">
					{status?.state === "connected"
						? `Connected as ${status.user} in ${status.guilds.length} server${status.guilds.length === 1 ? "" : "s"}.`
						: status?.state === "connecting"
							? "Connecting…"
							: status?.state === "error"
								? status.error
								: "No bot. Create an application at discord.com/developers, add a bot, turn on Message Content Intent, and paste its token."}
				</p>
				{status?.state === "connected" && (
					<a className="text-action" href={status.inviteUrl} target="_blank" rel="noreferrer">
						Invite the bot to a server
					</a>
				)}
				<form
					className="inline-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (discord)
							void run(async () => {
								await discord.setToken({ token: token.trim() }, BACKGROUND_CONTEXT);
								setToken("");
							});
					}}
				>
					<input
						className="input mono"
						type="password"
						autoComplete="off"
						aria-label="Bot token"
						placeholder={status && status.state !== "off" ? "New bot token" : "Bot token"}
						value={token}
						onChange={(event) => setToken(event.target.value)}
						{...NO_AUTOCORRECT}
					/>
					<button type="submit" className="button primary" disabled={busy || token.trim().length < 10}>
						Connect
					</button>
				</form>
				{status && status.state !== "off" && discord && (
					<button
						type="button"
						className="text-action danger"
						disabled={busy}
						onClick={() => void run(() => discord.setToken({ token: null }, BACKGROUND_CONTEXT))}
					>
						Remove the bot
					</button>
				)}
			</div>
			<div className="list">
				<span className="label">Channels</span>
				{bindings.map((binding) => (
					<BindingRow
						key={binding.channelId}
						binding={binding}
						title={title(binding.session)}
						onError={setError}
					/>
				))}
				{!bindings.length && <p className="empty-note">No channels bound.</p>}
				{status?.state === "connected" &&
					(adding ? (
						<BindForm onDone={() => setAdding(false)} />
					) : (
						<button type="button" className="text-action" onClick={() => setAdding(true)}>
							Bind a channel
						</button>
					))}
			</div>
			{error && <output className="notice error">{error}</output>}
		</Sheet>
	);
}

function BindingRow({
	binding,
	title,
	onError,
}: {
	binding: Binding;
	title: string;
	onError: (error: string) => void;
}) {
	const discord = useObject(Discord, {});
	const [busy, setBusy] = useState(false);
	const act = (operation: () => Promise<unknown>) => {
		setBusy(true);
		operation()
			.catch((reason: unknown) => onError(errorText(reason)))
			.finally(() => setBusy(false));
	};
	const threads = Object.keys(binding.threads).length;
	return (
		<div className="discord-binding">
			<div>
				<strong>
					#{binding.channelName} <span className="muted">({binding.guildName})</span>
				</strong>
				<p className="muted small">
					→ {title} · {wakeText(binding.wake)}
					{threads ? ` · ${threads} thread${threads === 1 ? "" : "s"}` : ""}
				</p>
			</div>
			{discord && (
				<div className="inline-form">
					<button
						type="button"
						className="text-action"
						disabled={busy}
						onClick={() => act(() => discord.deliverNow({ channelId: binding.channelId }, BACKGROUND_CONTEXT))}
					>
						Deliver now
					</button>
					<button
						type="button"
						className="text-action danger"
						disabled={busy}
						onClick={() => act(() => discord.unbind({ channelId: binding.channelId }, BACKGROUND_CONTEXT))}
					>
						Stop listening
					</button>
				</div>
			)}
		</div>
	);
}

type Draft = {
	channelId: string;
	session: string;
	anyone: boolean;
	users: string;
	roles: string;
	from: "now" | "last50";
	mcp: string[];
	projectMcp: boolean;
	instructions: boolean;
	capabilities: LockCapability[];
};

const EMPTY: Draft = {
	channelId: "",
	session: "",
	anyone: false,
	users: "",
	roles: "",
	from: "now",
	mcp: [],
	projectMcp: false,
	instructions: false,
	capabilities: [],
};

function BindForm({ onDone }: { onDone: () => void }) {
	const discord = useObject(Discord, {});
	const sessionsObject = useObject(Sessions, {}, { variant: "owner" });
	const sessions = (useReadable(sessionsObject?.sessions) ?? []).filter((session) => session.archivedAt === null);
	const envs = useReadable(useObject(Envs, {})?.envs) ?? [];
	const [channels, setChannels] = useState<Channel[]>();
	const [servers, setServers] = useState<string[]>([]);
	const [draft, setDraft] = useState<Draft>(EMPTY);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!discord) return;
		discord.channels(BACKGROUND_CONTEXT).then(setChannels, (reason: unknown) => setError(errorText(reason)));
		discord.mcpServers(BACKGROUND_CONTEXT).then(setServers, (reason: unknown) => setError(errorText(reason)));
	}, [discord]);
	const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
	const session = sessions.find((entry) => entry.id === draft.session);
	const sandboxes = envs.filter((env) => env.config.type === "gondolin");
	const sandboxed = !!session?.env && sandboxes.some((env) => env.name === session.env);
	const toggle = <T,>(list: readonly T[], value: T, on: boolean): T[] =>
		on ? [...list.filter((entry) => entry !== value), value] : list.filter((entry) => entry !== value);
	const run = async (operation: () => Promise<unknown>, done?: () => void) => {
		setBusy(true);
		setError(undefined);
		try {
			await operation();
			done?.();
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="stack discord-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!discord) return;
				void run(
					() =>
						discord.bind(
							{
								channelId: draft.channelId,
								session: draft.session,
								wake: { anyone: draft.anyone, users: ids(draft.users), roles: ids(draft.roles) },
								from: draft.from,
								lock: {
									mcp: draft.mcp,
									projectMcp: draft.projectMcp,
									instructions: draft.instructions,
									capabilities: draft.capabilities,
								},
							},
							BACKGROUND_CONTEXT,
						),
					onDone,
				);
			}}
		>
			<label className="field">
				<span className="label">Channel</span>
				<select
					className="input"
					value={draft.channelId}
					onChange={(event) => update({ channelId: event.target.value })}
				>
					<option value="">{channels ? "Pick a channel" : "Loading channels…"}</option>
					{channels?.map((channel) => (
						<option key={channel.id} value={channel.id}>
							#{channel.name} ({channel.guildName})
						</option>
					))}
				</select>
			</label>
			<label className="field">
				<span className="label">Session</span>
				<select
					className="input"
					value={draft.session}
					onChange={(event) => update({ session: event.target.value })}
				>
					<option value="">Pick a session</option>
					{sessions.map((entry) => (
						<option key={entry.id} value={entry.id}>
							{entry.title}
						</option>
					))}
				</select>
			</label>
			{session && !sandboxed && (
				<MoveToSandbox
					sandboxes={sandboxes.map((env) => ({
						name: env.name,
						cwd: env.config.type === "gondolin" ? (env.config.mounts?.[0]?.guest ?? "/root") : "/root",
					}))}
					busy={busy}
					onMove={(env, cwd) =>
						sessionsObject &&
						void run(() => sessionsObject.relocate({ id: session.id, cwd, env }, BACKGROUND_CONTEXT))
					}
				/>
			)}
			<span className="label">Who may wake Pi (mention @Pi)</span>
			<label className="check">
				<input
					type="checkbox"
					checked={draft.anyone}
					onChange={(event) => update({ anyone: event.target.checked })}
				/>
				Anyone in the channel
			</label>
			{!draft.anyone && (
				<>
					<label className="field">
						<span className="label">Discord user IDs</span>
						<textarea
							className="input mono"
							rows={2}
							value={draft.users}
							onChange={(event) => update({ users: event.target.value })}
							{...NO_AUTOCORRECT}
						/>
					</label>
					<label className="field">
						<span className="label">Discord role IDs</span>
						<textarea
							className="input mono"
							rows={2}
							value={draft.roles}
							onChange={(event) => update({ roles: event.target.value })}
							{...NO_AUTOCORRECT}
						/>
						<span className="muted small">
							Turn on Developer Mode in Discord, then right-click a user or role to copy its ID.
						</span>
					</label>
				</>
			)}
			<span className="label">The first delivery starts</span>
			<label className="check">
				<input type="radio" checked={draft.from === "now"} onChange={() => update({ from: "now" })} />
				After the channel's newest message
			</label>
			<label className="check">
				<input type="radio" checked={draft.from === "last50"} onChange={() => update({ from: "last50" })} />
				With the last 50 messages
			</label>
			<span className="label">What the session may use</span>
			<p className="muted small">
				Everyone allowed to wake Pi can use all of it. The session works only in its sandbox, with its secrets.
			</p>
			{servers.map((server) => (
				<label key={server} className="check">
					<input
						type="checkbox"
						checked={draft.mcp.includes(server)}
						onChange={(event) => update({ mcp: toggle(draft.mcp, server, event.target.checked) })}
					/>
					MCP server <span className="mono">{server}</span>
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
			<div className="inline-form">
				<button
					type="submit"
					className="button primary"
					disabled={busy || !draft.channelId || !draft.session || !sandboxed}
				>
					{busy ? "Binding…" : "Bind"}
				</button>
				<button type="button" className="text-action" onClick={onDone}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function MoveToSandbox({
	sandboxes,
	busy,
	onMove,
}: {
	sandboxes: readonly { name: string; cwd: string }[];
	busy: boolean;
	onMove: (env: string, cwd: string) => void;
}) {
	const [env, setEnv] = useState(sandboxes[0]?.name ?? "");
	const [cwd, setCwd] = useState(sandboxes[0]?.cwd ?? "");
	if (!sandboxes.length)
		return (
			<p className="notice">
				This session does not work in a sandbox, and there is none. Add one under Environments.
			</p>
		);
	return (
		<div className="stack">
			<p className="muted small">
				A Discord channel can only wake a session that works in a sandbox. Move it into one:
			</p>
			<div className="inline-form">
				<select
					className="input"
					aria-label="Sandbox"
					value={env}
					onChange={(event) => {
						setEnv(event.target.value);
						setCwd(sandboxes.find((entry) => entry.name === event.target.value)?.cwd ?? "");
					}}
				>
					{sandboxes.map((entry) => (
						<option key={entry.name} value={entry.name}>
							{entry.name}
						</option>
					))}
				</select>
				<input
					className="input mono"
					aria-label="Folder in the sandbox"
					value={cwd}
					onChange={(event) => setCwd(event.target.value)}
					{...NO_AUTOCORRECT}
				/>
				<button type="button" className="button" disabled={busy || !env || !cwd} onClick={() => onMove(env, cwd)}>
					Move
				</button>
			</div>
		</div>
	);
}

function DiscordButton() {
	const sheet = useSheet("discord");
	if (!useOwner()) return null;
	return (
		<>
			<button
				type="button"
				className="foot-button"
				onClick={() => openLayer({ kind: "sheet", name: "discord" }, { fromDrawer: true })}
			>
				Discord
			</button>
			{sheet && <DiscordSheet />}
		</>
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
		self.contribute(Slots, { "sidebar-foot:discord": DiscordButton });
		self.contribute(TranscriptEntries, { [DISCORD_BATCH]: batchDisplay });
	});
});
