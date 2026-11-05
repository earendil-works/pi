// The detached host reads the same validated SSH and sandbox configurations as coding sessions.
// The server supplies the catalog's session.env; browsers cannot choose a machine.
export { envRevision, loadEnvs } from "../envs/config.ts";
export { connectionRevision } from "../envs/connection-revision.ts";
export { envConnection, sandboxHost, sshOptions } from "../envs/remote-env.ts";
