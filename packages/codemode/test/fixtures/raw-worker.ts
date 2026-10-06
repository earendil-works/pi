/**
 * Stands in for the real worker in host tests: posts the JSON message passed as the script source,
 * so tests can send the host payloads the real prelude never produces.
 */
import { parentPort, workerData } from "node:worker_threads";

parentPort?.postMessage(JSON.parse((workerData as { code: string }).code));
