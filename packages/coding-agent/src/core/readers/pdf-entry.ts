// Isolated PDF reader process entry.
import { serveReader } from "./entry.ts";
import { readPdf } from "./pdf.ts";

serveReader(readPdf);
