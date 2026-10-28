// Compiled binaries need jiti's static entry so Bun and SEA bundlers embed the
// Babel transform. The module itself remains lazy until an extension is loaded.
export { createJiti } from "jiti/static";
