import { formatUserAgent } from "@earendil-works/pi-ai";
import { isWSL2 } from "./wsl.ts";

/**
 * pi's `User-Agent` for its own network requests (install/update reports, version checks); the same detailed form
 * pi-ai sends to providers, except that WSL2 reports its platform as `linux/wsl2`.
 */
export function getPiUserAgent(version: string, wsl2: boolean = isWSL2()): string {
	const userAgent = formatUserAgent({ userAgent: "detailed", version });
	return wsl2 ? userAgent.replace(` (${process.platform};`, " (linux/wsl2;") : userAgent;
}
