import { dataDirectory } from "../src/runtime/local-owner.ts";
import { mintOwnerLink, ownerOrigin } from "../src/runtime/owner-link.ts";

const args = process.argv.slice(2);
try {
	if (args.length > 1) throw new Error("Usage: npm run owner-link [base-url]");
	const base = ownerOrigin(args[0] ?? process.env.P2_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8788}`);
	const port = Number(process.env.PORT ?? 8788);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
	// Direct loopback, signed in as the local owner with the private data directory's key (the server's user only).
	const link = await mintOwnerLink(new URL(`http://127.0.0.1:${port}`), dataDirectory(), base);
	// This command intentionally emits the private invitation to the invoking user's terminal only.
	console.log(link.href);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Cannot mint an owner link");
	process.exitCode = 1;
}
