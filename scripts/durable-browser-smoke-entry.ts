import * as durable from "@earendil-works/pi-durable";
import * as environment from "@earendil-works/pi-durable/env";
import * as jsonl from "@earendil-works/pi-durable/storage/jsonl";
import * as sqlite from "@earendil-works/pi-durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
