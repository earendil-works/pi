// The todo app's principals: its server and list workers, the kit's owner, and the users who signed in with a name.

/** Who someone is in the todo app. */
export type TodoPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly list: string }
	| { readonly kind: "owner" }
	| { readonly kind: "user"; readonly id: string; readonly name: string };

/** The names the telemetry records, by principal: a principal crossing a link is one object per link, made once. */
const recorded = new WeakMap<TodoPrincipal, Readonly<Record<string, string>>>();

/**
 * Who a span was for, as the app's telemetry records it (the hosts' `principalAttributes`): a short principal key, and
 * a user's name, which the owner's trace viewer shows. Cheap and synchronous, as Chord calls it per recorded span; the
 * cache is the hook's own.
 */
export function principalAttributes(principal: TodoPrincipal): Readonly<Record<string, string>> {
	let attributes = recorded.get(principal);
	if (attributes === undefined) {
		attributes =
			principal.kind === "user"
				? { "chord.principal": `user:${principal.id}`, "user.name": principal.name }
				: { "chord.principal": principal.kind === "worker" ? `worker:${principal.list}` : principal.kind };
		recorded.set(principal, attributes);
	}
	return attributes;
}
