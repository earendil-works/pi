// Logins made by trusted server code (a deployment's own, a key found in the Pi's environment, a test's faux login):
// the credential is held as a finished sign-in of the server and the login made with it through the things store, as
// a person's create step would. No caller is checked: only server code reaches these objects. `/v1/server` exports
// `makeLogin`, `setCredential` and `ensureLogin`.

import { type Ctx, callerKey, type P3Principal } from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import type { Source } from "../things/contract.ts";
import { LoginStore } from "./contract.server.ts";
import { LoginKind } from "./contract.ts";
import { SignIns } from "./sign-in.ts";

/**
 * What a login made by server code is: its name, where it is linked (`ensureLogin`: Pi when left out), who made it,
 * its provider and credential.
 */
export type ServerLogin = {
	readonly name: string;
	readonly workspace: string;
	readonly by: Source;
	readonly provider: string;
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
	const { name, workspace, by, provider, credential } = login;
	const flows = await ctx.get(SignIns, { owner: ownerOf(by) });
	const attempt = await flows.hold({ provider, credential }, ctx);
	const things = await ctx.get(ThingsStore, {});
	return things.create({ kind: LoginKind.name, name, workspace, by, input: { attempt } }, ctx);
}

/** Replaces login `thing`'s credential, as trusted server code (a test's new script; a key changed). */
export async function setCredential(
	thing: string,
	login: Pick<ServerLogin, "provider" | "credential">,
	ctx: Ctx<P3Principal>,
): Promise<void> {
	await (await ctx.get(LoginStore, {})).save({ thing, provider: login.provider, credential: login.credential }, ctx);
}

/**
 * Makes login `login` (in Pi when `workspace` is left out) unless a login of that name is linked there already, which
 * it leaves as it is (its credential may have been refreshed since: a rotated token replaced by an older one would be
 * refused); answers its thing id. For server code that runs at every start (a deployment's login).
 */
export async function ensureLogin(
	login: Omit<ServerLogin, "workspace"> & { readonly workspace?: string },
	ctx: Ctx<P3Principal>,
): Promise<string> {
	const things = await ctx.get(ThingsStore, {});
	const workspace =
		login.workspace ?? (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace;
	// A workspace holds few logins: its links are read whole, page by page.
	for (let page = await things.links.here.page({ workspace }, 100, ctx); ; ) {
		for (const { thing, of } of page.items) {
			if (of !== LoginKind.name) continue;
			const [row] = (await things.things.one.page({ thing }, 1, ctx)).items;
			if (row?.name === login.name) return thing;
		}
		if (page.next === undefined) break;
		page = await things.links.here.page({ workspace }, 100, ctx, { after: page.next });
	}
	return makeLogin({ ...login, workspace }, ctx);
}
