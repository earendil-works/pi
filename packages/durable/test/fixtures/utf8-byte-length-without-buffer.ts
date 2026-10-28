import { truncateHead, utf8ByteLength } from "../../src/truncate.ts";

const inputs: string[] = JSON.parse(process.argv[2] ?? "[]");

process.stdout.write(
	JSON.stringify({
		bufferAvailable: "Buffer" in globalThis,
		lengths: inputs.map((input) => utf8ByteLength(input)),
		head: truncateHead("aé🙂\nb", { maxBytes: 7, maxLines: 10 }),
	}),
);
