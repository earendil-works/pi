// A session's uploads and download snapshots on its worker, in the session's `Files`: uploads stream in from the
// server's `POST /upload` (`SessionFiles`), a message's attachments are materialized where its conversation works
// (`Attachments`), snapshots are found and read for `GET /download`, and each change of a space is pushed to the
// server's mirror of the session's file summaries (`FilesMirror`).
import { join, posix } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { defineFacet, expectVariant, forbidden } from "@p2/app/v1";
import {
	DOWNLOADS,
	displayName,
	durableContext,
	Files,
	findDownload,
	readWhole,
	remotePaths,
	UPLOADS,
	value,
} from "@p2/app/v1/node";
import { conversationEnvironment, harnessOf, isLocalEnvironment, workerOf } from "@p2/app/v1/worker";
import { type Attachment, Attachments, FileSummaries, FilesMirror, SessionFiles } from "./contract.ts";
import { imageType, MAX_UPLOAD_BYTES, materializeLocally, uploadPath } from "./uploads.ts";

export default defineFacet((host) => {
	host.serve(FilesMirror, (_params, self) => {
		const files = self.get(Files, {});
		return {
			push: async (space, ctx) => {
				const summary = await files.summary.get(space, ctx);
				await expectVariant(await ctx.get(FileSummaries, {}), "worker").push(
					{ space, summary: summary ?? { files: 0, versions: 0, bytes: 0, newest: [] } },
					ctx,
				);
				return null;
			},
		};
	});

	host.serve(Attachments, (_params, self) => {
		const worker = workerOf(self);
		const harness = harnessOf(self);
		const files = self.get(Files, {});
		// Only uploads of this session are accepted. Copies complete before input admission; a failure never falls back.
		return {
			resolve: async ({ ids, conversation }, ctx) => {
				if (!ids.length) return [];
				const session = worker().init.values.session.id;
				const found = await Promise.all(
					ids.map(async (id) => {
						const file = await files.byKey({ space: UPLOADS, key: id }, ctx);
						if (file === null) throw new Error("Unknown attachment");
						return { id, file };
					}),
				);
				// This machine's copy first: the model reads it here, and inline images come from it on any machine.
				const local = join(worker().init.dataDir, "uploads", session);
				const attachments: Attachment[] = [];
				for (const { id, file } of found) {
					const path = await materializeLocally(files, file, local, ctx);
					const name = displayName(file);
					const mimeType = imageType(name);
					attachments.push({ id, name, path, size: file.size, ...(mimeType ? { mimeType } : {}) });
				}
				// Another machine (the conversation's: a subagent's own location may be elsewhere than the session's) gets
				// its own copy. Decided from the environment, never from a location's name.
				const context = durableContext(ctx);
				const { env } = await conversationEnvironment(
					harness().environments,
					conversation as ConversationId,
					context,
				);
				if (isLocalEnvironment(env)) return attachments;
				const paths = env instanceof RemoteExecutionEnv ? await remotePaths(env.connection) : posix;
				const directory = paths.join(value(await env.absolutePath("~/.pi/p2/uploads", context)), session);
				value(await env.createDir(directory, { recursive: true }, context));
				return Promise.all(
					attachments.map(async (attachment, index) => {
						const path = paths.join(directory, found[index]!.file.path);
						value(await env.writeFile(path, await readWhole(files, found[index]!.file, ctx), context));
						return { ...attachment, localPath: attachment.path, path };
					}),
				);
			},
		};
	});

	host.serve(SessionFiles, (_params, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const files = self.get(Files, {});
		const mirror = self.get(FilesMirror, {});
		return {
			variant: "server",
			members: {
				begin: async ({ space, name, source }, ctx) => {
					const id = crypto.randomUUID();
					const path = uploadPath(id, name);
					const mime = imageType(path) ?? "application/octet-stream";
					const write = { space, path, mime, source, key: id, meta: { name: path.slice(id.length + 1) } };
					const begun = await files.begin(write, ctx);
					// A fresh key: always a new upload.
					if (begun.kind !== "upload") throw new Error("File exists already");
					return { id, upload: begun.upload };
				},
				append: async ({ upload, offset, bytes }, ctx) => {
					if (offset + bytes.length > MAX_UPLOAD_BYTES) throw new Error("File too large");
					await files.append({ upload, offset, bytes }, ctx);
					return null;
				},
				finish: async (upload, ctx) => {
					const file = await files.finish(upload, ctx);
					await mirror.push(file.space, ctx);
					// Begun as `<id>-<name>` with its ID as the key.
					const id = file.key!;
					const name = displayName(file);
					const mimeType = imageType(name);
					return { id, name, size: file.size, ...(mimeType ? { mimeType } : {}) };
				},
				cancel: async (upload, ctx) => {
					await files.cancel(upload, ctx);
					return null;
				},
				download: async (id, ctx) => {
					const found = await findDownload(files, id, ctx);
					return found === undefined ? null : { file: found.file.id, name: found.name, size: found.file.size };
				},
				read: async ({ file, offset, length }, ctx) => {
					const info = await files.file(file, ctx);
					// Only what the routes serve: download snapshots.
					if (info === null || info.space !== DOWNLOADS) throw new Error("File not found");
					return files.read({ id: file, offset, length }, ctx);
				},
			},
		};
	});
});
