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
	enabled: Type.Optional(Type.Boolean()),
	reserveTokens: Type.Optional(Type.Number()),
	keepRecentTokens: Type.Optional(Type.Number()),
	modelOverrides: Type.Optional(Type.Record(Type.String(), CompactionModelOverrideSchema)),
});

const BranchSummarySettingsSchema = Type.Object({
	reserveTokens: Type.Optional(Type.Number()),
	skipPrompt: Type.Optional(Type.Boolean()),
});

const ProviderRetrySettingsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Number()),
	maxRetries: Type.Optional(Type.Number()),
	maxRetryDelayMs: Type.Optional(Type.Number()),
});

const RetrySettingsSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	maxRetries: Type.Optional(Type.Number()),
	baseDelayMs: Type.Optional(Type.Number()),
	maxAgentDelayMs: Type.Optional(Type.Number()),
	provider: Type.Optional(ProviderRetrySettingsSchema),
	maxDelayMs: Type.Optional(Type.Number({ deprecated: true })),
});

const TerminalSettingsSchema = Type.Object({
	showImages: Type.Optional(Type.Boolean()),
	imageWidthCells: Type.Optional(Type.Number()),
	clearOnShrink: Type.Optional(Type.Boolean()),
	showTerminalProgress: Type.Optional(Type.Boolean()),
	hyperlinks: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
	images: Type.Optional(
		Type.Union([Type.Literal("kitty"), Type.Literal("iterm2"), Type.Literal("auto"), Type.Literal(false)]),
	),
	trueColor: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});

const ImageSettingsSchema = Type.Object({
	autoResize: Type.Optional(Type.Boolean()),
	blockImages: Type.Optional(Type.Boolean()),
});

const ThinkingBudgetsSettingsSchema = Type.Object({
	minimal: Type.Optional(Type.Number()),
	low: Type.Optional(Type.Number()),
	medium: Type.Optional(Type.Number()),
	high: Type.Optional(Type.Number()),
});

const MarkdownSettingsSchema = Type.Object({
	codeBlockIndent: Type.Optional(Type.String()),
	mermaid: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("final"), Type.Literal("streaming")])),
});

const WarningSettingsSchema = Type.Object({
	anthropicExtraUsage: Type.Optional(Type.Boolean()),
});

const CodemodeModeSchema = Type.Union([Type.Literal("on"), Type.Literal("only")]);

const CodemodeSettingsSchema = Type.Object({
	mode: Type.Optional(CodemodeModeSchema),
	inlineBudget: Type.Optional(Type.Number()),
});

const PackageSourceSchema = Type.Union([
	Type.String(),
	Type.Object({
		source: Type.String(),
		autoload: Type.Optional(Type.Boolean()),
		extensions: Type.Optional(Type.Array(Type.String())),
		skills: Type.Optional(Type.Array(Type.String())),
		prompts: Type.Optional(Type.Array(Type.String())),
		themes: Type.Optional(Type.Array(Type.String())),
	}),
]);

const StringArraySchema = Type.Array(Type.String());
const SkillsInputSchema = Type.Union([
	StringArraySchema,
	Type.Object(
		{
			enableSkillCommands: Type.Optional(Type.Boolean()),
			customDirectories: Type.Optional(StringArraySchema),
		},
		{ deprecated: true },
	),
]);

export const SettingsSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		lastChangelogVersion: Type.Optional(Type.String()),
		defaultProvider: Type.Optional(Type.String()),
		defaultModel: Type.Optional(Type.String()),
		defaultThinkingLevel: Type.Optional(ThinkingLevelSchema),
		modelThinkingLevels: Type.Optional(Type.Record(Type.String(), ThinkingLevelSchema)),
		transport: Type.Optional(
			Type.Union([
				Type.Literal("auto"),
				Type.Literal("sse"),
				Type.Literal("websocket"),
				Type.Literal("websocket-cached"),
			]),
		),
		steeringMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
		followUpMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
		theme: Type.Optional(Type.String()),
		compaction: Type.Optional(CompactionSettingsSchema),
		branchSummary: Type.Optional(BranchSummarySettingsSchema),
		retry: Type.Optional(RetrySettingsSchema),
		hideThinkingBlock: Type.Optional(Type.Boolean()),
		showCacheMissNotices: Type.Optional(Type.Boolean()),
		externalEditor: Type.Optional(Type.String()),
		shellPath: Type.Optional(Type.String()),
		quietStartup: Type.Optional(Type.Boolean()),
		defaultProjectTrust: Type.Optional(
			Type.Union([Type.Literal("ask"), Type.Literal("always"), Type.Literal("never")]),
		),
		shellCommandPrefix: Type.Optional(Type.String()),
		npmCommand: Type.Optional(StringArraySchema),
		collapseChangelog: Type.Optional(Type.Boolean()),
		enableInstallTelemetry: Type.Optional(Type.Boolean()),
		enableAnalytics: Type.Optional(Type.Boolean()),
		trackingId: Type.Optional(Type.String()),
		deviceId: Type.Optional(Type.String()),
		packages: Type.Optional(Type.Array(PackageSourceSchema)),
		extensions: Type.Optional(StringArraySchema),
		skills: Type.Optional(SkillsInputSchema),
		prompts: Type.Optional(StringArraySchema),
		themes: Type.Optional(StringArraySchema),
		enableSkillCommands: Type.Optional(Type.Boolean()),
		terminal: Type.Optional(TerminalSettingsSchema),
		images: Type.Optional(ImageSettingsSchema),
		enabledModels: Type.Optional(StringArraySchema),
		defaultTools: Type.Optional(StringArraySchema),
		doubleEscapeAction: Type.Optional(Type.Union([Type.Literal("fork"), Type.Literal("tree"), Type.Literal("none")])),
		treeFilterMode: Type.Optional(
			Type.Union([
				Type.Literal("default"),
				Type.Literal("no-tools"),
				Type.Literal("user-only"),
				Type.Literal("labeled-only"),
				Type.Literal("all"),
			]),
		),
		thinkingBudgets: Type.Optional(ThinkingBudgetsSettingsSchema),
		editorPaddingX: Type.Optional(Type.Number()),
		outputPad: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1)])),
		autocompleteMaxVisible: Type.Optional(Type.Number()),
		showHardwareCursor: Type.Optional(Type.Boolean()),
		markdown: Type.Optional(MarkdownSettingsSchema),
		warnings: Type.Optional(WarningSettingsSchema),
		codemode: Type.Optional(CodemodeSettingsSchema),
		sessionDir: Type.Optional(Type.String()),
		httpProxy: Type.Optional(Type.String()),
		httpIdleTimeoutMs: Type.Optional(Type.Number()),
		cacheWarming: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("streaming"), Type.Literal("idle")])),
		websocketConnectTimeoutMs: Type.Optional(Type.Number()),
		tuiMode: Type.Optional(Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")])),
		fullscreenExitOutput: Type.Optional(Type.Union([Type.Literal("transcript"), Type.Literal("resume-hint")])),
		fullscreenScrollbar: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("always"), Type.Literal("hidden")]),
		),
		fullscreenCopyOnSelect: Type.Optional(Type.Boolean()),
		fullscreenWheelScrollLines: Type.Optional(Type.Union([Type.Number(), Type.Literal("auto")])),
		queueMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")], { deprecated: true })),
		websockets: Type.Optional(Type.Boolean({ deprecated: true })),
	},
	{ additionalProperties: true },
);

type SettingsInput = Static<typeof SettingsSchema>;

export type CompactionModelOverride = Static<typeof CompactionModelOverrideSchema>;
export type CompactionSettings = Static<typeof CompactionSettingsSchema>;
export type BranchSummarySettings = Static<typeof BranchSummarySettingsSchema>;
export type ProviderRetrySettings = Static<typeof ProviderRetrySettingsSchema>;
export type RetrySettings = Omit<Static<typeof RetrySettingsSchema>, "maxDelayMs">;
export type TerminalSettings = Static<typeof TerminalSettingsSchema>;
export type ImageSettings = Static<typeof ImageSettingsSchema>;
export type ThinkingBudgetsSettings = Static<typeof ThinkingBudgetsSettingsSchema>;
export type MermaidRenderingMode = NonNullable<Static<typeof MarkdownSettingsSchema>["mermaid"]>;
export type MarkdownSettings = Static<typeof MarkdownSettingsSchema>;
export type WarningSettings = Static<typeof WarningSettingsSchema>;
export type CodemodeMode = Static<typeof CodemodeModeSchema>;
export type CodemodeSettings = Static<typeof CodemodeSettingsSchema>;
export type DefaultProjectTrust = NonNullable<SettingsInput["defaultProjectTrust"]>;
export type TransportSetting = NonNullable<SettingsInput["transport"]>;
export type PackageSource = Static<typeof PackageSourceSchema>;
export type FullscreenExitOutput = NonNullable<SettingsInput["fullscreenExitOutput"]>;
export type TuiMode = NonNullable<SettingsInput["tuiMode"]>;
export type CacheWarmingMode = NonNullable<SettingsInput["cacheWarming"]>;
export type Settings = Omit<SettingsInput, "queueMode" | "retry" | "skills" | "websockets"> & {
	retry?: RetrySettings;
	skills?: string[];
};
