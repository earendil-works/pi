// The detached host reads the same validated SSH configurations as coding sessions.
// The server supplies the catalog's session.env; browsers cannot choose a machine.
export { envRevision, loadEnvs } from "../envs/config.ts";
export { sshOptions } from "../envs/remote-env.ts";
