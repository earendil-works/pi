// A Worker whose Durable Object runs codemode the way an agent session would: tools run here, in the
// session object, and scripts run in the separately deployed pi-codemode-sandbox Worker.
//
//   curl -X POST http://localhost:8787 --data 'const n = await tools.count({ add: 2 }); text("n=" + n); return n'
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
// The portable entry has no QuickJS module: the WebAssembly lives only in the sandbox Worker.
import { type CodemodeTool, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { DurableObject } from "cloudflare:workers";

interface Env {
	SESSION: DurableObjectNamespace<Session>;
	CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

export class Session extends DurableObject<Env> {
	private counter = 0;

	async runCodemode(code: string) {
		const tools: CodemodeTool[] = [
			{
				name: "count",
				description: "Adds to a counter kept in the session and returns the new value",
				execute: (args) => {
					this.counter += (args as { add: number }).add;
					return this.counter;
				},
			},
		];
		// Before: new CodemodeSandbox({ tools, timeoutMs: 60_000 })
		const sandbox = new RemoteCodemodeSandbox({
			tools,
			timeoutMs: 60_000,
			// One sandbox instance per session keeps a session's scripts together and apart from others.
			remote: () => this.env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString()),
		});
		try {
			return await sandbox.execute(code);
		} finally {
			await sandbox.close();
		}
	}
}

export default {
	async fetch(request, env) {
		if (request.method !== "POST") return new Response("POST a script\n", { status: 405 });
		const result = await env.SESSION.getByName("demo").runCodemode(await request.text());
		return Response.json(result);
	},
} satisfies ExportedHandler<Env>;
