import { defineFacet } from "@p2/app/v1";
import { ProxyMarker } from "./contract.ts";

/** Marker classification lives in the host's origin checks, including when this facet is not loaded.
 * This facet deliberately contributes NO authenticators. A proxy header can only remove device trust. */
export default defineFacet((host) => {
	host.serve(ProxyMarker, () => ({}));
});
