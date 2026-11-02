// A small npm package (local, so the example needs no network): a plugin lists it in its `dependencies`, and the build
// inlines it into the plugin's script.

export function greet(name) {
	return `hello, ${name}`;
}
