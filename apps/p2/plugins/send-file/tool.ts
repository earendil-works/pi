import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Context, DownloadInfo } from "@p2/app/v1";
import { DownloadError } from "@p2/app/v1/node";

const READ_CHUNK = 1024 * 1024;

/** Saves a snapshot of `name` (`size` bytes, read in order by `next` until it gives none) into the session's files. */
export type SaveSnapshot = (
	snapshot: { readonly name: string; readonly size: number },
	next: () => Promise<Uint8Array>,
	context: Context,
) => Promise<DownloadInfo>;

/** The `send_file` tool, saving through `save` (the session's files; a declaration-only template saves nothing). */
export function createSendFileExtension(save: SaveSnapshot) {
	return defineExtension({
		name: "p2-downloads",
		tools: [
			defineTool({
				name: "send_file",
				description:
					"Offer a file for browser download. Path is relative to your cwd. Copies a private snapshot (maximum 25 MiB) and shows a Download link to all authorized viewers of this session. Downloads require a click; do not export secrets. Snapshots are retained.",
				parameters: obj(
					{
						path: str({ minLength: 1 }),
						name: opt(str({ minLength: 1 })),
					},
					{ open: true },
				),
				replay: "unsafe",
				execute: async (args, api, context) => {
					// Through the session's environment, so a remote session sends a file of its host.
					const env = api.env;
					if (!env) throw new Error("No execution environment");
					const opened = await env.openBinaryReader(args.path, undefined, context);
					if (!opened.ok) {
						throw opened.error.code === "is_directory" || opened.error.code === "invalid"
							? new DownloadError(400, "Source must be a regular file")
							: new DownloadError(400, "Could not open source file");
					}
					const reader = opened.value;
					try {
						const info = await reader.info(context);
						if (!info.ok) throw new DownloadError(400, "Could not open source file");
						let offset = 0;
						const saved = await save(
							{ name: args.name ?? info.value.name, size: info.value.size },
							async () => {
								const bytes = await reader.read(offset, READ_CHUNK, context);
								if (!bytes.ok) throw new DownloadError(400, bytes.error.message);
								offset += bytes.value.length;
								return bytes.value;
							},
							context,
						);
						return {
							output: [{ type: "text" as const, text: `Download ready: ${saved.name} (${saved.size} bytes).` }],
							details: saved,
						};
					} finally {
						await reader.close(context);
					}
				},
			}),
		],
	});
}
