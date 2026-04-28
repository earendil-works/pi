import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import {
	type AgentEvent,
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	fetchAgentConfigByName,
	fetchAgentsList,
	generateUUID,
	IndexedDBStorageBackend,
	i18n,
	// PersistentStorageDialog, // TODO: Fix - currently broken
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	RemoteStorageBackend,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
	syncAgentConfig,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Bell, History, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, Plus, Settings } from "lucide";
import "./app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { createSystemNotification, customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";
import { remoteBashTool, remoteEditTool, remoteReadTool, remoteWriteTool } from "./tools.js";

// Register custom message renderers
registerCustomMessageRenderers();

// Create stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// Gather configs
const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 2, // Incremented for custom-providers store
	stores: configs,
});

// Wire backend to stores
settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);

// Use remote backend for sessions
const remoteBackend = new RemoteStorageBackend();
sessions.setBackend(remoteBackend);

// Create and set app storage
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let availableAgents: string[] = [];
let selectedAgentName: string | undefined;
let noticeText = "";
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

const showNotice = (text: string) => {
	noticeText = text;
	renderApp();
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		noticeText = "";
		renderApp();
	}, 3000);
};
let currentTheme: "default" | "cyberpunk" = (localStorage.getItem("pi-theme") as any) || "default";

const toggleTheme = () => {
	currentTheme = currentTheme === "default" ? "cyberpunk" : "default";
	localStorage.setItem("pi-theme", currentTheme);
	renderApp();
};

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c: any) => c.type === "text");
		text = textBlocks.map((c: any) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: any) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((m: any) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Create session data
		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};

		// Create session metadata
		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel || "off",
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

let systemEnv = { cwd: "/root/pi-mono", homedir: "/root", os: "linux", user: "root" };

const getSystemPrompt = () => `You are a helpful AI assistant with access to various tools.

Environment Information:
- OS: ${systemEnv.os}
- User: ${systemEnv.user}
- Home Directory: ${systemEnv.homedir}
- Current Working Directory: ${systemEnv.cwd}

Available tools:
- JavaScript REPL: Execute JavaScript code in a sandboxed browser environment
- Artifacts: Create interactive HTML, SVG, Markdown, and text artifacts
- bash: Execute shell commands locally
- read/write/edit: Manage files on the local filesystem

Feel free to use these tools when needed to provide accurate and helpful responses. Always respect the user's instructions and the environment context.`;

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: getSystemPrompt(),
			model: getModel("google-antigravity", "gemini-3-flash"),
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		// Custom transformer: convert custom messages to LLM-compatible format
		convertToLlm: customConvertToLlm,
	});

	agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
		// Re-render on any event that might change the state
		renderApp();

		if (event.type === "message_end") {
			const messages = agent.state.messages;

			// Generate title after first successful response
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}

			// Create session ID on first successful save
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = generateUUID();
				updateUrl(currentSessionId);
			}

			// Auto-save
			if (currentSessionId) {
				saveSession().then(() => refreshSessions());
			}

			renderApp();
		}
	});

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			// Create javascript_repl tool with access to attachments + artifacts
			const replTool = createJavaScriptReplTool();
			replTool.runtimeProvidersFactory = runtimeProvidersFactory;

			// Inject the OS-level proxy tools
			return [replTool, remoteBashTool, remoteReadTool, remoteWriteTool, remoteEditTool];
		},
	});
};

const resolveFullModel = async (partialModel: any) => {
	if (!partialModel || !partialModel.id || !partialModel.provider) {
		return getModel("google-antigravity", "gemini-3-flash");
	}
	if (partialModel.api) return partialModel;

	const customProviders = await storage.customProviders.getAll();
	for (const p of customProviders) {
		if (p.name === partialModel.provider) {
			const found = p.models?.find((m: any) => m.id === partialModel.id);
			if (found) return found;
		}
	}

	try {
		return getModel(partialModel.provider as any, partialModel.id);
	} catch {
		return getModel("google-antigravity", "gemini-3-flash");
	}
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session not found:", sessionId);
		return false;
	}

	currentSessionId = sessionId;
	const metadata = await storage.sessions.getMetadata(sessionId);
	currentTitle = metadata?.title || "";

	const fullModel = await resolveFullModel(sessionData.model);

	await createAgent({
		model: fullModel,
		thinkingLevel: sessionData.thinkingLevel,
		messages: sessionData.messages,
		tools: [],
	});

	updateUrl(sessionId);
	renderApp();
	await refreshSessions();
	return true;
};

const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

// ============================================================================
// STATE
// ============================================================================
let sessionMetadataList: any[] = [];
let isFetchingSessions = false;

// Layout State
let leftSidebarWidth = 280;
let rightSidebarWidth = 320;
let leftSidebarCollapsed = false;
let rightSidebarCollapsed = false;
let isResizingLeft = false;
let isResizingRight = false;

const onMouseMove = (e: MouseEvent) => {
	if (isResizingLeft) {
		leftSidebarWidth = Math.max(200, Math.min(e.clientX, 600));
		renderApp();
	} else if (isResizingRight) {
		rightSidebarWidth = Math.max(200, Math.min(window.innerWidth - e.clientX, 800));
		renderApp();
	}
};

const onMouseUp = async () => {
	if (isResizingLeft || isResizingRight) {
		isResizingLeft = false;
		isResizingRight = false;
		document.body.style.cursor = "default";
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
		renderApp();

		// Persist
		await storage.settings.set("layout.leftWidth", leftSidebarWidth);
		await storage.settings.set("layout.rightWidth", rightSidebarWidth);
	}
};

const startLeftResize = (e: MouseEvent) => {
	e.preventDefault();
	isResizingLeft = true;
	document.body.style.cursor = "col-resize";
	document.addEventListener("mousemove", onMouseMove);
	document.addEventListener("mouseup", onMouseUp);
	renderApp();
};

const startRightResize = (e: MouseEvent) => {
	e.preventDefault();
	isResizingRight = true;
	document.body.style.cursor = "col-resize";
	document.addEventListener("mousemove", onMouseMove);
	document.addEventListener("mouseup", onMouseUp);
	renderApp();
};

const toggleLeftSidebar = async () => {
	leftSidebarCollapsed = !leftSidebarCollapsed;
	renderApp();
	await storage.settings.set("layout.leftCollapsed", leftSidebarCollapsed);
};

const toggleRightSidebar = async () => {
	rightSidebarCollapsed = !rightSidebarCollapsed;
	renderApp();
	await storage.settings.set("layout.rightCollapsed", rightSidebarCollapsed);
};

// Fetch sessions for the sidebar
const refreshSessions = async () => {
	if (!storage.sessions || isFetchingSessions) return;
	isFetchingSessions = true;
	try {
		sessionMetadataList = await storage.sessions.getAllMetadata();
		renderApp();
	} finally {
		isFetchingSessions = false;
	}
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const gridCols = [];
	if (!leftSidebarCollapsed) gridCols.push(`${leftSidebarWidth}px`, "auto");
	gridCols.push("1fr");
	if (!rightSidebarCollapsed) gridCols.push("auto", `${rightSidebarWidth}px`);

	const appHtml = html`
		<div class="app-layout ${currentTheme === "cyberpunk" ? "theme-cyberpunk" : ""}"
			style="grid-template-columns: ${gridCols.join(" ")};"
		>
			<!-- Left Sidebar -->
			${
				!leftSidebarCollapsed
					? html`
			<div class="left-sidebar bg-card/30 backdrop-blur-md">
				<div class="sidebar-section border-b border-border/50">
					<div class="flex items-center justify-between mb-4">
						<div class="sidebar-header mb-0">
							${icon(Plus, "sm")} ${i18n("Specialized Agents")}
						</div>
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Plus, "sm"),
							onClick: newSession,
							title: "New Session",
						})}
					</div>
					<select
						class="w-full bg-secondary/50 text-foreground text-sm rounded-lg px-3 py-2 outline-none border border-border hover:border-primary/50 transition-colors cursor-pointer"
						@change=${async (e: Event) => {
							const name = (e.target as HTMLSelectElement).value;
							if (name === "default") {
								selectedAgentName = undefined;
								await createAgent();
							} else {
								selectedAgentName = name;
								const config = await fetchAgentConfigByName(name);
								if (config) {
									const settings = config.files["settings.json"] || {};
									let model = agent.state.model;
									if (settings.defaultModel) {
										// defaultModel can be "provider/id" or just "id"
										const [providerHint, modelIdHint] = String(settings.defaultModel).includes("/")
											? String(settings.defaultModel).split("/", 2)
											: [undefined, String(settings.defaultModel)];

										let foundModel: any | undefined;
										const customProviders = await storage.customProviders.getAll();
										outer: for (const p of customProviders) {
											for (const m of p.models ?? []) {
												const idMatch = m.id === modelIdHint;
												const providerMatch =
													!providerHint || m.provider === providerHint || p.name === providerHint;
												if (idMatch && providerMatch) {
													foundModel = m;
													break outer;
												}
											}
										}

										if (foundModel) {
											model = foundModel;
										} else if (providerHint) {
											try {
												model = getModel(providerHint as any, modelIdHint);
											} catch (_e) {
												// keep current model
											}
										}
									}

									await createAgent({
										systemPrompt: config.systemPrompt,
										model: model,
										thinkingLevel: settings.defaultThinkingLevel || agent.state.thinkingLevel,
									});
								}
							}
							remoteBackend.setAgentName(selectedAgentName);
							await refreshSessions();
						}}
					>
						<option value="default" ?selected=${!selectedAgentName}>Default Agent</option>
						${availableAgents.map(
							(name) => html`
							<option value="${name}" ?selected=${selectedAgentName === name}>
								${name.charAt(0).toUpperCase() + name.slice(1)}
							</option>
						`,
						)}
					</select>
				</div>

				<div class="sidebar-header p-4 pb-2">
					${icon(History, "sm")} ${i18n("Recent Sessions")}
				</div>
				<div class="session-list-container flex-1 overflow-y-auto min-h-0 px-2 pb-4 scrollbar-thin">
					${
						sessionMetadataList.length === 0
							? html`
						<div class="px-4 py-8 text-center text-sm text-muted-foreground italic">
							${i18n("No sessions yet")}
						</div>
					`
							: sessionMetadataList.map(
									(s) => html`
						<div
							class="session-item group relative ${s.id === currentSessionId ? "active bg-primary/10 border-primary/20" : "hover:bg-accent/40"}"
							@click=${() => loadSession(s.id)}
						>
							<div class="session-title pr-6">${s.title || "Untitled Session"}</div>
							<div class="session-meta">
								${new Date(s.lastModified).toLocaleDateString()} • ${s.messageCount} ${i18n("messages")}
							</div>
							<button
								class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
								@click=${async (e: Event) => {
									e.stopPropagation();
									if (confirm(i18n("Delete this session?"))) {
										await storage.sessions?.delete(s.id);
										if (s.id === currentSessionId) {
											newSession();
										} else {
											await refreshSessions();
										}
									}
								}}
							>
								${icon(Plus, "xs", "rotate-45")}
							</button>
						</div>
					`,
								)
					}
				</div>

				<!-- Settings at bottom of left sidebar -->
				<div class="p-4 border-t border-border/50 flex items-center justify-between">
					<div class="flex items-center gap-1">
						<theme-toggle></theme-toggle>
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Settings, "sm"),
							onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
							title: "Settings",
						})}
						${Button({
							variant: "ghost",
							size: "sm",
							children: html`<span class="text-xs font-bold">${currentTheme === "cyberpunk" ? "RETRO" : "MODERN"}</span>`,
							onClick: toggleTheme,
							title: "Toggle Retro Theme",
						})}
					</div>
					<div class="text-[10px] text-muted-foreground font-mono">v1.21.9</div>
				</div>
			</div>
			`
					: ""
			}

			<!-- Left Resizer -->
			${!leftSidebarCollapsed ? html`<div class="sidebar-resizer left ${isResizingLeft ? "active" : ""}" @mousedown=${startLeftResize}></div>` : ""}

			<!-- Main Content -->
			<div class="main-content relative">
				<!-- Header (Condensed) -->
				<div class="flex items-center justify-between border-b border-border shrink-0 px-4 py-2 bg-background/80 backdrop-blur-md sticky top-0 z-10 ${currentTheme === "cyberpunk" ? "header-glow" : ""}">
					<!-- Notice toast -->
					${
						noticeText
							? html`<div class="absolute top-14 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-foreground text-background text-sm font-medium shadow-lg pointer-events-none animate-fade-in">${noticeText}</div>`
							: ""
					}
					<div class="flex items-center gap-2 overflow-hidden">
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(leftSidebarCollapsed ? PanelLeft : PanelLeftClose, "sm"),
							onClick: toggleLeftSidebar,
							title: leftSidebarCollapsed ? "Expand Left Sidebar" : "Collapse Left Sidebar",
						})}
						${
							currentTitle
								? isEditingTitle
									? html`<div class="flex items-center gap-2">
										${Input({
											type: "text",
											value: currentTitle,
											className: "text-sm w-64 session-title-input",
											onChange: async (e: Event) => {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													// Save state on every update (debounce if needed)
													if (storage.sessions && currentSessionId) {
														saveSession();
													}
													currentTitle = newTitle;
												}
												isEditingTitle = false;
												renderApp();
											},
											onKeyDown: async (e: KeyboardEvent) => {
												if (e.key === "Enter") {
													const newTitle = (e.target as HTMLInputElement).value.trim();
													if (
														newTitle &&
														newTitle !== currentTitle &&
														storage.sessions &&
														currentSessionId
													) {
														await storage.sessions.updateTitle(currentSessionId, newTitle);
														currentTitle = newTitle;
													}
													isEditingTitle = false;
													renderApp();
												} else if (e.key === "Escape") {
													isEditingTitle = false;
													renderApp();
												}
											},
										})}
									</div>`
									: html`<button
										class="px-2 py-1 text-base font-semibold text-foreground hover:bg-secondary rounded-lg transition-colors truncate max-w-md"
										@click=${() => {
											isEditingTitle = true;
											renderApp();
											requestAnimationFrame(() => {
												const input = app?.querySelector('input[type="text"]') as HTMLInputElement;
												if (input) {
													input.focus();
													input.select();
												}
											});
										}}
										title="Click to edit title"
									>
										${currentTitle}
									</button>`
								: html`<span class="text-base font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-orange-400">Pi Web UI</span>`
						}
					</div>
					<div class="flex items-center gap-2">
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(rightSidebarCollapsed ? PanelRight : PanelRightClose, "sm"),
							onClick: toggleRightSidebar,
							title: rightSidebarCollapsed ? "Expand Right Sidebar" : "Collapse Right Sidebar",
						})}
						${Button({
							variant: "ghost",
							size: "sm",
							children: icon(Bell, "sm"),
							onClick: () => {
								if (agent) {
									agent.steer(createSystemNotification("Notification system is active."));
								}
							},
							title: "Notifications",
						})}
					</div>
				</div>

				<!-- Chat Panel Container -->
				<div class="flex-1 min-h-0 relative">
					${chatPanel}
				</div>
			</div>

			<!-- Right Resizer -->
			${!rightSidebarCollapsed ? html`<div class="sidebar-resizer right ${isResizingRight ? "active" : ""}" @mousedown=${startRightResize}></div>` : ""}

			<!-- Right Sidebar (File Explorer) -->
			${
				!rightSidebarCollapsed
					? html`
			<div class="right-sidebar bg-card/30 backdrop-blur-md">
				<pi-file-explorer
					class="flex-1"
					@file-select=${async (e: CustomEvent) => {
						const { name, path } = e.detail;
						console.log("[main.ts] File selected:", name, path);

						if (!chatPanel) {
							console.log("[main.ts] No chatPanel instance");
							return;
						}
						if (!chatPanel.artifactsPanel) {
							console.log("[main.ts] No artifactsPanel inside chatPanel");
							return;
						}

						try {
							const resp = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`);
							if (!resp.ok) {
								console.error("[main.ts] Failed to download file:", resp.status);
								return;
							}

							const ext = name.split(".").pop()?.toLowerCase() || "";
							const binaryExtensions = [
								"png",
								"jpg",
								"jpeg",
								"gif",
								"webp",
								"pdf",
								"docx",
								"xlsx",
								"zip",
								"mp3",
								"mp4",
								"webm",
								"ogg",
								"wav",
								"bmp",
								"ico",
								"wasm",
							];

							let content: string;
							if (binaryExtensions.includes(ext)) {
								const blob = await resp.blob();
								content = await new Promise((resolve) => {
									const reader = new FileReader();
									reader.onloadend = () => resolve(reader.result as string);
									reader.readAsDataURL(blob);
								});
							} else {
								content = await resp.text();
							}

							console.log("[main.ts] Injecting into ArtifactsPanel...", name);
							chatPanel.artifactsPanel.injectArtifact(name, content);
						} catch (err) {
							console.error("[main.ts] Failed to inject artifact from file:", err);
						}
					}}
				></pi-file-explorer>
			</div>
			`
					: ""
			}
		</div>
	`;

	render(appHtml, app);
};

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Show loading
	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		app,
	);

	// TODO: Fix PersistentStorageDialog - currently broken
	// Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Listen for slash command events dispatched by AgentInterface
	document.addEventListener("new-session", () => {
		newSession();
	});

	document.addEventListener("resume-session", () => {
		// Expand left sidebar and show sessions list so user can pick one
		if (leftSidebarCollapsed) {
			leftSidebarCollapsed = false;
			storage.settings.set("layout.leftCollapsed", false);
		}
		renderApp();
		// Scroll sessions panel into view after render
		requestAnimationFrame(() => {
			document.querySelector(".session-item")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
		});
	});

	document.addEventListener("clone-session", async () => {
		if (!currentSessionId || !storage.sessions) return;
		try {
			const sessionData = await storage.sessions.get(currentSessionId);
			const origMeta = await storage.sessions.getMetadata(currentSessionId);
			if (!sessionData || !origMeta) return;
			const newId = crypto.randomUUID();
			const now = new Date().toISOString();
			const clonedData = { ...sessionData, id: newId, title: `${currentTitle} (Clone)` };
			const clonedMeta = { ...origMeta, id: newId, title: clonedData.title, createdAt: now, lastModified: now };
			await storage.sessions.save(clonedData, clonedMeta);
			await refreshSessions();
			const url = new URL(window.location.href);
			url.searchParams.set("session", newId);
			window.location.href = url.toString();
		} catch (err) {
			console.error("Clone failed:", err);
			showNotice("❌ Failed to clone session");
		}
	});

	document.addEventListener("show-session-stats", () => {
		if (!agent || !currentSessionId) return;
		const msgCount = agent.state.messages.length;
		const model = agent.state.model?.id || "unknown";
		showNotice(`📊 Session: ${msgCount} messages | Model: ${model}`);
	});

	document.addEventListener("auth-action", async (e: Event) => {
		const action = (e as CustomEvent).detail.action;
		const provider = agent?.state?.model?.provider;

		if (action === "login") {
			// Trigger the API key prompt dialog manually
			if (provider && chatPanel?.agentInterface?.onApiKeyRequired) {
				chatPanel.agentInterface.onApiKeyRequired(provider);
			} else {
				showNotice("⚠️ No model provider selected");
			}
		} else if (action === "logout") {
			if (provider) {
				await storage.providerKeys.delete(provider);
				showNotice(`🔒 Logged out of ${provider}`);
			}
		}
	});

	document.addEventListener("rename-session", () => {
		if (!currentSessionId) return;
		isEditingTitle = true;
		renderApp();
		// Focus the title input after render
		requestAnimationFrame(() => {
			const input = document.querySelector<HTMLInputElement>(".session-title-input");
			input?.focus();
			input?.select();
		});
	});

	document.addEventListener("compact-session", async () => {
		if (!agent) return;
		// Compaction is not yet wired in the web-ui agent - show notice
		chatPanel.agentInterface?.dispatchEvent(
			new CustomEvent("agent-notice", {
				detail: { text: "⚡ /compact - coming soon" },
				bubbles: true,
				composed: true,
			}),
		);
	});

	document.addEventListener("export-session", async () => {
		if (!currentSessionId || !storage.sessions) return;
		try {
			const sessionData = await storage.sessions.get(currentSessionId);
			if (!sessionData) return;
			const blob = new Blob([JSON.stringify(sessionData, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `session-${currentSessionId.slice(0, 8)}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error("Export failed:", err);
		}
	});

	document.addEventListener("agent-notice", (e: Event) => {
		const { text } = (e as CustomEvent<{ text: string }>).detail;
		// Show as a transient toast-style notice in the header area
		showNotice(text);
	});

	// Sync with local agent configuration
	try {
		await syncAgentConfig(storage);
	} catch (err) {
		console.error("Failed to sync with local agent:", err);
	}

	// Fetch available specialized agents
	try {
		availableAgents = await fetchAgentsList();
	} catch (err) {
		console.error("Failed to fetch specialized agents:", err);
	}

	// Fetch system environment for default prompt
	try {
		const envRes = await fetch("/api/sys/env");
		if (envRes.ok) {
			systemEnv = await envRes.json();
		}
	} catch (e) {
		console.warn("Could not fetch system env:", e);
	}

	// Load layout preferences
	const savedLeftWidth = await storage.settings.get<number>("layout.leftWidth");
	if (savedLeftWidth) leftSidebarWidth = savedLeftWidth;
	const savedRightWidth = await storage.settings.get<number>("layout.rightWidth");
	if (savedRightWidth) rightSidebarWidth = savedRightWidth;

	const savedLeftCollapsed = await storage.settings.get<boolean>("layout.leftCollapsed");
	if (savedLeftCollapsed !== undefined && savedLeftCollapsed !== null) leftSidebarCollapsed = savedLeftCollapsed;
	const savedRightCollapsed = await storage.settings.get<boolean>("layout.rightCollapsed");
	if (savedRightCollapsed !== undefined && savedRightCollapsed !== null) rightSidebarCollapsed = savedRightCollapsed;

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	} else {
		await createAgent();
	}

	await refreshSessions();
}

initApp();
