import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import { createRequire } from "node:module";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const require = createRequire(import.meta.url);
const { getProxyForUrl } = require("proxy-from-env") as { getProxyForUrl: (url: string) => string };

export interface NodeHttpProxyAgents {
	httpAgent: HttpAgent;
	httpsAgent: HttpsAgent;
}

export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

export function resolveHttpProxyUrlForTarget(targetUrl: string | URL): URL | undefined {
	const proxy = getProxyForUrl(targetUrl.toString());
	if (!proxy) {
		return undefined;
	}

	let proxyUrl: URL;
	try {
		proxyUrl = new URL(proxy);
	} catch (error) {
		throw new Error(
			`Invalid proxy URL ${JSON.stringify(proxy)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
	}

	return proxyUrl;
}

export function createHttpProxyAgentsForTarget(targetUrl: string | URL): NodeHttpProxyAgents | undefined {
	const proxyUrl = resolveHttpProxyUrlForTarget(targetUrl);
	if (!proxyUrl) {
		return undefined;
	}

	return {
		httpAgent: new HttpProxyAgent(proxyUrl),
		httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
	};
}
