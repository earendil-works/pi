// The tally app's principals: its server and workers, and its owner.

/** Who someone is in the tally app. */
export type TallyPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "owner" }
	| { readonly kind: "worker"; readonly tally: string };
