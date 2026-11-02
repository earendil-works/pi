// Chord v2's web surface, the browser side (`@earendil-works/chord/next/web` once v2 has its entry point; slice 11
// §2): `startPage` in the app's web entry, and the themes it writes. The server side is `next/web/server`.

export { pageEnvironment } from "./environment.ts";
export { type PageOptions, startPage } from "./page.ts";
export { followThemes } from "./themes.ts";
