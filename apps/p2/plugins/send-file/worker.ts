import { canView, contribute, defineFacet, forbidden } from "@p2/app/v1";
import { DOWNLOADS, DownloadError, Files, findDownload, saveDownload } from "@p2/app/v1/node";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { FilesMirror } from "../files/contract.ts";
import { MAX_SENT_PREVIEW, SentFiles } from "./contract.ts";
import { createSendFileExtension, type SaveSnapshot } from "./tool.ts";

/** Text when `bytes` is UTF-8 without NUL; a code point cut at the end of a partial read is dropped. */
export function previewText(bytes: Buffer, partial: boolean): string | null {
	if (bytes.includes(0)) return null;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let cut = 0; cut <= (partial ? 3 : 0); cut++)
		try {
			return decoder.decode(bytes.subarray(0, bytes.length - cut));
		} catch {}
	return null;
}

export default defineFacet((host) => {
	contribute(host, "p2.send-file-tools", (self) => {
		const worker = workerOf(self);
		// Snapshots go into the session's files (space `downloads`, written by the agent), in a root of the worker's own;
		// the server's mirror hears of the change before the tool answers.
		const save: SaveSnapshot = (snapshot, next, context) =>
			worker().root(async (ctx) => {
				const saved = await saveDownload(await ctx.get(Files, {}), { ...snapshot, source: "agent" }, next, ctx);
				await (await ctx.get(FilesMirror, {})).push(DOWNLOADS, ctx);
				return saved;
			}, context);
		const extension = createSendFileExtension(save);
		self.contribute(Extensions, { [extension.name]: extension });
	});

	host.serve(SentFiles, ({ session }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const files = self.get(Files, {});
		return {
			variant: "reader",
			members: {
				preview: async ({ id }, ctx) => {
					const found = await findDownload(files, id, ctx);
					if (found === undefined) throw new DownloadError(404, "File not found");
					const length = Math.min(found.file.size, MAX_SENT_PREVIEW);
					const bytes =
						length === 0 ? new Uint8Array() : await files.read({ id: found.file.id, offset: 0, length }, ctx);
					const truncated = found.file.size > bytes.length;
					return {
						name: found.name,
						size: found.file.size,
						text: previewText(Buffer.from(bytes), truncated),
						truncated,
					};
				},
			},
		};
	});
});
