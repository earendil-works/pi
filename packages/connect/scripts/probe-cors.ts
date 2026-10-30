#!/usr/bin/env node
/**
 * Check the bundled auth documents against what providers' endpoints accept from browsers today.
 *
 * Providers change CORS without notice. This script sends each endpoint a CORS preflight from a
 * foreign origin, with the headers pi-ai's requests carry, and compares the result with the
 * documents and the relay list:
 *
 * - a provider's model API answers the preflight exactly when its document says `inference: direct`;
 * - a method's sign-in needs the relay exactly when one of its sign-in endpoints refuses browsers,
 *   and its refresh exactly when its refresh endpoint refuses them;
 * - every endpoint that refuses browsers and that a supported method needs is on the relay list.
 *
 * It exits with 1 on any mismatch. Run it before publishing new documents, and on a schedule:
 *
 *   node packages/connect/scripts/probe-cors.ts
 */

import { BUILTIN_AUTH_DOCUMENTS } from "../src/builtin-documents.ts";
import { findRelayEndpoint } from "../src/relay.ts";

type Probe = { method: "GET" | "POST"; url: string; headers: string[] };

/** The endpoints a provider's requests reach, with the headers pi-ai sends there. */
type ProviderProbes = {
	inference: Probe;
	/** Per OAuth method ID: the endpoints its sign-in calls, and the one its refresh calls. */
	methods?: Record<string, { signIn: Probe[]; refresh?: Probe }>;
};

const OPENAI_HEADERS = ["authorization", "content-type", "x-stainless-os", "x-stainless-lang"];
const ANTHROPIC_HEADERS = [
	"x-api-key",
	"authorization",
	"content-type",
	"anthropic-version",
	"anthropic-beta",
	"anthropic-dangerous-direct-browser-access",
];
const FORM = ["content-type"];

const post = (url: string, headers: string[] = FORM): Probe => ({ method: "POST", url, headers });

const RADIUS_TOKEN = post("https://radius.pi.dev/v1/oauth/token");
const ANTHROPIC_TOKEN = post("https://platform.claude.com/v1/oauth/token");
const CODEX_TOKEN = post("https://auth.openai.com/oauth/token");
const CHATGPT_TOKEN = post("https://auth.openai.com/api/accounts/oauth/token");
const COPILOT_TOKEN: Probe = {
	method: "GET",
	url: "https://api.github.com/copilot_internal/v2/token",
	headers: ["authorization", "editor-version", "editor-plugin-version", "copilot-integration-id"],
};
const XAI_TOKEN = post("https://auth.x.ai/oauth2/token");
const META_KEY = post("https://api.meta.ai/muse-code/key", ["authorization", "content-type", "x-api-version"]);
const KIMI_TOKEN = post("https://auth.kimi.com/api/oauth/token");

const PROBES: Record<string, ProviderProbes> = {
	radius: {
		inference: post("https://radius.pi.dev/v1/messages", ["authorization", "content-type"]),
		methods: {
			"device-code": { signIn: [post("https://radius.pi.dev/v1/oauth/device"), RADIUS_TOKEN], refresh: RADIUS_TOKEN },
		},
	},
	anthropic: {
		inference: post("https://api.anthropic.com/v1/messages", ANTHROPIC_HEADERS),
		methods: {
			copy_code: { signIn: [ANTHROPIC_TOKEN], refresh: ANTHROPIC_TOKEN },
			browser: { signIn: [ANTHROPIC_TOKEN], refresh: ANTHROPIC_TOKEN },
		},
	},
	openai: {
		inference: post("https://api.openai.com/v1/responses", OPENAI_HEADERS),
		methods: { browser: { signIn: [CHATGPT_TOKEN], refresh: CHATGPT_TOKEN } },
	},
	"openai-codex": {
		inference: post("https://chatgpt.com/backend-api/codex/responses", [
			"authorization",
			"content-type",
			"chatgpt-account-id",
			"openai-beta",
			"session-id",
		]),
		methods: {
			device_code: {
				signIn: [
					post("https://auth.openai.com/api/accounts/deviceauth/usercode", ["content-type"]),
					post("https://auth.openai.com/api/accounts/deviceauth/token", ["content-type"]),
					CODEX_TOKEN,
				],
				refresh: CODEX_TOKEN,
			},
			browser: { signIn: [CODEX_TOKEN], refresh: CODEX_TOKEN },
		},
	},
	"github-copilot": {
		inference: post("https://api.individual.githubcopilot.com/chat/completions", [
			...OPENAI_HEADERS,
			"editor-version",
			"editor-plugin-version",
			"copilot-integration-id",
			"openai-intent",
			"x-initiator",
		]),
		methods: {
			device_code: {
				signIn: [
					post("https://github.com/login/device/code"),
					post("https://github.com/login/oauth/access_token"),
					COPILOT_TOKEN,
				],
				refresh: COPILOT_TOKEN,
			},
		},
	},
	xai: {
		inference: post("https://api.x.ai/v1/responses", OPENAI_HEADERS),
		methods: { device_code: { signIn: [post("https://auth.x.ai/oauth2/device/code"), XAI_TOKEN], refresh: XAI_TOKEN } },
	},
	meta: {
		inference: post("https://api.meta.ai/v1/responses", OPENAI_HEADERS),
		methods: {
			device_code: {
				signIn: [
					post("https://auth.meta.com/oidc/device/authorization/"),
					post("https://auth.meta.com/oidc/device/token/"),
					META_KEY,
				],
				refresh: META_KEY,
			},
		},
	},
	"kimi-coding": {
		inference: post("https://api.kimi.com/coding/v1/chat/completions", OPENAI_HEADERS),
		methods: {
			device_code: { signIn: [post("https://auth.kimi.com/api/oauth/device_authorization"), KIMI_TOKEN], refresh: KIMI_TOKEN },
		},
	},
	openrouter: { inference: post("https://openrouter.ai/api/v1/messages", ANTHROPIC_HEADERS) },
	google: {
		inference: post("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent", [
			"content-type",
			"x-goog-api-key",
			"x-goog-api-client",
		]),
	},
	mistral: { inference: post("https://api.mistral.ai/v1/chat/completions", ["authorization", "content-type"]) },
	groq: { inference: post("https://api.groq.com/openai/v1/chat/completions", OPENAI_HEADERS) },
	deepseek: { inference: post("https://api.deepseek.com/chat/completions", OPENAI_HEADERS) },
	cerebras: { inference: post("https://api.cerebras.ai/v1/chat/completions", OPENAI_HEADERS) },
	together: { inference: post("https://api.together.ai/v1/chat/completions", OPENAI_HEADERS) },
	huggingface: { inference: post("https://router.huggingface.co/v1/chat/completions", OPENAI_HEADERS) },
	fireworks: { inference: post("https://api.fireworks.ai/inference/v1/messages", ANTHROPIC_HEADERS) },
	moonshotai: { inference: post("https://api.moonshot.ai/v1/chat/completions", OPENAI_HEADERS) },
};

const ORIGIN = "https://example.com";

const results = new Map<string, Promise<boolean>>();

/** Whether a browser on a foreign origin may send the probe's request; each endpoint is asked once. */
function acceptsBrowsers(probe: Probe): Promise<boolean> {
	const key = `${probe.method} ${probe.url} ${probe.headers.join(",")}`;
	let result = results.get(key);
	if (!result) {
		result = preflight(probe);
		results.set(key, result);
	}
	return result;
}

async function preflight(probe: Probe): Promise<boolean> {
	try {
		const response = await fetch(probe.url, {
			method: "OPTIONS",
			headers: {
				origin: ORIGIN,
				"access-control-request-method": probe.method,
				"access-control-request-headers": probe.headers.join(","),
			},
			signal: AbortSignal.timeout(15_000),
		});
		const allowOrigin = response.headers.get("access-control-allow-origin");
		if (!response.ok || (allowOrigin !== "*" && allowOrigin !== ORIGIN)) return false;
		const allowed = (response.headers.get("access-control-allow-headers") ?? "")
			.split(",")
			.map((header) => header.trim().toLowerCase());
		return allowed.includes("*") || probe.headers.every((header) => allowed.includes(header));
	} catch {
		return false;
	}
}

const problems: string[] = [];

for (const document of BUILTIN_AUTH_DOCUMENTS.providers) {
	const probes = PROBES[document.provider];
	if (!probes) {
		problems.push(`${document.provider}: no probes defined`);
		continue;
	}
	const inference = await acceptsBrowsers(probes.inference);
	console.log(`${document.provider}: inference ${inference ? "open" : "closed"}`);
	if (inference !== (document.inference.browser === "direct")) {
		problems.push(`${document.provider}: document says inference ${document.inference.browser}, endpoint is ${inference ? "open" : "closed"}`);
	}

	for (const method of document.methods) {
		if (method.type !== "oauth" || method.browser.signIn === "unsupported") continue;
		const endpoints = probes.methods?.[method.id];
		if (!endpoints) {
			problems.push(`${document.provider}/${method.id}: no probes defined`);
			continue;
		}
		const closed: Probe[] = [];
		for (const probe of endpoints.signIn) if (!(await acceptsBrowsers(probe))) closed.push(probe);
		const refreshOpen = endpoints.refresh ? await acceptsBrowsers(endpoints.refresh) : true;
		if (endpoints.refresh && !refreshOpen) closed.push(endpoints.refresh);
		const needed = !refreshOpen ? "always" : closed.length > 0 ? "login" : "none";
		console.log(`  ${method.id}: relay ${needed}`);
		if (needed !== method.browser.relay) {
			problems.push(`${document.provider}/${method.id}: document says relay ${method.browser.relay}, endpoints need ${needed}`);
		}
		for (const probe of closed) {
			if (!findRelayEndpoint(new URL(probe.url), probe.method)) {
				problems.push(`${document.provider}/${method.id}: ${probe.method} ${probe.url} refuses browsers and is not relayed`);
			}
		}
	}
}

if (problems.length > 0) {
	console.error(`\n${problems.length} mismatch(es):\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
	process.exit(1);
}
console.log(`\nAll documents match (revision ${BUILTIN_AUTH_DOCUMENTS.revision}).`);
