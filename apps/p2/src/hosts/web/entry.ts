// The web surface's base bundle entry (server.ts `WEB_ENTRY`): starts the page. A module of its own, so importing
// main.tsx (tests, the Cloud Brain build) starts nothing.
import { startP2Page } from "./main.tsx";

startP2Page();
