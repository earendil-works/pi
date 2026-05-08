// Auto-Provisionierung: Beim ersten Start einen Custom Provider „infomaniak"
// und sinnvolle Defaults (Proxy auf /api/proxy, Default-Modell Kimi K2.6) anlegen.
//
// Idempotent: läuft bei jedem Reload, prüft Existenz, ändert nur, was fehlt.

import type { Model } from "@earendil-works/pi-ai";
import type { CustomProvider } from "@earendil-works/pi-web-ui";
import type {
	CustomProvidersStore,
	ProviderKeysStore,
	SettingsStore,
} from "@earendil-works/pi-web-ui";

const INFOMANIAK_BASE_URL = "https://api.infomaniak.com/2/ai/108471/openai/v1";
const PROXY_URL_DEFAULT = "/api/proxy";

// Infomaniak-Modellkatalog. Synchron mit ~/pi/personal/shared/models.json.
// Costs: grobe Schätzung in $/Mio Tokens (für UI-Anzeige; tatsächliche
// Abrechnung läuft über Infomaniak-Konto, nicht hier).
const INFOMANIAK_MODELS: Model<"openai-completions">[] = [
	{
		id: "moonshotai/Kimi-K2.6",
		name: "Kimi K2.6 (Coding, Reasoning, 200k)",
		api: "openai-completions",
		provider: "infomaniak",
		baseUrl: INFOMANIAK_BASE_URL,
		// Kimi K2.6 liefert bei Infomaniak konsistent einen thinking-Block neben
		// dem text-Block. Wenn reasoning auf false stand, hat pi-web-ui den
		// kompletten Message-Render abgewuergt und nur den thinking-Block
		// waehrend des Streams gezeigt. Mit reasoning=true wird der Standard-
		// thinking+text-Render-Pfad aktiv.
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 0.3, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "Qwen/Qwen3.5-122B-A10B-FP8",
		name: "Qwen 3.5 122B (Reasoning, gross)",
		api: "openai-completions",
		provider: "infomaniak",
		baseUrl: INFOMANIAK_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.4, output: 0.8, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 16384,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "swiss-ai/Apertus-70B-Instruct-2509",
		name: "Apertus 70B (Swiss AI)",
		api: "openai-completions",
		provider: "infomaniak",
		baseUrl: INFOMANIAK_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0.4, output: 0.4, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "google/gemma-4-31B-it",
		name: "Gemma 4 31B (Allrounder)",
		api: "openai-completions",
		provider: "infomaniak",
		baseUrl: INFOMANIAK_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0.2, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
	{
		id: "mistralai/Ministral-3-14B-Instruct-2512",
		name: "Ministral 3 14B (kompakt, schnell)",
		api: "openai-completions",
		provider: "infomaniak",
		baseUrl: INFOMANIAK_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	},
];

export const DEFAULT_MODEL: Model<"openai-completions"> = INFOMANIAK_MODELS[0];

/**
 * Heuristik, ob ein String wie ein gültiger API-Key aussieht.
 * Verwirft eindeutige Junk-Werte (Strg+V-Unfälle mit Mehrzeiligem,
 * leere Strings, absurd lange Texte). Konservativ — hier wird nur
 * offensichtlicher Müll abgewiesen, nicht semantisch geprüft.
 */
export function isPlausibleKey(key: string | null | undefined): key is string {
	if (!key || typeof key !== "string") return false;
	const trimmed = key.trim();
	if (trimmed !== key) return false; // führender/abschließender Whitespace
	if (/[\r\n]/.test(key)) return false; // Newlines (Strg+V-Unfall)
	if (key.length < 16) return false; // zu kurz
	if (key.length > 4096) return false; // unplausibel lang (Token sind <= ~2048 Zeichen)
	return true;
}

/**
 * Sync zwischen den zwei Storage-Slots, die pi-web-ui 0.74.0 ohne
 * Sync-Mechanismus parallel pflegt:
 * - CustomProviderDialog speichert den Key in `customProviders[id].apiKey`
 * - AgentInterface.sendMessage / agent-loop liest aus `providerKeys.get(provider)`
 *
 * Diese Funktion gleicht beide ab und säubert Junk-Einträge:
 * - Junk im customProvider.apiKey wird entfernt (UI zeigt dann „kein Key")
 * - Plausibler Key wird in beide Slots geschrieben (Send-Logik findet ihn,
 *   UI zeigt „Key konfiguriert")
 *
 * Idempotent — kann bei jedem App-Start laufen.
 */
export async function syncInfomaniakApiKey(
	customProviders: CustomProvidersStore,
	providerKeys: ProviderKeysStore,
): Promise<void> {
	const cp = await customProviders.get("infomaniak");
	if (!cp) return; // ensureInfomaniakProvider sollte vorher gelaufen sein

	const cpKey = cp.apiKey;
	const pkKey = await providerKeys.get("infomaniak");

	const cpPlausible = isPlausibleKey(cpKey);
	const pkPlausible = isPlausibleKey(pkKey);

	// Junk im Custom-Provider entfernen
	if (cpKey && !cpPlausible) {
		await customProviders.set({ ...cp, apiKey: undefined });
	}

	// Bevorzugter Key: was plausibel ist; wenn beide plausibel sind, gewinnt providerKeys
	// (= ApiKeyPromptDialog hat Priorität, weil das der „offiziellere" Eingabe-Pfad ist)
	const canonical = pkPlausible ? pkKey : cpPlausible ? cpKey : undefined;
	if (!canonical) return;

	// In beide Slots schreiben (idempotent: nur wenn Wert anders)
	if (pkKey !== canonical) {
		await providerKeys.set("infomaniak", canonical);
	}
	if (cp.apiKey !== canonical) {
		// Re-Read, weil customProviders.set oben ggf. geändert hat
		const fresh = await customProviders.get("infomaniak");
		if (fresh) {
			await customProviders.set({ ...fresh, apiKey: canonical });
		}
	}
}

export async function ensureInfomaniakProvider(
	customProviders: CustomProvidersStore,
	providerKeys: ProviderKeysStore,
	settings: SettingsStore,
): Promise<void> {
	// 1. CustomProvider „infomaniak" anlegen, falls nicht vorhanden
	const existing = await customProviders.get("infomaniak");
	if (!existing) {
		const provider: CustomProvider = {
			id: "infomaniak",
			name: "Infomaniak (Schweiz)",
			type: "openai-completions",
			baseUrl: INFOMANIAK_BASE_URL,
			models: INFOMANIAK_MODELS,
		};
		await customProviders.set(provider);
	}

	// 2. Proxy-Defaults setzen (CORS-Bypass via eigener VPS-Proxy)
	const proxyUrl = await settings.get<string>("proxy.url");
	if (!proxyUrl) {
		await settings.set("proxy.url", PROXY_URL_DEFAULT);
	}
	const proxyEnabled = await settings.get<boolean>("proxy.enabled");
	if (proxyEnabled === null) {
		await settings.set("proxy.enabled", true);
	}

	// 3. API-Key-Slots zwischen customProviders und providerKeys synchronisieren
	//    + Junk-Werte aufräumen (siehe syncInfomaniakApiKey)
	await syncInfomaniakApiKey(customProviders, providerKeys);
}
