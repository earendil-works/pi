// Radius is separate from model-provider login. Device-code sign-in works on a phone or over SSH.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loginToRadius, newServerId, radiusGatewayFromEnv, readRadiusConfig, writeRadiusConfig } from "./brain.ts";

const directory = process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
await mkdir(directory, { recursive: true, mode: 0o700 });
const existing = await readRadiusConfig(directory);
const gateway = radiusGatewayFromEnv();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
console.log(`Signing in to Radius at ${gateway}`);
const credential = await loginToRadius(
	gateway,
	(url, code) => console.log(`Open ${url} and enter the code ${code}`),
	controller.signal,
);
await writeRadiusConfig(directory, {
	gateway,
	serverId: existing?.gateway === gateway ? existing.serverId : newServerId(),
	...(existing?.gateway === gateway && existing.publicOrigin ? { publicOrigin: existing.publicOrigin } : {}),
	credential: { ...credential, type: "oauth" },
});
console.log("Signed in. A running p2 connects to Radius within 30 seconds.");
