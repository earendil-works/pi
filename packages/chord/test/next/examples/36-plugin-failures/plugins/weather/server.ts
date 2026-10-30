// The weather plugin's server facet: its setup throws (no API key configured), so the host leaves the plugin out at
// startup and runs the others.

import { constant, defineFacet } from "@earendil-works/chord/next";
import { Weather } from "./contract.ts";

const apiKey: string | undefined = undefined;

export default defineFacet((host) => {
	if (apiKey === undefined) throw new Error("weather: no API key configured");
	host.serve(Weather, () => ({ celsius: constant(21) }));
});
