import { canView, contribute, defineFacet, forbidden } from "@p2/app/v1";
import { Downloads } from "@p2/app/v1/node";
import { Extensions, workerOf } from "@p2/app/v1/worker";
import { MAX_SENT_PREVIEW, SentFiles } from "./contract.ts";
import { createSendFileExtension } from "./tool.ts";

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
		// Declare the native schema now; resolve the directory and session only at execution, after the hold is live.
		const template = createSendFileExtension("", "");
		self.contribute(Extensions, {
			[template.name]: {
				...template,
				tools: template.tools!.map((tool) => ({
					...tool,
					execute: (...args: Parameters<typeof tool.execute>) =>
						createSendFileExtension(worker().init.dataDir, worker().init.values.session.id).tools![0]!.execute(
							...args,
						),
				})),
			},
		});
	});

	host.serve(SentFiles, ({ session }, principal, self) => {
		if (!canView(principal, session)) throw forbidden("viewers only");
		const worker = workerOf(self);
		return {
			variant: "reader",
			members: {
				preview: async ({ id }) => {
					const file = await new Downloads(worker().init.dataDir).open(session, id);
					try {
						const length = Math.min(file.info.size, MAX_SENT_PREVIEW);
						const buffer = Buffer.alloc(length);
						let read = 0;
						while (read < length) {
							const { bytesRead } = await file.handle.read(buffer, read, length - read, read);
							if (!bytesRead) break;
							read += bytesRead;
						}
						const truncated = file.info.size > read;
						return {
							name: file.info.name,
							size: file.info.size,
							text: previewText(buffer.subarray(0, read), truncated),
							truncated,
						};
					} finally {
						await file.handle.close();
					}
				},
			},
		};
	});
});
