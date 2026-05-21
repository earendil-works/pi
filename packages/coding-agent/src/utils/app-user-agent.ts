import { APP_NAME } from "../config.ts";

export function getAppUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `${APP_NAME}/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
