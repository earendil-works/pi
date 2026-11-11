import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadToolDefinition, type ReadToolInput } from "../src/core/tools/read.ts";

const directory = mkdtempSync(join(tmpdir(), "pi-document-test-"));
const databasePath = join(directory, "data.db");
const pdfPath = join(directory, "report.pdf");
const tool = createReadToolDefinition(directory);
const read = (input: ReadToolInput, signal?: AbortSignal) =>
	tool.execute("read", input, signal, undefined, undefined as never);
let baseUrl: string;
const article =
	'<html><head><title>Invoice reference</title></head><body><nav>UNRELATED NAVIGATION</nav><main><h1>Invoice guide</h1><p>Invoice number 42. This paragraph explains invoice totals and the payment process, with useful information that must remain in the extracted document.</p><p>Read <a href="/reference">reference details</a>.</p><pre><code>const answer = 42;</code></pre><table><tr><th>Item</th><th>Total</th></tr><tr><td>Book</td><td>73</td></tr></table></main><footer>UNRELATED FOOTER</footer></body></html>';
const server = createServer((request, response) => {
	if (request.url === "/redirect") {
		response.writeHead(302, { Location: "/article" });
		response.end();
		return;
	}
	if (request.url === "/bad-redirect") {
		response.writeHead(302, { Location: "file:///etc/passwd" });
		response.end();
		return;
	}
	if (request.url === "/pdf") {
		response.writeHead(200, { "Content-Type": "application/pdf" });
		response.end(readFileSync(pdfPath));
		return;
	}
	if (request.url === "/markdown") {
		response.writeHead(200, { "Content-Type": "text/markdown" });
		response.end("# Native markdown\n\n**Original formatting**");
		return;
	}
	response.writeHead(200, { "Content-Type": "text/html" });
	response.end(
		request.url === "/shell"
			? '<html><body><main>Loading...</main><script>document.querySelector("main").textContent="JS RAN"</script></body></html>'
			: request.url === "/login"
				? '<html><body><main><h1>Account</h1><form><input type="password"></form><p>Sign in to see private account details.</p></main></body></html>'
				: article,
	);
});

beforeAll(async () => {
	writeFileSync(pdfPath, makePdf());
	const database = new DatabaseSync(databasePath);
	database.exec(
		"CREATE TABLE events(id INTEGER PRIMARY KEY, kind TEXT, payload BLOB); INSERT INTO events VALUES(1,'one',x'00ff'),(2,'two',NULL),(9007199254740993,'large',NULL); CREATE TABLE \"odd\"\"table\"(value TEXT); INSERT INTO \"odd\"\"table\" VALUES('quoted identifier')",
	);
	database.close();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test HTTP address");
	baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(directory, { recursive: true, force: true });
});

describe("document reads", () => {
	it("selects and labels PDF pages, reports textless pages, and rejects invalid ranges", async () => {
		const result = await read({ path: pdfPath, pages: "2" });
		expect(result.structuredContent).toContain("Beta total 73");
		expect(result.structuredContent).not.toContain("Alpha invoice 42");
		expect(result.details?.source).toMatchObject({ kind: "pdf", pageCount: 3, pages: [2] });
		const empty = await read({ path: pdfPath, pages: "3" });
		expect(empty.details?.status).toBe("partial");
		expect(empty.structuredContent).toContain("No extractable text");
		for (const pages of ["0", "4", "2-1", "1-999999999", "banana"])
			await expect(read({ path: pdfPath, pages })).rejects.toThrow();
		for (const range of [{ offset: 0 }, { offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: 1.5 }])
			await expect(read({ path: pdfPath, ...range })).rejects.toThrow();
	});

	it("returns every selected PDF image to model and structured consumers with distinct page pixels", async () => {
		const result = await read({ path: pdfPath, pages: "1-2", format: "images" });
		const images = result.content.filter((block) => block.type === "image");
		expect(images.map((image) => image.mimeType)).toEqual(["image/png", "image/png"]);
		const blue = PNG.sync.read(Buffer.from(images[0].data, "base64"));
		const red = PNG.sync.read(Buffer.from(images[1].data, "base64"));
		expect([...blue.data.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
		expect([...red.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
		expect(result.structuredContent).toMatchObject({
			type: "document",
			images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })),
		});
	});

	it("extracts redirected HTML with absolute links, code, tables, and no navigation", async () => {
		const result = await read({ path: `${baseUrl}/redirect` });
		expect(result.structuredContent).toContain(`[reference details](${baseUrl}/reference)`);
		expect(result.structuredContent).toContain("const answer = 42;");
		expect(result.structuredContent).toContain("| Book | 73 |");
		expect(result.structuredContent).not.toMatch(/UNRELATED NAVIGATION|UNRELATED FOOTER/);
		expect(result.details?.source).toMatchObject({ kind: "web", finalUrl: `${baseUrl}/article` });
		const plain = await read({ path: `${baseUrl}/article`, format: "text" });
		expect(plain.structuredContent).toContain("Invoice guide\n");
		expect(plain.structuredContent).not.toContain("## Invoice guide");
	});

	it("uses negotiated markdown directly and reads PDF URLs through the PDF backend", async () => {
		expect((await read({ path: `${baseUrl}/markdown` })).structuredContent).toContain("**Original formatting**");
		const result = await read({ path: `${baseUrl}/pdf`, pages: "2" });
		expect(result.structuredContent).toContain("Beta total 73");
		expect(result.details?.source).toMatchObject({ kind: "pdf", finalUrl: `${baseUrl}/pdf` });
		await expect(read({ path: `${baseUrl}/bad-redirect` })).rejects.toThrow("HTTP or HTTPS");
	});

	it("does not silently run JavaScript or represent login content as complete", async () => {
		const shell = await read({ path: `${baseUrl}/shell` });
		expect(shell.isError).toBe(true);
		expect(shell.structuredContent).not.toContain("JS RAN");
		expect(shell.structuredContent).toContain("No automatic browser fallback");
		const login = await read({ path: `${baseUrl}/login` });
		expect(login.details?.status).toBe("partial");
		expect(login.structuredContent).toContain("login form");
		const unavailable = createReadToolDefinition(directory, {
			getBrowserExecutablePath: () => join(directory, "missing-chromium"),
		});
		await expect(
			unavailable.execute(
				"read",
				{ path: `${baseUrl}/article`, strategy: "browser" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("missing-chromium");
	});

	it("browses schema and row pages without losing integer precision, blob bytes, or quoted names", async () => {
		expect((await read({ path: databasePath })).structuredContent).toContain("CREATE TABLE events");
		const page = await read({ path: databasePath, table: "events", rowLimit: 2 });
		expect(page.details?.source).toMatchObject({ kind: "sqlite", nextRowOffset: 2 });
		expect(JSON.parse(String(page.structuredContent))).toMatchObject({
			rows: [
				{ id: 1, kind: "one", payload: { type: "blob", base64: "AP8=" } },
				{ id: 2, kind: "two", payload: null },
			],
		});
		const next = await read({ path: databasePath, table: "events", rowOffset: 2 });
		expect(JSON.parse(String(next.structuredContent))).toMatchObject({
			rows: [{ id: "9007199254740993", kind: "large" }],
		});
		expect(next.details?.source).not.toHaveProperty("nextRowOffset");
		expect((await read({ path: databasePath, table: 'odd"table' })).structuredContent).toContain("quoted identifier");
		expect(
			JSON.parse(
				String(
					(
						await read({
							path: databasePath,
							query: "SELECT kind FROM events WHERE id = ? AND ?",
							params: [2, true],
						})
					).structuredContent,
				),
			),
		).toMatchObject({ rows: [{ kind: "two" }] });
	});

	it("rejects writes, attachment injection, extra statements, extensions, and writable pragmas without changing the database", async () => {
		const original = readFileSync(databasePath);
		const attached = join(directory, "forbidden.db");
		for (const query of [
			"DELETE FROM events RETURNING *",
			"SELECT 1; DELETE FROM events",
			`SELECT 1); ATTACH DATABASE '${attached}' AS other; --`,
			"SELECT load_extension('/tmp/no-extension')",
			"SELECT * FROM pragma_journal_mode('wal')",
		])
			await expect(read({ path: databasePath, query })).rejects.toThrow();
		expect(readFileSync(databasePath)).toEqual(original);
		expect(existsSync(attached)).toBe(false);
		const missing = join(directory, "missing.db");
		await expect(read({ path: missing, query: "SELECT 1" })).rejects.toThrow();
		expect(existsSync(missing)).toBe(false);
	});

	it("does not escape custom filesystem adapters into host files or network access", async () => {
		const remote = createReadToolDefinition(directory, {
			operations: { access: async () => {}, readFile: async () => Buffer.alloc(0) },
		});
		await expect(
			remote.execute("read", { path: pdfPath }, undefined, undefined, undefined as never),
		).rejects.toThrow();
		await expect(
			remote.execute("read", { path: databasePath, table: "events" }, undefined, undefined, undefined as never),
		).rejects.toThrow("local filesystem");
		await expect(
			remote.execute("read", { path: `${baseUrl}/article` }, undefined, undefined, undefined as never),
		).rejects.toThrow("network routing");
		const remotePdf = createReadToolDefinition(directory, {
			operations: { access: async () => {}, readFile: async () => readFileSync(pdfPath) },
		});
		expect(
			(
				await remotePdf.execute(
					"read",
					{ path: "remote-only.pdf", pages: "2" },
					undefined,
					undefined,
					undefined as never,
				)
			).structuredContent,
		).toContain("Beta total 73");
	});

	it("cancels while a remote PDF adapter is still reading its bytes", async () => {
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		const remote = createReadToolDefinition(directory, {
			operations: {
				access: async () => {},
				readFile: () => {
					started.resolve();
					return new Promise<Buffer>(() => {});
				},
			},
		});
		const pending = remote.execute("read", { path: "remote.pdf" }, controller.signal, undefined, undefined as never);
		await started.promise;
		controller.abort();
		await expect(pending).rejects.toThrow(/aborted/i);
	});

	it("cancels a nonterminating SQLite query without blocking the host event loop", async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 300);
		try {
			await expect(
				read(
					{
						path: databasePath,
						query: "WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT sum(n) FROM x",
					},
					controller.signal,
				),
			).rejects.toThrow("aborted");
		} finally {
			clearTimeout(timer);
		}
		expect(
			JSON.parse(
				String(
					(await read({ path: databasePath, query: "SELECT count(*) AS total FROM events" })).structuredContent,
				),
			),
		).toMatchObject({ rows: [{ total: 3 }] });
	});
});

function makePdf(): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (const [index, text] of ["Alpha invoice 42", "Beta total 73", ""].entries()) {
		const stream = `${index === 0 ? "0 0 1" : "1 0 0"} rg 0 0 612 792 re f\n1 1 1 rg BT /F1 24 Tf 40 700 Td (${text}) Tj ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
			`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		);
	}
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body);
}
