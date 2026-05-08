// Pi Web Docs — datenschutzkonformer Dokumenten-Chat im Browser.
//
// Architektur (siehe ../README.md):
// - Frontend statisch auf Hetzner-VPS (Frankfurt)
// - oauth2-proxy davor (Google-OAuth, nur o.gerets@gmail.com)
// - eigener CORS-Proxy → Infomaniak (Schweiz, OpenAI-kompatibel)
// - Default-Modell Kimi K2.6 (200k Kontext)
//
// Ableitung von packages/web-ui/example/src/main.ts (pi 0.74.0). Anpassungen:
// - Auto-Provisionierung Custom Provider „infomaniak" beim First-Run
// - Eigener streamFn, der den eigenen Proxy IMMER nutzt (Bypass von
//   shouldUseProxyForProvider, das für unbekannte Provider keinen Proxy
//   anwendet)
// - Deutsche UI-Texte, Doku-fokussierter System-Prompt

import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple, type Model, type TextContent } from "@earendil-works/pi-ai";
import {
	type AgentState,
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	createJavaScriptReplTool,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@earendil-works/pi-web-ui";
import { html, render } from "lit";
import { History, Plus, Settings } from "lucide";
import "./app.css";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { customConvertToLlm, registerCustomMessageRenderers } from "./custom-messages.js";
import { DEFAULT_MODEL, ensureInfomaniakProvider } from "./infomaniak-bootstrap.js";

// Custom Renderer für system-notification-Messages
registerCustomMessageRenderers();

// Stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// IndexedDB-Backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-docs",
	version: 1,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// Eigener streamFn: nutzt IMMER den konfigurierten Proxy für Custom Provider.
// Standard-createStreamFn würde shouldUseProxyForProvider("infomaniak") aufrufen
// → false → kein Proxy → CORS-Fehler. Wir umgehen das, weil wir wissen, dass
// docs.og-monschau.de → /api/proxy → api.infomaniak.com der einzige Pfad ist.
const proxiedStreamFn: StreamFn = async (model, context, options) => {
	const enabled = await settings.get<boolean>("proxy.enabled");
	const proxyUrl = await settings.get<string>("proxy.url");
	let effectiveModel: Model<any> = model;
	if (enabled && proxyUrl && model.baseUrl) {
		effectiveModel = {
			...model,
			baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
		};
	}
	return streamSimple(effectiveModel, context, options);
};

let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;

const SYSTEM_PROMPT = `Du bist ein deutschsprachiger Assistent zur Auswertung von Dokumenten (Personalakten, Verträge, Schriftverkehr, Anhörungen, Beratungsfälle).

Arbeitsweise:
- Du fasst Dokumente präzise zusammen, vergleichst sie miteinander, beantwortest gezielte Fragen und entwirfst Antwortschreiben.
- Wenn ein Dokument hochgeladen wird, lies es vollständig, bevor du antwortest.
- Bei rechtlichen Themen (MAV-Recht, Arbeitsrecht, Aufenthaltsrecht) bist du gründlich, nennst Paragraphen wenn bekannt, aber kennzeichnest klar, wenn du dir unsicher bist — keine Halluzinationen.
- Bei personenbezogenen Daten gehst du zurückhaltend mit Wiederholungen um (Datensparsamkeit).
- Antworten in einfacher, klarer Sprache. Keine Marketing-Phrasen.

Werkzeuge:
- JavaScript REPL: Im Browser-Sandbox für Berechnungen, Datums-Differenzen, einfache Tabellen-Auswertung
- Artifacts: Tabellen, Listen, Schreibvorlagen als HTML/Markdown rendern`;

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c): c is TextContent => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
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
	const hasUserMsg = messages.some((m) => m.role === "user");
	const hasAssistantMsg = messages.some((m) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;
	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};

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
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Session-Speichern fehlgeschlagen:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: SYSTEM_PROMPT,
			model: DEFAULT_MODEL,
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		streamFn: proxiedStreamFn,
		convertToLlm: customConvertToLlm,
	});

	agentUnsubscribe = agent.subscribe((event: any) => {
		if (event.type === "state-update") {
			const messages = event.state.messages;
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
			}
			if (currentSessionId) {
				saveSession();
			}
			renderApp();
		}
	});

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const replTool = createJavaScriptReplTool();
			replTool.runtimeProvidersFactory = runtimeProvidersFactory;
			return [replTool];
		},
	});
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;

	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) {
		console.error("Session nicht gefunden:", sessionId);
		return false;
	}

	currentSessionId = sessionId;
	const metadata = await storage.sessions.getMetadata(sessionId);
	currentTitle = metadata?.title || "";

	await createAgent({
		systemPrompt: SYSTEM_PROMPT,
		model: sessionData.model,
		thinkingLevel: sessionData.thinkingLevel,
		messages: sessionData.messages,
		tools: [],
	});

	updateUrl(sessionId);
	renderApp();
	return true;
};

const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "Neue Session",
					})}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-64",
										onChange: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
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
									class="px-2 py-1 text-sm text-foreground hover:bg-secondary rounded transition-colors"
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
									title="Titel bearbeiten"
								>
									${currentTitle}
								</button>`
							: html`<span class="text-base font-semibold text-foreground">Dokumenten-Chat</span>`
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
						title: "Einstellungen",
					})}
				</div>
			</div>
			${chatPanel}
		</div>
	`;

	render(appHtml, app);
};

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App-Container nicht gefunden");

	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Lade Dokumenten-Chat…</div>
			</div>
		`,
		app,
	);

	// Auto-Provisionierung: Custom Provider „infomaniak" + Proxy-Defaults
	await ensureInfomaniakProvider(customProviders, settings);

	chatPanel = new ChatPanel();

	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			newSession();
			return;
		}
	} else {
		await createAgent();
	}

	renderApp();
}

initApp();
