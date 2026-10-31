// SigV4 signing for Bedrock Mantle requests. Node-only: loaded through a
// variable-specifier import from bedrock-mantle.ts so browser bundles skip it.

import { createHash, createHmac } from "node:crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { FetchFunction, ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

// Mantle rejects SigV4 credentials scoped to any other service.
const SIGV4_SERVICE = "bedrock-mantle";

function staticCredentials(env: ProviderEnv | undefined) {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) return undefined;
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** Node hash for SigV4; avoids pulling in @aws-crypto. */
class Sha256 {
	private readonly hash;
	constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
		this.hash = secret
			? createHmac("sha256", typeof secret === "string" ? secret : new Uint8Array(secret as ArrayBuffer))
			: createHash("sha256");
	}
	update(data: string | ArrayBufferView): void {
		this.hash.update(data as string);
	}
	async digest(): Promise<Uint8Array> {
		return new Uint8Array(this.hash.digest());
	}
}

/**
 * A fetch that signs each request with SigV4 for the `bedrock-mantle` service.
 * Credentials resolve like Converse: a profile from pi's auth flow wins over
 * ambient access keys, which win over the rest of the AWS default chain.
 */
export function createMantleSigV4Fetch(options: {
	region: string;
	env?: ProviderEnv;
	profile?: string;
	fetch?: FetchFunction;
}): FetchFunction {
	const baseFetch = options.fetch ?? globalThis.fetch;
	let signer: SignatureV4 | undefined;
	const getSigner = () => {
		signer ??= (() => {
			const profile = options.profile || options.env?.AWS_PROFILE;
			const credentials =
				(!profile && staticCredentials(options.env)) ||
				defaultProvider({
					profile: profile || getProviderEnvValue("AWS_PROFILE", options.env),
				});
			return new SignatureV4({ credentials, region: options.region, service: SIGV4_SERVICE, sha256: Sha256 });
		})();
		return signer;
	};

	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const body = request.body ? await request.text() : undefined;
		const headers: Record<string, string> = { host: url.host };
		request.headers.forEach((value, name) => {
			if (name !== "authorization" && name !== "x-api-key") headers[name] = value;
		});
		const query: Record<string, string | string[]> = {};
		for (const [name, value] of url.searchParams) {
			const current = query[name];
			query[name] = current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
		}
		const signed = await getSigner().sign({
			method: request.method,
			protocol: url.protocol,
			hostname: url.hostname,
			path: url.pathname,
			query,
			headers,
			body,
		});
		const signedHeaders = new Headers(signed.headers as Record<string, string>);
		signedHeaders.delete("host");
		return baseFetch(url, {
			method: request.method,
			headers: signedHeaders,
			body,
			signal: init?.signal ?? request.signal,
		});
	};
}
