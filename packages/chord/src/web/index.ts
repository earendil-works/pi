// Chord v2's web surface, the browser side (`@earendil-works/chord/web`; slice 11 §2): `startPage` in the app's web
// entry, and the themes and the language it writes. The server side is `/surfaces`.

export { pageEnvironment } from "./environment.ts";
export { followLanguage } from "./language.ts";
export { type PageOptions, startPage } from "./page.ts";
export { followThemes } from "./themes.ts";
