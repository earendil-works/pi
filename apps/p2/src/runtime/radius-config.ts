// This p2's Radius sign-in, `radius.json` in the data directory (0600): written by `npm run radius:login` and the
// Radius plugin's brain, read by everything that reaches Radius as this p2 or its owner (radius-client.ts).
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";

export type RadiusBrainConfig = {
	gateway: string;
	serverId: string;
	/**
	 * The brain's own Radius origin (`https://<label>.rdtun.com`), as last seen on a relayed request for its UI. Saved so
	 * forward links are known after a restart before anyone opens Pi through Radius again.
	 */
	publicOrigin?: string;
	/**
	 * This brain's page in the Radius shell (`<shell>/pi/<organization ID>/<server>`), as last seen on a relayed request
	 * for its UI; a page of the brain's UI is below it (`…/s/<session>`). People sessions are shared with by email open
	 * them there, signed in to Radius. The shell names organizations by slug when they have one and replaces this ID
	 * form, but a link people keep names the organization by ID, which a slug change leaves valid.
	 */
	shellPage?: string;
	credential: OAuthCredential;
};

export function radiusConfigPath(directory: string): string {
	return join(directory, "radius.json");
}

export async function readRadiusConfig(directory: string): Promise<RadiusBrainConfig | undefined> {
	let text: string;
	try {
		text = await readFile(radiusConfigPath(directory), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(text) as Partial<RadiusBrainConfig>;
	if (typeof value.gateway !== "string" || typeof value.serverId !== "string" || value.credential?.type !== "oauth")
		throw new Error("Invalid radius.json");
	return value as RadiusBrainConfig;
}

export async function writeRadiusConfig(directory: string, config: RadiusBrainConfig): Promise<void> {
	const path = radiusConfigPath(directory);
	await writeFile(`${path}.tmp`, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	await rename(`${path}.tmp`, path);
}
