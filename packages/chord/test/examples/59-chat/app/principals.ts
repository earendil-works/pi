// The chat's principals: its server and channel workers, the kit's owner, and users who picked a name.

/** Who someone is in the chat. */
export type ChatPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly channel: string }
	| { readonly kind: "owner" }
	| { readonly kind: "user"; readonly id: string; readonly name: string };
