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
import { DEFAULT_MODEL, ensureInfomaniakProvider, isPlausibleKey } from "./infomaniak-bootstrap.js";

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
//
// Zusätzlich: API-Key auf Whitespace/Newlines prüfen (sonst wirft fetch einen
// stillen TypeError beim Header-Aufbau, kein Request geht raus, kein Server-Log
// — genau das ist beim ersten Live-Test passiert, weil ein Claude-Code-Bericht
// per Strg+V im API-Key-Feld gelandet war).
const proxiedStreamFn: StreamFn = async (model, context, options) => {
	if (options?.apiKey) {
		const key = options.apiKey;
		if (key !== key.trim() || /[\r\n]/.test(key)) {
			throw new Error(
				"API-Key enthaelt Leerzeichen oder Zeilenumbrueche. Settings oeffnen, Custom Provider 'Infomaniak (Schweiz)' editieren und Key korrekt eintragen (kein Strg+V mit Mehrzeiligem).",
			);
		}
	}
	const enabled = await settings.get<boolean>("proxy.enabled");
	const proxyUrl = await settings.get<string>("proxy.url");
	let effectiveModel: Model<any> = model;
	if (enabled && proxyUrl && model.baseUrl) {
		// Wichtig: proxyUrl absolut machen. pi-ai ruft intern `new URL(baseUrl)`
		// ohne Base-Argument auf — relative URLs crashen mit „Failed to construct
		// 'URL': Invalid URL", noch bevor der fetch-Call rausgeht (Diagnose 2026-05-08).
		const absProxyUrl = proxyUrl.startsWith("http")
			? proxyUrl
			: `${window.location.origin}${proxyUrl.startsWith("/") ? "" : "/"}${proxyUrl}`;
		effectiveModel = {
			...model,
			baseUrl: `${absProxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`,
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
		// Defense-in-Depth fuer den pi-web-ui-Bug: AgentInterface setzt zwar
		// session.getApiKey selbst, falls nicht gesetzt — aber dort liest es nur
		// providerKeys. Falls die Bootstrap-Migration mal haengt, kann der Custom-
		// Provider-apiKey trotzdem als Fallback dienen.
		getApiKey: async (provider: string) => {
			const fromKeys = await providerKeys.get(provider);
			if (isPlausibleKey(fromKeys)) return fromKeys;
			const cp = await customProviders.get(provider);
			if (cp?.apiKey && isPlausibleKey(cp.apiKey)) return cp.apiKey;
			return undefined;
		},
	});

	// Echte agent.subscribe-Event-Types (pi-agent-core 0.74):
	//   agent_start, turn_start, message_start, message_update, message_end,
	//   turn_end, agent_end
	// "state-update" gibt es NICHT (war im Original-example main.ts auch dead code).
	agentUnsubscribe = agent.subscribe((event: any) => {
		// Bei message_end / agent_end: Lit-Reactivity-Bug in pi-web-uis MessageList
		// in Firefox umgehen. Symptom: messageList.messages-Property ist gesetzt
		// (z.B. 2 Eintraege), aber das DOM rendert leer (height=0, kein assistant-
		// element). Bei mehrfach-Block-Content (thinking + text) tritt es zuverlaessig
		// auf. Manuelles requestUpdate() zwingt das Lit-Element zum Re-Render.
		if (event?.type === "message_end" || event?.type === "agent_end") {
			const ml = document.querySelector("message-list") as { requestUpdate?: () => void } | null;
			if (ml && typeof ml.requestUpdate === "function") {
				ml.requestUpdate();
			}
		}

		// pi-agent-core setzt state.isStreaming erst NACH allen agent_end-
		// Listenern auf false (siehe agent.ts finishRun() im finally-Block).
		// AgentInterface ruft aber synchron im agent_end-Listener requestUpdate()
		// und sieht dabei noch isStreaming=true → MessageEditor rendert weiter
		// den Stop-Button (Square) statt Send → keine zweite Eingabe moeglich.
		// Mit queueMicrotask laeuft unser Re-Render NACH finishRun() und sieht
		// das korrigierte isStreaming=false. (Diagnose 2026-05-09.)
		if (event?.type === "agent_end") {
			queueMicrotask(() => {
				const ai = document.querySelector("agent-interface") as { requestUpdate?: () => void } | null;
				if (ai && typeof ai.requestUpdate === "function") {
					ai.requestUpdate();
				}
			});
		}

		// Header-State (Title, Session-ID) wird aus event.state oder agent.state
		// gepflegt. Bei agent_end snapshot wir den finalen State und re-rendern
		// den Header genau einmal.
		if (event?.type === "agent_end") {
			const messages = (agent.state.messages || []) as AgentMessage[];
			let needsRender = false;
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				needsRender = true;
			}
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
				needsRender = true;
			}
			if (currentSessionId) {
				saveSession();
			}
			if (needsRender) {
				renderApp();
			}
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
						className: "btn-touch",
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
						className: "btn-touch",
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
										className: "text-sm title-input",
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
						className: "btn-touch",
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
	await ensureInfomaniakProvider(customProviders, providerKeys, settings);

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
