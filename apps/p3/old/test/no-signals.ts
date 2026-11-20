// A preload (`node --import`) that takes signals away from a `p3` command: `process.kill` with a signal throws. A
// `stop` run with it can only stop a server by asking it over HTTP (`commands.ts`).

process.kill = (pid: number, signal?: string | number): true => {
	throw new Error(`p3 test: no signal for ${pid} (${signal ?? "SIGTERM"})`);
};
