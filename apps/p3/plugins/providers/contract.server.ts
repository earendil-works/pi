// The providers plugin's contracts for server facets only: the store of the logins' credentials (`LoginStore`), a
// person's sign-ins with the credentials of finished ones (`SignIns`) and the provider types' stored model catalogs
// (`CatalogStore`); this plugin's own server code only: they check no caller. Credentials pass only between this
// plugin's objects on the server; no remote contract carries one, and no method answers one.

import {
	arr,
	bool,
	int,
	local,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	queries,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import { Source } from "../things/contract.ts";
import { Attempt, LoginDefinitions, LoginModels, ModelOverride, SignInMethod } from "./contract.ts";
import { RequestAuth } from "./kind.ts";

/**
 * A login as its store has it, without its credential: its provider, how it signs in, whether it works
 * (`signInAgain`: its provider refused it or its last refresh failed, a while ago or less), and the ids of the models
 * its account has (`null`: every model of the provider).
 */
export const LoginRow = obj({
	thing: str(),
	provider: str(),
	method: SignInMethod,
	status: oneOf("signedIn", "signInAgain"),
	models: union([arr(str()), nul()]),
});

/** A login as its store has it (see `LoginRow`). */
export type LoginRow = Static<typeof LoginRow>;

/**
 * What a refresh changes of a login: its credential (pi-ai's), the models its account has and its version (a rotation),
 * when it failed, and which server process holds the login for a refresh (`holder` `""`: none).
 */
export const LoginChange = obj({
	credential: opt(unknown()),
	models: opt(union([arr(str()), nul()])),
	version: opt(str()),
	failedAt: opt(int()),
	holder: opt(str()),
});

/** What a refresh changes of a login (see `LoginChange`). */
export type LoginChange = Static<typeof LoginChange>;

/** The logins' credentials (pi-ai's `Credential`, typed `unknown` here: an OAuth one carries its provider's fields). */
export const LoginStore = local("providers.store", {
	version: 1,
	params: {},
	members: {
		logins: queries(LoginRow, { one: obj({ thing: str() }) }),
		/** Stores new login `thing`'s credential (of `provider`); `invalid` if it has one already. */
		create: method(obj({ thing: str(), provider: str(), credential: unknown() })),
		/** Replaces login `thing`'s credential; `invalid` unless it has one, of the same `provider`. */
		replace: method(obj({ thing: str(), provider: str(), credential: unknown() })),
		/** Removes login `thing` (the login was deleted). */
		remove: method(obj({ thing: str() })),
		/**
		 * The request auth of login `thing`, its OAuth token refreshed first when it expired: one refresh at a time per
		 * login, across the store's objects too (a reload), each written over the credential it read only, kept also
		 * when its caller or the store's object went away meanwhile. A login whose refresh failed is refused at once for
		 * a while, a request waiting for that refresh too; then one request tries again, and a success clears it.
		 */
		authorize: method(obj({ thing: str() }), RequestAuth),
		/**
		 * Works the accounts of provider `provider`'s logins out again over its type's catalog as it is now (its type
		 * wrote a new one): only a provider that cuts its models by account (`filterModels`) has anything to do.
		 */
		recut: method(obj({ provider: str() })),
		/** This Pi's device id for providers that sign in a device (made once, the same ever after). */
		device: method(obj({}), str()),
		/**
		 * Writes `change` to login `thing` if its credential is still of `version`: what a refresh that outlived the
		 * store's previous object (a reload that stopped waiting for it) hands its successor.
		 */
		settle: method(obj({ thing: str(), version: str(), change: LoginChange })),
	},
});

/**
 * One person's sign-in (`owner`: their `callerKey`; the server's for its own logins) and the credentials of finished
 * ones, waiting for a login.
 */
export const SignIns = local("providers.sign-ins", {
	version: 1,
	params: { owner: str() },
	members: {
		attempt: union([Attempt, nul()]),
		start: method(obj({ provider: str(), method: SignInMethod }), str()),
		answer: method(obj({ prompt: str(), value: str() })),
		cancel: method(obj({ attempt: str() })),
		/** Holds `credential` (pi-ai's) of `provider` as a finished sign-in, for a login server code makes; its id. */
		hold: method(obj({ provider: str(), credential: unknown() }), str()),
		/** Gives the finished sign-in `attempt` to login `thing` (`invalid` if none waits: used, dropped or expired). */
		adopt: method(obj({ attempt: str(), thing: str() })),
		/**
		 * The login named `name` that `by` made in `workspace`, made now with `credential` of `provider` if there is
		 * none; one at a time for the owner, so two at once make one.
		 */
		ensure: method(obj({ name: str(), workspace: str(), by: Source, provider: str(), credential: unknown() }), str()),
	},
});

/**
 * A provider's stored model catalog, as its type last got it: its models (pi-ai's chat definitions as the catalog
 * server sends them, checked; plain data, typed `unknown` here), the catalog's Last-Modified (0: none, or no catalog
 * there), compared with pi-ai's shipped model data's date (a catalog not newer lays nothing over the shipped models,
 * whichever type wrote it), and its ETag.
 */
export const CatalogEntry = obj({ models: arr(unknown()), lastModified: num(), etag: opt(str()) });

/** A provider's stored model catalog (see `CatalogEntry`). */
export type CatalogEntry = Static<typeof CatalogEntry>;

/** A provider's stored catalog and its revision (a new one whenever its body changes), by provider id. */
export const CatalogRow = obj({ provider: str(), entry: CatalogEntry, revision: str() });

/** A provider's stored catalog, by provider id (see `CatalogRow`). */
export type CatalogRow = Static<typeof CatalogRow>;

/** When a provider's catalog was last answered (`checkedAt`) and last failed (`failedAt`; 0: never). */
export const CatalogStatus = obj({ checkedAt: num(), failedAt: num() });

/** When a provider's catalog was last answered and failed (see `CatalogStatus`). */
export type CatalogStatus = Static<typeof CatalogStatus>;

/**
 * The provider types' model catalogs, one row per provider, each written by its type's catalog (`login-catalogs.ts`):
 * its body, read live by the provider's logins, and its timing, read by the type alone.
 */
export const CatalogStore = local("providers.catalog-store", {
	version: 1,
	params: {},
	members: {
		catalogs: queries(CatalogRow, { one: obj({ provider: str() }) }),
		/** Provider `provider`'s catalog's timing (`null`: none stored). */
		status: method(obj({ provider: str() }), union([CatalogStatus, nul()])),
		/** Stores provider `provider`'s new catalog `entry`, answered at `at`: a new revision. */
		write: method(obj({ provider: str(), entry: CatalogEntry, at: num() })),
		/** Marks provider `provider`'s stored catalog answered unchanged at `at` (a 304): the body and revision stay. */
		checked: method(obj({ provider: str(), at: num() })),
		/** Marks provider `provider`'s catalog request failed at `at`: the stored body stays. */
		failed: method(obj({ provider: str(), at: num() })),
	},
});

/** A model settings thing's overrides, by its id. */
export const ModelSettingsRow = obj({ thing: str(), overrides: arr(ModelOverride) });

/** A model settings thing's overrides (see `ModelSettingsRow`). */
export type ModelSettingsRow = Static<typeof ModelSettingsRow>;

/** The model settings things' overrides (`model-settings-store.ts`), one row per thing. */
export const ModelSettingsStore = local("providers.model-settings-store", {
	version: 1,
	params: {},
	members: {
		settings: queries(ModelSettingsRow, { one: obj({ thing: str() }) }),
		/** Sets model settings thing `thing`'s overrides, replacing its earlier ones. */
		set: method(obj({ thing: str(), overrides: arr(ModelOverride) })),
		/** Removes model settings thing `thing`'s overrides (the thing was deleted); safe to run again. */
		clear: method(obj({ thing: str() })),
	},
});

/**
 * A login's account models (`login-account.ts`): its provider (id and name) and the chat models of its account, its
 * type's catalog cut to it (pi-ai's definitions, plain data, typed `unknown` here); `null` while no credential is
 * stored or no plugin offers its provider. One object per login, held by the login's object and by every
 * `SessionModels` whose agent may Use it.
 */
export const AccountModels = obj({ provider: str(), providerName: str(), models: arr(unknown()) });

/** A login's account models (see `AccountModels`). */
export type AccountModels = Static<typeof AccountModels>;

/** One login's account models, live (see `AccountModels`). */
export const LoginAccount = local("providers.login-account", {
	version: 1,
	params: { thing: str() },
	members: { account: union([AccountModels, nul()]) },
});

/**
 * A session's models, computed once for every holder of its `SessionModels` (`session-models.ts`): the picker's list
 * and the worker's, and whether they are complete (see `SessionModels`).
 */
export const SessionModelSet = local("providers.session-model-set", {
	version: 1,
	params: { session: str() },
	members: { complete: bool(), models: arr(LoginModels), catalog: arr(LoginDefinitions) },
});
