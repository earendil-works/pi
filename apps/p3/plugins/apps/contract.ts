// The apps plugin's contract: the apps a caller may enter (`AppCatalog`). An app is a plugin that owns the page below
// the top bar and its sessions; it says it exists by contributing to `Apps` (`contract.server.ts`) and gives its page
// to `AppPages` (`contract.web.ts`). `/v1` re-exports this file.

import {
	type Admission,
	type AdmitSelf,
	allow,
	arr,
	callerKey,
	deny,
	lit,
	obj,
	oneOf,
	type P3Principal,
	remote,
	Server,
	type Static,
	str,
	union,
	type Watchable,
} from "@earendil-works/p3/v1";

/** How an app shows the top bar: the full bar, or one corner button (an app for a child). */
export const AppChrome = oneOf("bar", "button");

/** An app as the page lists it. */
export const AppInfo = obj({ id: str(), title: str(), chrome: AppChrome });

/** An app as the page lists it (see `AppInfo`). */
export type AppInfo = Static<typeof AppInfo>;

/**
 * The apps the caller may enter, by title: the owner every app; a person the apps of the groups they are in. The
 * top bar's switcher lists them; an app's own objects still decide what the person gets inside it.
 */
export const AppCatalog = remote("apps.catalog", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { catalog: { state: { apps: arr(AppInfo) } } },
});

/**
 * Who the caller is in an app, as an app's own objects get it: the owner, or a person with the names of the app's
 * groups they are in (their roles). A person who may not enter the app is denied.
 */
export const AppAdmission = union([
	obj({ kind: lit("owner") }),
	obj({ kind: lit("person"), id: str(), groups: arr(str()) }),
]);

/** Who the caller is in an app (see `AppAdmission`). */
export type AppAdmission = Static<typeof AppAdmission>;

/**
 * What the apps plugin answers about a caller (`callerKey`) in an app: `none` when they may not enter it (as
 * `AppCatalog` decides), else as `AppAdmission`. Asked by the server about anyone, by workers, and by anyone else
 * about themselves only.
 */
export const AppAccess = remote("apps.access", {
	version: 1,
	params: { app: str(), caller: str() },
	hostAddress: () => Server(),
	variants: { answer: { state: { answer: union([obj({ kind: lit("none") }), AppAdmission]) } } },
});

/**
 * The admission of an app's own object (an object of the club, not of one session): `admission: AppAdmission` in its
 * contract, `admit: admitApp("club")` where it is served; its factory gets who the caller is in the app.
 */
export function admitApp(app: string) {
	return (_params: unknown, principal: P3Principal, self: AdmitSelf): Watchable<Admission<AppAdmission>> => {
		const access = self.get(AppAccess, { app, caller: callerKey(principal) });
		return self.derive([access.answer], ([answer]) =>
			answer.kind === "none" ? deny(`not in the app ${app}`) : allow(answer),
		);
	};
}
