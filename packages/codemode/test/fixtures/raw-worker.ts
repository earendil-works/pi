/**
 * Stands in for the real worker in host tests: posts the JSON message (or array of messages) passed
 * as the script source, so tests can send the host payloads the real prelude never produces.
 */
import { parentPort, workerData } from "node:worker_threads";

const messages: unknown = JSON.parse((workerData as { code: string }).code);
for (const message of Array.isArray(messages) ? messages : [messages]) parentPort?.postMessage(message);
