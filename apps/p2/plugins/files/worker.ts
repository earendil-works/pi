import { readFile } from "node:fs/promises";
import { basename, posix } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { defineFacet } from "@p2/app/v1";
import { durableContext, remotePaths, value } from "@p2/app/v1/node";
import { conversationEnvironment, harnessOf, isLocalEnvironment, workerOf } from "@p2/app/v1/worker";
import { Attachments } from "./contract.ts";
import { Uploads } from "./uploads.ts";

export default defineFacet((host) => {
	host.serve(Attachments, (_params, self) => {
		const worker = workerOf(self);
		const harness = harnessOf(self);
		const uploads = self.open(
			async () => new Uploads(worker().init.dataDir),
			() => {},
		);
		// Only server-resolved IDs are accepted. Remote copies complete before input admission; a failure never falls back.
		return {
			resolve: async ({ ids, conversation }, ctx) => {
				const session = worker().init.values.session.id;
				const files = await uploads.value.resolve(session, ids);
				if (!files.length) return files;
				// Copied only to a remote machine: the conversation's (a subagent's own location may be elsewhere than the
				// session's). Decided from the environment, never from a location's name.
				const context = durableContext(ctx);
				const { env } = await conversationEnvironment(
					harness().environments,
					conversation as ConversationId,
					context,
				);
				if (isLocalEnvironment(env)) return files;
				const paths = env instanceof RemoteExecutionEnv ? await remotePaths(env.connection) : posix;
				const root = value(await env.absolutePath("~/.pi/p2/uploads", context));
				const directory = paths.join(root, session);
				value(await env.createDir(directory, { recursive: true }, context));
				return Promise.all(
					files.map(async (file) => {
						const path = paths.join(directory, basename(file.path));
						const bytes = await readFile(file.path);
						value(await env.writeFile(path, bytes, context));
						return { ...file, localPath: file.path, path };
					}),
				);
			},
		};
	});
});
