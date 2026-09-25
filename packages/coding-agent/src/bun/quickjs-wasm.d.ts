// Imported by runtime-setup.ts. Bun's default loader for .wasm evaluates to the file's path.
declare module "quickjs-wasi/quickjs.wasm" {
	const path: string;
	export default path;
}
