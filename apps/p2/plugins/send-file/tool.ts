import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { DownloadError, Downloads } from "@p2/app/v1/node";

const READ_CHUNK = 1024 * 1024;

export function createSendFileExtension(dataDirectory: string, sessionId: string) {
	const downloads = new Downloads(dataDirectory);
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
						const saved = await downloads.saveFrom(
							sessionId,
							args.name ?? info.value.name,
							info.value.size,
							async () => {
								const bytes = await reader.read(offset, READ_CHUNK, context);
								if (!bytes.ok) throw new DownloadError(400, bytes.error.message);
								offset += bytes.value.length;
								return bytes.value;
							},
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
