const defineLazyExports = (modulePath, names) => {
	let loaded;
	const load = () => {
		if (!loaded) {
			loaded = require(modulePath);
		}
		return loaded;
	};

	for (const name of names) {
		Object.defineProperty(exports, name, {
			enumerable: true,
			get() {
				return load()[name];
			},
		});
	}
};

defineLazyExports("./config.js", ["getAgentDir", "VERSION"]);
defineLazyExports("./core/agent-session.js", ["AgentSession", "parseSkillBlock"]);
defineLazyExports("./core/auth-storage.js", ["AuthStorage", "FileAuthStorageBackend", "InMemoryAuthStorageBackend"]);
defineLazyExports("./core/compaction/index.js", [
	"calculateContextTokens",
	"collectEntriesForBranchSummary",
	"compact",
	"DEFAULT_COMPACTION_SETTINGS",
	"estimateTokens",
	"findCutPoint",
	"findTurnStartIndex",
	"generateBranchSummary",
	"generateSummary",
	"getLastAssistantUsage",
	"prepareBranchEntries",
	"serializeConversation",
	"shouldCompact",
]);
defineLazyExports("./core/event-bus.js", ["createEventBus"]);
defineLazyExports("./core/extensions/index.js", [
	"createExtensionRuntime",
	"discoverAndLoadExtensions",
	"ExtensionRunner",
	"isBashToolResult",
	"isEditToolResult",
	"isFindToolResult",
	"isGrepToolResult",
	"isLsToolResult",
	"isReadToolResult",
	"isToolCallEventType",
	"isWriteToolResult",
	"wrapRegisteredTool",
	"wrapRegisteredTools",
]);
defineLazyExports("./core/messages.js", ["convertToLlm"]);
defineLazyExports("./core/model-registry.js", ["clearApiKeyCache", "ModelRegistry"]);
defineLazyExports("./core/package-manager.js", ["DefaultPackageManager"]);
defineLazyExports("./core/resource-loader.js", ["DefaultResourceLoader"]);
defineLazyExports("./core/sdk.js", [
	"createAgentSession",
	"createBashTool",
	"createCodingTools",
	"createEditTool",
	"createFindTool",
	"createGrepTool",
	"createLsTool",
	"createReadOnlyTools",
	"createReadTool",
	"createWriteTool",
	"readOnlyTools",
]);
defineLazyExports("./core/session-manager.js", [
	"buildSessionContext",
	"CURRENT_SESSION_VERSION",
	"getLatestCompactionEntry",
	"migrateSessionEntries",
	"parseSessionEntries",
	"SessionManager",
]);
defineLazyExports("./core/settings-manager.js", ["SettingsManager"]);
defineLazyExports("./core/skills.js", ["formatSkillsForPrompt", "loadSkills", "loadSkillsFromDir"]);
defineLazyExports("./core/tools/index.js", [
	"bashTool",
	"codingTools",
	"createLocalBashOperations",
	"DEFAULT_MAX_BYTES",
	"DEFAULT_MAX_LINES",
	"editTool",
	"findTool",
	"formatSize",
	"grepTool",
	"lsTool",
	"readTool",
	"truncateHead",
	"truncateLine",
	"truncateTail",
	"withFileMutationQueue",
	"writeTool",
]);
defineLazyExports("./main.js", ["main"]);
defineLazyExports("./modes/index.js", ["InteractiveMode", "runPrintMode", "runRpcMode"]);
defineLazyExports("./modes/interactive/components/index.js", [
	"ArminComponent",
	"AssistantMessageComponent",
	"BashExecutionComponent",
	"BorderedLoader",
	"BranchSummaryMessageComponent",
	"CompactionSummaryMessageComponent",
	"CustomEditor",
	"CustomMessageComponent",
	"DynamicBorder",
	"ExtensionEditorComponent",
	"ExtensionInputComponent",
	"ExtensionSelectorComponent",
	"FooterComponent",
	"keyHint",
	"keyText",
	"LoginDialogComponent",
	"ModelSelectorComponent",
	"OAuthSelectorComponent",
	"rawKeyHint",
	"renderDiff",
	"SessionSelectorComponent",
	"SettingsSelectorComponent",
	"ShowImagesSelectorComponent",
	"SkillInvocationMessageComponent",
	"ThemeSelectorComponent",
	"ThinkingSelectorComponent",
	"ToolExecutionComponent",
	"TreeSelectorComponent",
	"truncateToVisualLines",
	"UserMessageComponent",
	"UserMessageSelectorComponent",
]);
defineLazyExports("./modes/interactive/theme/theme.js", ["getSelectListTheme", "getSettingsListTheme", "initTheme", "Theme"]);
defineLazyExports("./modes/interactive/theme/theme-highlighting.js", ["getLanguageFromPath", "getMarkdownTheme", "highlightCode"]);
defineLazyExports("./utils/clipboard.js", ["copyToClipboard"]);
defineLazyExports("./utils/frontmatter.js", ["parseFrontmatter", "stripFrontmatter"]);
defineLazyExports("./utils/shell.js", ["getShellConfig"]);
