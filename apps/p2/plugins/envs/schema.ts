import { bool, int, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { literal, record } from "@p2/app/v1";

/** Browser-safe configuration shape. No credentials are kept in envs.json. */
export const ENV_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const EnvConfigSchema = obj({
	type: literal("ssh"),
	host: str({ minLength: 1, maxLength: 255 }),
	user: opt(str({ minLength: 1, maxLength: 255 })),
	port: opt(int({ minimum: 1, maximum: 65535 })),
	identityFile: opt(str({ minLength: 1, maxLength: 4096 })),
	shellPath: opt(str({ minLength: 1, maxLength: 4096 })),
	loginShell: opt(bool()),
	shellEnv: opt(record(str())),
});
export type EnvConfig = Static<typeof EnvConfigSchema>;
export type EnvsConfig = Record<string, EnvConfig>;
