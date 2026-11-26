import { type ClientIdentity, PI_ATTRIBUTION } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";

/**
 * How pi's requests identify it to providers: a detailed `User-Agent` with pi's version, and attribution to pi as a
 * CLI agent.
 */
export function getClientIdentity(): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: PI_ATTRIBUTION,
	};
}
