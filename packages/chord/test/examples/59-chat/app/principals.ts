// The chat's principals: its server and channel workers, and its users: the owner (`principal.owner`) and those who
// picked a name.

/** Who someone is in the chat. */
export type ChatPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly channel: string }
	| { readonly kind: "user"; readonly id: string; readonly name: string };
