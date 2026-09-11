import { readFile } from "node:fs/promises";
import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";
import { getAuthCredential } from "../cli/auth-command.ts";
import type { AuthInput } from "../cli/experimental/command-options.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { resolvePath } from "../utils/paths.ts";

export const ENV_RADIUS_GATEWAY = "PI_RADIUS_GATEWAY";

export interface RadiusRelayAuth {
	readonly gateway: string;
	readonly token: string;
}

/** Resolve explicit or stored Radius credentials anew for every relay connection attempt. */
export class RadiusRelayAuthResolver {
	readonly #input: AuthInput | undefined;
	readonly #gateway: string;
	#modelRuntime: Promise<ModelRuntime> | undefined;

	constructor(input?: AuthInput, gateway = process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY) {
		this.#input = input;
		this.#gateway = normalizeRadiusGatewayUrl(gateway);
	}

	get gateway(): string {
		return this.#gateway;
	}

	async resolve(options: {
		readonly required: boolean;
		readonly signal?: AbortSignal;
	}): Promise<RadiusRelayAuth | undefined> {
		options.signal?.throwIfAborted();
		if (process.env.PI_OFFLINE !== undefined) {
			if (options.required) throw new Error("Radius relay connections are unavailable in offline mode");
			return undefined;
		}

		const explicit = await this.#explicitToken(options.signal);
		if (explicit !== undefined) return { gateway: this.#gateway, token: explicit };

		this.#modelRuntime ??= ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
		const runtime = await this.#modelRuntime;
		options.signal?.throwIfAborted();
		const token = getAuthCredential(
			await runtime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000, signal: options.signal }),
		);
		if (token !== undefined && token.length > 0) return { gateway: this.#gateway, token };
		if (options.required) {
			throw new Error("Radius authentication is required; start Pi and run /login radius, then retry");
		}
		return undefined;
	}

	async #explicitToken(signal: AbortSignal | undefined): Promise<string | undefined> {
		if (this.#input === undefined) return undefined;
		const value =
			this.#input.type === "token"
				? this.#input.token
				: await readFile(resolvePath(this.#input.path), { encoding: "utf8", signal });
		const token = value.trim();
		if (token.length === 0) throw new Error("Radius authentication token must not be empty");
		return token;
	}
}
