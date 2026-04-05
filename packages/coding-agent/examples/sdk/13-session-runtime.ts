/**
 * Session runtime
 *
 * Use AgentSessionRuntime when you need to replace the active AgentSession,
 * for example for new-session, resume, fork, or import flows.
 *
 * The important pattern is: after the runtime replaces the active session,
 * rebind any session-local subscriptions and extension bindings to `runtime.session`.
 */

import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	const services = await createAgentSessionServices({ cwd });
	return {
		...(await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		})),
		services,
		diagnostics: services.diagnostics,
	};
};
const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	sessionManager: SessionManager.create(process.cwd()),
});

let unsubscribe: (() => void) | undefined;

async function bindSession() {
	unsubscribe?.();
	const session = runtime.session;
	await session.bindExtensions({});
	unsubscribe = session.subscribe((event) => {
		if (event.type === "queue_update") {
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
	return session;
}

let session = await bindSession();
const originalSessionFile = session.sessionFile;
console.log("Initial session:", originalSessionFile);

await runtime.newSession();
session = await bindSession();
console.log("After newSession():", session.sessionFile);

if (originalSessionFile) {
	await runtime.switchSession(originalSessionFile);
	session = await bindSession();
	console.log("After switchSession():", session.sessionFile);
}

unsubscribe?.();
await runtime.dispose();
