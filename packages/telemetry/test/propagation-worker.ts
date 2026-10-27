import { InMemoryTelemetryContext, type TelemetryCarrier } from "../src/index.ts";

const telemetry = new InMemoryTelemetryContext();
const carrier = JSON.parse(process.argv[2] ?? "{}") as TelemetryCarrier;
await telemetry.extract(carrier).startSpan({ name: "remote" }, () => {});
process.stdout.write(JSON.stringify(telemetry.getSpans()));
