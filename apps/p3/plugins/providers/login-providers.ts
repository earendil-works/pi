// The providers people may sign in to, a registry on the server (their sign-in and auth) and on a session's worker
// (their requests): this plugin contributes pi-ai's built-in providers, any plugin more (a test's faux one). `/v1`
// re-exports it, for plugins of other roots.

import { defineRegistry, type TableItem } from "@earendil-works/p3/v1";
import type { Provider } from "@earendil-works/p3/v1/worker";

/**
 * The providers, by provider id, each with its plugin: a plugin contributes a list; an id contributed twice is
 * reported, the first by plugin name kept.
 */
export const LoginProviders = defineRegistry<readonly Provider[], ReadonlyMap<string, TableItem<Provider>>>(
	"providers.providers",
	{ version: 1 },
);
