// Tests of the senders: a page's sends its spans (never its metrics) to the server's `PageTelemetry`, a worker's its
// spans and metrics to `WorkerTelemetry`; nothing is sent (or lost) while the object is not bound, a refused batch is
// given up.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind } from "../../src/contracts/index.ts";
import type { Principal } from "../../src/data/index.ts";
import { createHost } from "../../src/host/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import {
	sendPageTelemetry,
	sendWorkerTelemetry,
	type TelemetryBatch,
	TelemetryRecorder,
	telemetryIngestFacet,
} from "../../src/telemetry-ingest/index.ts";
import { testCodec, transported } from "../support.ts";

const Server = hostKind("server");

/** A server with the ingest facet (its batches collected) and a client of `principal` recording to `recorder`. */
async function sending(principal: Principal, scope: (incarnation: string) => string) {
	const batches: TelemetryBatch[] = [];
	const server = createHost({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	const facet = telemetryIngestFacet({
		target: {
			ingest: (batch) => {
				batches.push(batch);
				return batch.spans.length;
			},
		},
		admit: () => true,
		workerHost: (who) => (who.kind === "worker" ? "project|p1" : undefined),
		principalAttributes: () => ({}),
	});
	await server.load([{ name: "chord.telemetry", facet }], context);
	let incarnation = "";
	const recorder = new TelemetryRecorder(() => scope(incarnation), 100);
	const client = createHost({ telemetry: recorder, onError: () => {} });
	incarnation = client.incarnation;
	await client.load([], context);
	const connect = () => {
		const [a, b] = memoryLinkPair();
		server.accept(a, { principal, codec: testCodec() }, context);
		client.connect(b, { principal: { kind: "server" }, codec: testCodec() }, context);
		return a;
	};
	return { batches, recorder, client, connect };
}

describe("a page's sender", () => {
	it("sends its spans without metrics once bound; until then they wait in the recorder", async () => {
		const { batches, recorder, client, connect } = await sending({ kind: "owner" }, (inc) => `browser:${inc}`);
		const sender = sendPageTelemetry(client, recorder, context);
		await recorder.startSpan({ name: "page.click" }, () => {});
		recorder.metrics.counter("clicks").add(1);
		await sender.send(true);
		expect(batches).toEqual([]);
		connect();
		await transported();
		await sender.send(true);
		expect(batches.map(({ spans, metrics }) => [spans.map(({ name }) => name), metrics])).toEqual([
			[["page.click"], []],
		]);
		expect(recorder.queuedSpans).toBe(0);
		// Nothing waits: no call.
		await sender.send(true);
		expect(batches).toHaveLength(1);
		sender.stop();
	});

	it("gives a refused batch up", async () => {
		// Ids the server refuses: not under the page's prefix.
		const { batches, recorder, client, connect } = await sending({ kind: "owner" }, () => "elsewhere");
		connect();
		const sender = sendPageTelemetry(client, recorder, context);
		await transported();
		await recorder.startSpan({ name: "page.click" }, () => {});
		await sender.send(false);
		expect(batches.map(({ spans }) => spans)).toEqual([[]]);
		expect(recorder.queuedSpans).toBe(0);
	});
});

describe("a worker's sender", () => {
	it("sends spans and metrics to the worker variant", async () => {
		const { batches, recorder, client, connect } = await sending({ kind: "worker" }, () => "w");
		connect();
		const sender = sendWorkerTelemetry(client, recorder, context);
		await transported();
		await recorder.startSpan({ name: "worker.job" }, () => {});
		recorder.metrics.counter("runs").add(2);
		await sender.send(true);
		const [batch] = batches;
		expect(batch!.spans.map(({ name }) => name)).toEqual(["worker.job"]);
		expect(batch!.metrics.find(({ name }) => name === "runs")?.sum).toBe(2);
	});
});
