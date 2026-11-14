// p3's principals (decision "The principal is identity only", 2026-11-13): who someone is, never what they may do.
// What a person may do is data of apps and plugins, read live by admissions.

/** Who someone is in p3: the owner, a person the owner let in, a session's worker, or the server. */
export type P3Principal =
	| { readonly kind: "owner" }
	| { readonly kind: "person"; readonly id: string; readonly name: string }
	| { readonly kind: "worker"; readonly session: string }
	| { readonly kind: "server" };
