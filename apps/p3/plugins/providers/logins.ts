// Logins made by trusted server code (a key found in the Pi's environment, at start; a test's faux login): the
// credential is kept as a finished sign-in of the server, and the login made with it through the things store, as a
// person's create step would. No caller is checked: only server code reaches these objects.

import { type Ctx, callerKey, type P3Principal } from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import type { Source } from "../things/contract.ts";
import { LoginStore } from "./contract.server.ts";
import { LoginKind, type Method } from "./contract.ts";

/** What a login made by server code is: its name, where it is linked, who made it, its provider and credential. */
export type ServerLogin = {
	readonly name: string;
	readonly workspace: string;
	readonly by: Source;
	readonly provider: string;
	readonly method: Method;
	/** pi-ai's `Credential` of the provider. */
	readonly credential: unknown;
};

/**
 * Whose a sign-in is, as the maker of a login names it (`by`): a person's or a session's agent's `callerKey`, else
 * the server's (a plugin, a thing, a provider: server code making its own logins).
 */
export function ownerOf(by: Source): string {
	switch (by.kind) {
		case "person":
			return callerKey({ kind: "person", id: by.person, name: "" });
		case "agent":
			return callerKey({ kind: "worker", session: by.session });
		default:
			return callerKey({ kind: "server" });
	}
}

/** Makes login `login`, as trusted server code; answers its thing id. */
export async function makeLogin(login: ServerLogin, ctx: Ctx<P3Principal>): Promise<string> {
	const { name, workspace, by, provider, method, credential } = login;
	const store = await ctx.get(LoginStore, {});
	const signIn = await store.keep({ owner: ownerOf(by), provider, method, credential }, ctx);
	const things = await ctx.get(ThingsStore, {});
	return things.create({ kind: LoginKind.name, name, workspace, by, input: { signIn } }, ctx);
}

/** Replaces login `thing`'s credential, as the server (a test's new script; a key changed in the environment). */
export async function setCredential(
	thing: string,
	login: Pick<ServerLogin, "provider" | "method" | "credential">,
	ctx: Ctx<P3Principal>,
): Promise<void> {
	await (await ctx.get(LoginStore, {})).save({ thing, ...login }, ctx);
}
