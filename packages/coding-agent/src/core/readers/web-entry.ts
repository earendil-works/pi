// Isolated HTTP extraction and optional browser process entry.
import { serveReader } from "./entry.ts";
import { readWeb } from "./web.ts";

serveReader(readWeb);
