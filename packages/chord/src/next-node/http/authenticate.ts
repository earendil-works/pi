// Who someone is (decision "The HTTP server is a native object", replacing the `authenticate` option): the registry
// `Authenticators`, one function per contributor, asked in contributor order (plugin name: an order with no meaning, so
// an app needing precedence between credentials contributes one authenticator that decides); the first principal
// returned wins, a throwing one is reported and skipped.

import type { Context } from "../../context/index.ts";
import type { Principal } from "../../next/data/index.ts";
import { defineRegistry, type RegistryTable } from "../../next/registries/index.ts";
import type { HttpRequest } from "./request.ts";

/** Who `request` is, or `undefined` (anonymous here, maybe another authenticator knows). */
export type Authenticator = (
	request: HttpRequest,
	context: Context,
) => Principal | undefined | Promise<Principal | undefined>;

/** An authenticator with its plugin, as the component asks it. */
export type AuthenticatorEntry = { readonly plugin: string; readonly authenticate: Authenticator };

/** The registry of authenticators (served by `http.facet`). */
export const Authenticators = defineRegistry<Authenticator, readonly AuthenticatorEntry[]>(
	"chord.http.authenticators",
	{
		version: 1,
	},
);

/** Composes `Authenticators`: every contribution in contributor order. */
export function composeAuthenticators(table: RegistryTable<Authenticator>): readonly AuthenticatorEntry[] {
	return table.map(({ plugin, value }) => ({ plugin, authenticate: value }));
}

/**
 * The principal of `request`: the first one an authenticator returns, in order; one that throws is reported through
 * `failed` and skipped; none: `undefined` (anonymous). Once `context` is aborted no further authenticator starts.
 */
export async function authenticate(
	authenticators: readonly AuthenticatorEntry[],
	request: HttpRequest,
	failed: (plugin: string, error: unknown) => void,
	context: Context,
): Promise<Principal | undefined> {
	for (const { plugin, authenticate } of authenticators) {
		// A request gone or sealed starts no new work (Sol's second recheck C).
		if (context.abortSignal?.aborted) return undefined;
		try {
			const principal = await authenticate(request, context);
			if (principal !== undefined) return principal;
		} catch (error) {
			failed(plugin, error);
		}
	}
	return undefined;
}
