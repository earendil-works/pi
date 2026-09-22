import { type Static, Type } from "typebox";

const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const CompactionModelOverrideSchema = Type.Object({
	reserveTokens: Type.Optional(Type.Number()),
	keepRecentTokens: Type.Optional(Type.Number()),
});

const CompactionSettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: true })),
	reserveTokens: Type.Optional(Type.Number({ default: 16384 })),
	keepRecentTokens: Type.Optional(Type.Number({ default: 20000 })),
	modelOverrides: Type.Optional(
		Type.Record(Type.String(), CompactionModelOverrideSchema, {
			description: 'Per-model overrides keyed by exact "provider/modelId" strings.',
		}),
	),
});

const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(
		Type.Number({ description: "Tokens reserved for the prompt and LLM response.", default: 16384 }),
	),
	skipPrompt: Type.Optional(
		Type.Boolean({
			description: 'When true, skips the "Summarize branch?" prompt and defaults to no summary.',
			default: false,
		}),
	),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number({ description: "SDK or provider request timeout in milliseconds." })),
	maxRetries: Type.Optional(Type.Number({ description: "SDK or provider retry attempts." })),
	maxRetryDelayMs: Type.Optional(
		Type.Number({ description: "Maximum server-requested delay before failing.", default: 60000 }),
	),
});

const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean({ default: true })),
	maxRetries: Type.Optional(Type.Number({ default: 3 })),
	baseDelayMs: Type.Optional(
		Type.Number({ description: "Exponential backoff base delay in milliseconds: 2s, 4s, 8s.", default: 2000 }),
	),
	maxAgentDelayMs: Type.Optional(Type.Number({ default: 60000 })),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	maxDelayMs: Type.Optional(
		Type.Number({ description: "Legacy retry delay setting. Use maxAgentDelayMs instead.", deprecated: true }),
	),
});

const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(
		Type.Boolean({ description: "Show images when the terminal supports them.", default: true }),
	),
	imageWidthCells: Type.Optional(
		Type.Number({ description: "Preferred inline image width in terminal cells.", default: 60 }),
	),
	clearOnShrink: Type.Optional(
		Type.Boolean({ description: "Clear empty rows when content shrinks.", default: false }),
	),
	showTerminalProgress: Type.Optional(
		Type.Boolean({ description: "Show OSC 9;4 terminal progress indicators.", default: false }),
	),
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});

const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(
		Type.Boolean({
			description: "Resize images to 2000x2000 maximum for better model compatibility.",
			default: true,
		}),
	),
	blockImages: Type.Optional(
		Type.Boolean({ description: "When true, prevents all images from being sent to LLM providers.", default: false }),
	),
});

const ThinkingBudgetsSettingsSchema = Type.Object({
	minimal: Type.Optional(Type.Number()),
	low: Type.Optional(Type.Number()),
	medium: Type.Optional(Type.Number()),
	high: Type.Optional(Type.Number()),
});

const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String({ default: "  " })),
	mermaid: Type.Optional(
		Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")], {
			default: "streaming",
		}),
	),
});

const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean({ default: true })),
});

const PackageSourceSchema = Type.Union(
	[
		Type.String({ description: "Load all resources from the package." }),
		Type.Object({
			source: Type.String(),
			autoload: Type.Optional(
				Type.Boolean({ description: "When false, start empty and only apply explicit resource patterns." }),
			),
			extensions: Type.Optional(Type.Array(Type.String())),
			skills: Type.Optional(Type.Array(Type.String())),
			prompts: Type.Optional(Type.Array(Type.String())),
			themes: Type.Optional(Type.Array(Type.String())),
		}),
	],
	{
		description:
			"Package source for npm or git packages. Use the string form to load all resources or the object form to filter resources.",
	},
);

const StringArraySchema = Type.Array(Type.String());
const SkillsInputSchema = Type.Union(
	[
		StringArraySchema,
		Type.Object(
			{
				enableSkillCommands: Type.Optional(Type.Boolean()),
				customDirectories: Type.Optional(StringArraySchema),
			},
			{ deprecated: true },
		),
	],
	{ description: "Local skill file paths or directories." },
);

export const SettingsSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema reference." })),
		lastChangelogVersion: Type.Optional(Type.String()),
		defaultProvider: Type.Optional(Type.String()),
		defaultModel: Type.Optional(Type.String()),
		defaultThinkingLevel: Type.Optional(ThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(
			Type.Record(Type.String(), ThinkingLevelSchema, {
				description: 'Per-model default thinking level overrides keyed by "provider/modelId".',
			}),
		),
		transport: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("websocket-cached")],
				{ default: "auto" },
			),
		),
		steeringMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
		followUpMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
		theme: Type.Optional(Type.String()),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean()),
		showCacheMissNotices: Type.Optional(
			Type.Boolean({ description: "Show cache cost and provider recovery notices.", default: false }),
		),
		externalEditor: Type.Optional(
			Type.String({ description: "Command for Ctrl+G external editor; takes precedence over VISUAL and EDITOR." }),
		),
		shellPath: Type.Optional(
			Type.String({ description: "Custom shell path, with support for leading ~ expansion." }),
		),
		quietStartup: Type.Optional(Type.Boolean()),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")], {
				description: "Global setting only.",
				default: "ask",
			}),
		),
		shellCommandPrefix: Type.Optional(
			Type.String({ description: "Prefix prepended to every bash command, for example to enable shell aliases." }),
		),
		npmCommand: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'Command used for npm package lookup and installation, in argv form such as ["mise", "exec", "node@20", "--", "npm"].',
			}),
		),
		collapseChangelog: Type.Optional(
			Type.Boolean({
				description: "Show the condensed changelog after update; use /changelog for the full changelog.",
			}),
		),
		enableInstallTelemetry: Type.Optional(
			Type.Boolean({
				description: "Send an anonymous version and update ping after changelog-detected updates.",
				default: true,
			}),
		),
		enableAnalytics: Type.Optional(
			Type.Boolean({ description: "Opt in to analytics data sharing.", default: false }),
		),
		trackingId: Type.Optional(
			Type.String({ description: "Analytics tracking identifier, generated when analytics is enabled." }),
		),
		packages: Type.Optional(
			Type.Array(PackageSourceSchema, {
				description: "npm or git package sources, as strings or objects with resource filtering.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Type.String(), { description: "Local extension file paths or directories." }),
		),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(
			Type.Array(Type.String(), { description: "Local prompt template file paths or directories." }),
		),
		themes: Type.Optional(Type.Array(Type.String(), { description: "Local theme file paths or directories." })),
		enableSkillCommands: Type.Optional(
			Type.Boolean({ description: "Register skills as /skill:name commands.", default: true }),
		),
		terminal: Type.Optional(TerminalSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(
			Type.Array(Type.String(), {
				description: "Model patterns for cycling, in the same format as the --models CLI flag.",
			}),
		),
		defaultTools: Type.Optional(Type.Array(Type.String(), { description: "Initial built-in tool selection." })),
		doubleEscapeAction: Type.Optional(
			Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")], {
				description: "Action for double-escape with an empty editor.",
				default: "tree",
			}),
		),
		treeFilterMode: Type.Optional(
			Type.Union(
				[
					Type.Literal("default"),
					Type.Literal("no-tools"),
					Type.Literal("user-only"),
					Type.Literal("labeled-only"),
					Type.Literal("all"),
				],
				{ description: "Default filter when opening /tree." },
			),
		),
		thinkingBudgets: Type.Optional(
			Type.Object(ThinkingBudgetsSettingsSchema.properties, {
				description: "Custom token budgets for thinking levels.",
			}),
		),
		editorPaddingX: Type.Optional(
			Type.Number({ description: "Horizontal padding for the input editor.", default: 0 }),
		),
		outputPad: Type.Optional(
			Type.Union([Type.Literal(0), Type.Literal(1)], {
				description: "Horizontal padding for chat message output.",
				default: 1,
			}),
		),
		autocompleteMaxVisible: Type.Optional(
			Type.Number({ description: "Maximum visible items in the autocomplete dropdown.", default: 5 }),
		),
		showHardwareCursor: Type.Optional(
			Type.Boolean({ description: "Show the terminal cursor while still positioning it for IME." }),
		),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		sessionDir: Type.Optional(
			Type.String({
				description: "Custom session storage directory, in the same format as the --session-dir CLI flag.",
			}),
		),
		httpProxy: Type.Optional(
			Type.String({ description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients." }),
		),
		httpIdleTimeoutMs: Type.Optional(
			Type.Number({ description: "HTTP header or body idle timeout in milliseconds; 0 disables it." }),
		),
		cacheWarming: Type.Optional(
			Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")], {
				description:
					'Cache-warming profile. "idle" also warms between agent runs. Global only because each refresh costs money.',
				default: "streaming",
			}),
		),
		websocketConnectTimeoutMs: Type.Optional(
			Type.Number({ description: "WebSocket connect or open handshake timeout in milliseconds; 0 disables it." }),
		),
		tuiMode: Type.Optional(Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")], { default: "regular" })),
		fullscreenExitOutput: Type.Optional(
			Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")], {
				description: "No effect in regular TUI mode.",
				default: "transcript",
			}),
		),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")], {
				description: "No effect in regular TUI mode.",
				default: "auto",
			}),
		),
		fullscreenCopyOnSelect: Type.Optional(
			Type.Boolean({ description: "No effect in regular TUI mode.", default: true }),
		),
		queueMode: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], {
				description: "Legacy setting migrated to steeringMode and followUpMode.",
				deprecated: true,
			}),
		),
		websockets: Type.Optional(
			Type.Boolean({ description: "Legacy setting migrated to transport.", deprecated: true }),
		),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

export interface CompactionModelOverride extends Static<typeof CompactionModelOverrideSchema> {}
export interface CompactionSettings extends Static<typeof CompactionSettingsSchema> {}
export interface BranchSummarySettings extends Static<typeof BranchSummarySettingsSchema> {}
export interface ProviderRetrySettings extends Static<typeof ProviderRetrySettingsSchema> {}
export interface RetrySettings extends Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs"> {}
export interface TerminalSettings extends Static<typeof TerminalSettingsSchema> {}
export interface ImageSettings extends Static<typeof ImageSettingsSchema> {}
export interface ThinkingBudgetsSettings extends Static<typeof ThinkingBudgetsSettingsSchema> {}
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export interface MarkdownSettings extends Static<typeof MarkdownSettingsSchema> {}
export interface WarningSettings extends Static<typeof WarningSettingsSchema> {}
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type PackageSource = Static<typeof PackageSourceSchema>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export interface Settings extends Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> {
	retry?: RetrySettings;
	skills?: string[];
}
