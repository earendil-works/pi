// The todo app's principals: its server and list workers, the kit's owner, and the users who signed in with a name.

/** Who someone is in the todo app. */
export type TodoPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly list: string }
	| { readonly kind: "owner" }
	| { readonly kind: "user"; readonly id: string; readonly name: string };
