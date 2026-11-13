// The owner's Settings window, opened from the gear beside the sidebar's theme switch: a list of sections beside a
// pane (on phones the list, then a section). Its own sections edit settings.json (General also the server's name, which
// the server keeps beside it: src/runtime/server-name-file.ts); the plugins' sections (Providers,
// Envs, ...) are their sheets, shown as pages of the window (`SettingsSections`, src/web/SettingsNav.tsx). Each
// change of settings.json is saved at once (text and number fields when they lose focus or on Enter) and shown before
// the save returns. The command menu opens it at a section (commands.tsx).
import {
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	type Held,
	MAX_SERVER_NAME_LENGTH,
	ServerNameSettings,
} from "@p2/app/v1";
import {
	CommandPages,
	CommandSearches,
	Commands,
	closeLayers,
	ModalSheet,
	openSettings,
	SettingsIcon,
	SettingsNavItem,
	SettingsPane,
	Sheet,
	Slots,
	Switch,
	showSettingsSection,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useSettingsSection,
	useSettingsSections,
	useWide,
} from "@p2/app/v1/web";
import { createContext, type ReactNode, useCallback, useContext, useId, useMemo, useState } from "react";
import { Models } from "../models/contract.ts";
import { SETTINGS_COMMANDS, SETTINGS_PAGES, SETTINGS_SEARCH } from "./commands.tsx";
import { type MobileSettings, Settings } from "./contract.ts";
import { OWN_SECTIONS, type OwnSection } from "./sections.ts";
import "./settings.css";

/** A change of top-level settings: each one's new value, `undefined` back to its default (removed from the file). */
type Change = Partial<MobileSettings>;
type Stream = NonNullable<MobileSettings["stream"]>;
type Retry = NonNullable<MobileSettings["retry"]>;
type Compaction = NonNullable<MobileSettings["compaction"]>;

const DETAILS = [1, 2, 3, 4] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const QUEUE_MODES = [
	{ value: "one-at-a-time", label: "One at a time" },
	{ value: "all", label: "All at once" },
] as const;
const NO_AUTOCORRECT = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

/**
 * One setting group (`stream`, `retry`, `compaction`: every field optional) with the fields in `change` replaced;
 * `undefined` when no field is left (the group is removed).
 */
function patched<T extends object>(group: T | undefined, change: T): T | undefined {
	const next = { ...group, ...change };
	return Object.values(next).some((value) => value !== undefined) ? next : undefined;
}

/** A number setting as its field shows it, and the field's text as the setting (empty: the default). */
const numberText = (value: number | undefined) => (value === undefined ? "" : String(value));
const textNumber = (text: string) => (text === "" ? undefined : Number(text));

/**
 * The objects the window's own sections show, held by the gear (mounted from the page's start, for owners) so General
 * and the others open without a round trip: settings.json's values and the server's name, a few hundred bytes.
 */
const HeldSettings = createContext<{
	readonly settings: Held<typeof Settings> | undefined;
	readonly serverName: Held<typeof ServerNameSettings> | undefined;
}>({ settings: undefined, serverName: undefined });

function GearButton() {
	const owner = useOwner();
	const open = useSettingsSection() !== undefined;
	const settings = useObject(Settings, owner ? {} : undefined);
	const serverName = useObject(ServerNameSettings, owner ? {} : undefined);
	const held = useMemo(() => ({ settings, serverName }), [settings, serverName]);
	if (!owner) return null;
	return (
		<HeldSettings.Provider value={held}>
			<button
				type="button"
				className="icon-button settings-open"
				onClick={() => openSettings()}
				aria-label="Settings"
				title="Settings"
			>
				<SettingsIcon />
			</button>
			{open && <SettingsWindow />}
		</HeldSettings.Provider>
	);
}

/**
 * The window: the list of sections and the pane. Wide screens show both (General when no section is chosen); phones
 * show the list until a section is chosen, then the section with a Back to the list.
 */
function SettingsWindow() {
	const section = useSettingsSection();
	const sections = useSettingsSections();
	const wide = useWide();
	const own: OwnSection | undefined =
		section?.kind === "own"
			? (OWN_SECTIONS.find((entry) => entry.id === section.locator)?.id ?? (wide ? "general" : undefined))
			: undefined;
	const list = section?.kind === "own" && own === undefined;
	return (
		<ModalSheet title="Settings" onClose={closeLayers} className={`settings-window ${list ? "shows-list" : ""}`}>
			<nav className="settings-nav" aria-label="Settings sections">
				{OWN_SECTIONS.map((entry) => (
					<button
						key={entry.id}
						type="button"
						className="settings-nav-item"
						aria-current={own === entry.id ? "page" : undefined}
						onClick={() => showSettingsSection({ locator: entry.id }, wide)}
					>
						{entry.label}
					</button>
				))}
				<hr className="settings-nav-break" />
				{sections.map(([name, { label, title, Shown }]) => {
					const item = <SettingsNavItem key={name} name={name} label={label} title={title} />;
					return Shown ? <Shown key={name}>{item}</Shown> : item;
				})}
			</nav>
			<SettingsPane />
			{own && <SettingsSection id={own} />}
		</ModalSheet>
	);
}

/** One of the window's own sections: its settings.json fields, as a page of the window. */
function SettingsSection({ id }: { id: OwnSection }) {
	const service = useContext(HeldSettings).settings;
	const models = useReadable(useObject(Models, {})?.models);
	const loaded = useReadable(service?.settings);
	const fileError = useReadable(service?.error);
	const [error, setError] = useState<string>();
	const onError = useCallback(
		(reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not save the settings"),
		[],
	);
	const [settings, guess] = useOptimisticCall<MobileSettings | undefined, Change>(
		loaded,
		(value, change) => value && { ...value, ...change },
		onError,
	);
	const save = (change: Change) => {
		if (!service) return;
		setError(undefined);
		const entries = Object.entries(change);
		const set = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
		const unset = entries.filter(([, value]) => value === undefined).map(([key]) => key);
		guess(change, () => service.update({ set, unset }, BACKGROUND_CONTEXT));
	};
	const title = OWN_SECTIONS.find((entry) => entry.id === id)?.label ?? "Settings";
	if (!settings)
		return (
			<Sheet title={title} onClose={closeLayers}>
				<output className="muted">Loading settings…</output>
			</Sheet>
		);
	const stream = (change: Stream) => save({ stream: patched(settings.stream, change) });
	const retry = (change: Retry) => save({ retry: patched(settings.retry, change) });
	const compaction = (change: Compaction) => save({ compaction: patched(settings.compaction, change) });
	const defaultModel = settings.defaultModel && `${settings.defaultModel.provider}/${settings.defaultModel.modelId}`;
	const modelOptions = (models ?? []).map((model) => ({
		value: `${model.provider}/${model.modelId}`,
		label: `${model.name} (${model.provider})`,
	}));
	// A default that is not among the signed-in models still shows as chosen.
	if (defaultModel && !modelOptions.some((option) => option.value === defaultModel))
		modelOptions.unshift({ value: defaultModel, label: defaultModel });
	const fields: Record<OwnSection, ReactNode> = {
		general: (
			<>
				<p className="muted small">
					This server's settings.json, used by every conversation. Changes apply at once; a request already running
					keeps the settings it started with.
				</p>

				<ServerNameSetting onError={onError} />
				<TextSetting
					label="Your name on your messages"
					value={settings.ownerName ?? ""}
					placeholder="Owner"
					maxLength={40}
					onSave={(text) => save({ ownerName: text.trim() ? text : undefined })}
				/>
				<Choice
					label="Chat detail"
					value={settings.detail === undefined ? undefined : String(settings.detail)}
					fallback="texts, thinking and calls on wheels (2)"
					options={[
						{ value: "1", label: "1: only the answer, the rest on one wheel" },
						{ value: "2", label: "2: texts, thinking and calls on wheels" },
						{ value: "3", label: "3: thinking too (collapsed), calls on wheels" },
						{ value: "4", label: "4: everything, each call as a row" },
					]}
					onChange={(value) => save({ detail: DETAILS.find((detail) => String(detail) === value) })}
				/>
			</>
		),
		models: (
			<>
				<p className="muted small">What a new session starts with; each session then keeps its own model.</p>

				<Choice
					label="Default model"
					value={defaultModel}
					fallback="The first signed-in model"
					options={modelOptions}
					onChange={(value) => {
						const slash = value?.indexOf("/") ?? -1;
						save({
							defaultModel:
								value === undefined || slash < 0
									? undefined
									: { provider: value.slice(0, slash), modelId: value.slice(slash + 1) },
						});
					}}
				/>
				<Choice
					label="Thinking level"
					value={settings.thinkingLevel}
					fallback="high"
					options={THINKING_LEVELS.map((level) => ({ value: level, label: level }))}
					onChange={(value) => save({ thinkingLevel: THINKING_LEVELS.find((level) => level === value) })}
				/>
				<TextSetting
					label="Models for cycling in the TUI (one pattern per line)"
					value={(settings.enabledModels ?? []).join("\n")}
					placeholder="All models"
					rows={3}
					mono
					onSave={(text) => {
						const patterns = text
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean);
						save({ enabledModels: patterns.length ? patterns : undefined });
					}}
				/>
			</>
		),
		agent: (
			<>
				<Switch
					label="Code mode (scripts that call the other tools)"
					checked={settings.codemode ?? true}
					onChange={(checked) => save({ codemode: checked ? undefined : false })}
				/>
				<Choice
					label="Tool calls"
					value={settings.toolExecution}
					fallback="In parallel"
					options={[
						{ value: "parallel", label: "In parallel" },
						{ value: "sequential", label: "One after another" },
					]}
					onChange={(value) =>
						save({ toolExecution: value === "parallel" || value === "sequential" ? value : undefined })
					}
				/>
				<Choice
					label="Messages sent while it works (steering)"
					value={settings.steeringMode}
					fallback="One at a time"
					options={QUEUE_MODES}
					onChange={(value) => save({ steeringMode: QUEUE_MODES.find((mode) => mode.value === value)?.value })}
				/>
				<Choice
					label="Follow-up messages"
					value={settings.followUpMode}
					fallback="One at a time"
					options={QUEUE_MODES}
					onChange={(value) => save({ followUpMode: QUEUE_MODES.find((mode) => mode.value === value)?.value })}
				/>
				<Choice
					label="Cache warming"
					value={settings.cacheWarming}
					fallback="While streaming and 30 minutes after"
					options={[
						{ value: "idle", label: "While streaming and 30 minutes after" },
						{ value: "streaming", label: "Only while streaming" },
						{ value: "off", label: "Off" },
					]}
					onChange={(value) =>
						save({
							cacheWarming: value === "idle" || value === "streaming" || value === "off" ? value : undefined,
						})
					}
				/>
			</>
		),
		requests: (
			<>
				<Choice
					label="Transport"
					value={settings.stream?.transport}
					fallback="Automatic"
					options={[
						{ value: "auto", label: "Automatic" },
						{ value: "sse", label: "SSE" },
						{ value: "websocket", label: "WebSocket" },
					]}
					onChange={(value) =>
						stream({
							transport: value === "auto" || value === "sse" || value === "websocket" ? value : undefined,
						})
					}
				/>
				<Choice
					label="Prompt cache retention"
					value={settings.stream?.cacheRetention}
					fallback="Provider default (short)"
					options={[
						{ value: "short", label: "Short (5 minutes)" },
						{ value: "long", label: "Long (1 hour, twice the input price)" },
						{ value: "none", label: "None" },
					]}
					onChange={(value) =>
						stream({
							cacheRetention: value === "none" || value === "short" || value === "long" ? value : undefined,
						})
					}
				/>
				<NumberSetting
					label="Request timeout (ms)"
					value={settings.stream?.timeoutMs}
					placeholder="Provider default"
					min={1}
					onSave={(timeoutMs) => stream({ timeoutMs })}
				/>
				<NumberSetting
					label="Provider retries"
					value={settings.stream?.maxRetries}
					placeholder="Provider default"
					onSave={(maxRetries) => stream({ maxRetries })}
				/>
				<NumberSetting
					label="Longest provider retry delay (ms)"
					value={settings.stream?.maxRetryDelayMs}
					placeholder="60000"
					onSave={(maxRetryDelayMs) => stream({ maxRetryDelayMs })}
				/>

				<Group title="Retries after a failed turn">
					<Switch
						label="Retry failed turns"
						checked={settings.retry?.enabled ?? true}
						onChange={(checked) => retry({ enabled: checked ? undefined : false })}
					/>
					<NumberSetting
						label="Retries"
						value={settings.retry?.maxRetries}
						placeholder="3"
						onSave={(maxRetries) => retry({ maxRetries })}
					/>
					<NumberSetting
						label="First delay (ms)"
						value={settings.retry?.baseDelayMs}
						placeholder="2000"
						onSave={(baseDelayMs) => retry({ baseDelayMs })}
					/>
					<NumberSetting
						label="Longest delay (ms)"
						value={settings.retry?.maxAgentDelayMs}
						placeholder="60000"
						onSave={(maxAgentDelayMs) => retry({ maxAgentDelayMs })}
					/>
				</Group>
			</>
		),
		compaction: (
			<>
				<Switch
					label="Compact long conversations"
					checked={settings.compaction?.enabled ?? true}
					onChange={(checked) => compaction({ enabled: checked ? undefined : false })}
				/>
				<NumberSetting
					label="Tokens kept free for the answer"
					value={settings.compaction?.reserveTokens}
					placeholder="16384"
					min={1}
					onSave={(reserveTokens) => compaction({ reserveTokens })}
				/>
				<NumberSetting
					label="Recent tokens kept as they are"
					value={settings.compaction?.keepRecentTokens}
					placeholder="20000"
					min={1}
					onSave={(keepRecentTokens) => compaction({ keepRecentTokens })}
				/>
				<NumberSetting
					label="Tokens before compacting in the background"
					value={settings.compaction?.backgroundTokens}
					placeholder="32768"
					onSave={(backgroundTokens) => compaction({ backgroundTokens })}
				/>
			</>
		),
	};
	return (
		<Sheet title={title} onClose={closeLayers}>
			<div className="stack settings-fields">
				{fileError && (
					<p className="error" role="alert">
						settings.json could not be loaded: this shows the last valid settings, and a change here replaces the
						file with them.
					</p>
				)}
				{error && (
					<p className="error" role="alert">
						{error}
					</p>
				)}
				{fields[id]}
			</div>
		</Sheet>
	);
}

/**
 * The server's name, as Radius and the other places that show this server name it. Empty is the device's name (the
 * placeholder, as of the server's start).
 */
function ServerNameSetting({ onError }: { onError: (reason: unknown) => void }) {
	const service = useContext(HeldSettings).serverName;
	const loaded = useReadable(service?.chosen);
	const device = useReadable(service?.device);
	const [chosen, guess] = useOptimisticCall<string | null | undefined, string | null>(
		loaded,
		(_value, next) => next,
		onError,
	);
	if (!service || chosen === undefined) return null;
	return (
		<TextSetting
			label="Server name"
			value={chosen ?? ""}
			placeholder={device ?? "This device's name"}
			maxLength={MAX_SERVER_NAME_LENGTH}
			onSave={(text) => {
				const name = text.trim() ? text.trim() : null;
				guess(name, () => service.rename({ name }, BACKGROUND_CONTEXT));
			}}
		/>
	);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="settings-group">
			<h3>{title}</h3>
			{children}
		</section>
	);
}

/** A select over `options`; its first option, `fallback`, is the default (the setting removed). */
function Choice({
	label,
	value,
	fallback,
	options,
	onChange,
}: {
	label: string;
	value: string | undefined;
	fallback: string;
	options: readonly { value: string; label: string }[];
	onChange: (value: string | undefined) => void;
}) {
	return (
		<label className="field">
			<span className="label">{label}</span>
			<select
				className="input"
				value={value ?? ""}
				onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
			>
				<option value="">Default: {fallback}</option>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}

/** A text field holding its own text while edited, saved when it loses focus or on Enter (not in a textarea). */
function TextSetting({
	label,
	value,
	placeholder,
	maxLength,
	rows,
	mono = false,
	numeric = false,
	onSave,
}: {
	label: string;
	value: string;
	placeholder: string;
	maxLength?: number;
	rows?: number;
	mono?: boolean;
	numeric?: boolean;
	onSave: (text: string) => void;
}) {
	// undefined: not being edited, the field shows the setting.
	const [text, setText] = useState<string>();
	const commit = () => {
		if (text !== undefined && text !== value) onSave(text);
		setText(undefined);
	};
	const className = `input ${mono ? "mono" : ""}`;
	const id = useId();
	return (
		<div className="field">
			<label className="label" htmlFor={id}>
				{label}
			</label>
			{rows ? (
				<textarea
					id={id}
					className={className}
					value={text ?? value}
					placeholder={placeholder}
					rows={rows}
					onChange={(event) => setText(event.target.value)}
					onBlur={commit}
					{...NO_AUTOCORRECT}
				/>
			) : (
				<input
					id={id}
					className={className}
					value={text ?? value}
					placeholder={placeholder}
					maxLength={maxLength}
					inputMode={numeric ? "numeric" : undefined}
					onChange={(event) => setText(numeric ? event.target.value.replace(/\D/g, "") : event.target.value)}
					onBlur={commit}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
					}}
					{...NO_AUTOCORRECT}
				/>
			)}
		</div>
	);
}

/** A whole-number setting; an empty field is the default, a number below `min` is not saved. */
function NumberSetting({
	label,
	value,
	placeholder,
	min = 0,
	onSave,
}: {
	label: string;
	value: number | undefined;
	placeholder: string;
	min?: number;
	onSave: (value: number | undefined) => void;
}) {
	return (
		<TextSetting
			label={label}
			value={numberText(value)}
			placeholder={placeholder}
			maxLength={12}
			numeric
			onSave={(text) => {
				const number = textNumber(text);
				if (number === undefined || number >= min) onSave(number);
			}}
		/>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-settings", (self) => {
		self.contribute(Slots, { "sidebar-actions:settings": GearButton });
		self.contribute(Commands, SETTINGS_COMMANDS);
		self.contribute(CommandPages, SETTINGS_PAGES);
		self.contribute(CommandSearches, { settings: SETTINGS_SEARCH });
	});
});
