// The board app's principals: its server, its owner, and users.

/** Who someone is in the board app. */
export type BoardPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "owner" }
	| { readonly kind: "user"; readonly id: string; readonly name: string };
