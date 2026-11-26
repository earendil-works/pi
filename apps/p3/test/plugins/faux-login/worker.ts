// The faux login on a session's worker, for tests only: the faux provider whose requests a faux login of the session
// makes (its script comes with each request's auth), every request recorded with the tools it offered
// (`FauxRequests`).

import { arr, defineFacet, LoginProviders, local } from "@earendil-works/p3/v1";
import { FauxRequest, FauxRequests } from "./contract.ts";
import { scriptedProvider } from "./scripted.ts";

/** The worker's log of what the faux provider received; it contributes the provider, which records into it. */
const Log = local("faux.log", { version: 1, params: {}, members: { requests: arr(FauxRequest) } });

export default defineFacet((host) => {
	host.serve(Log, (_params, self) => {
		const log = self.writable<readonly FauxRequest[]>([]);
		self.contribute(LoginProviders, [scriptedProvider((request) => log.set([...log.value, request]))]);
		return { requests: self.derive([log], ([value]) => [...value]) };
	});
	host.serve(FauxRequests, (_params, _principal, self) => ({ requests: self.get(Log, {}).requests }));
});
