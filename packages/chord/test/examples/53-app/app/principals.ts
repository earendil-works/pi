// The notes app's principals: its server and workers, the kit's owner, and the users its plugins may sign in.

/** Who someone is in the notes app. */
export type NotesPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "owner" }
	| { readonly kind: "worker"; readonly project: string }
	| { readonly kind: "user"; readonly id: string; readonly name: string };
