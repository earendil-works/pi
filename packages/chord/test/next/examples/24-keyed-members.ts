// Keyed state members: a `local` contract exposes a keyed document set as one member, `keyed(schema)`. A consumer on
// the same host pins one key with `ref.member.at(key)` in its factory (a watchable, part of its own hydration), or
// reads and watches any key with `ref.member.get/watch(key, ctx)`. One source per key: consumers share it.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/24-keyed-members.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { keyed, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";

const context = BACKGROUND_CONTEXT;

const Profile = obj({ name: str(), status: str() });

const Profiles = defineState("profiles", {
	schema: Profile,
	version: 1,
	initial: () => ({ name: "", status: "offline" }),
	keyed: true,
});

// The directory: every user's profile, one keyed member.
const Directory = local("example.directory", {
	version: 1,
	params: {},
	members: { profiles: keyed(Profile), set: method(obj({ user: str(), name: str(), status: str() })) },
});

// A badge per user: its own object, showing one profile.
const Badge = local("example.badge", { version: 1, params: { user: str() }, members: { label: str() } });

const facet = defineFacet((host) => {
	host.serve(Directory, (_, self) => {
		const profiles = self.state(Profiles);
		return {
			// The keyed handle is the member as it is.
			profiles,
			set: async ({ user, name, status }, ctx) => {
				await profiles.change(user, (draft) => Object.assign(draft, { name, status }), ctx);
				return null;
			},
		};
	});
	host.serve(Badge, ({ user }, self) => {
		// Pinned for this attempt; the badge goes live once the profile is loaded.
		const profile = self.get(Directory, {}).profiles.at(user);
		return { label: self.derive([profile], ([p]) => `${p.name || user} (${p.status})`) };
	});
});

const host = createHost({ onError: (error) => console.error("background error:", error) });
await host.load([{ name: "@example/directory", facet }], context);
const directory = await host.get(Directory, {}, context);
await directory.set({ user: "ana", name: "Ana", status: "online" }, context);

const badge = await host.get(Badge, { user: "ana" }, context);
console.log("badge:", badge.label.value);
await directory.set({ user: "ana", name: "Ana", status: "away" }, context);
console.log("badge after a change:", badge.label.value);
// Any key, read where it is needed.
console.log("ref.profiles.get(bo):", await directory.profiles.get("bo", context));

badge.release();
await host.close(context);
