// Exit normally after handing a job to its independent supervisor.
import { JobManager } from "../../src/core/jobs/manager.ts";

const manager = new JobManager(process.argv[2]);
const job = await manager.start(process.argv[3], process.argv[2], {
	shell: { shell: process.execPath, args: ["--eval"] },
	env: { ...process.env, PRIVATE_JOB_ENV: "not-persisted-secret" },
});
console.log(job.id);
