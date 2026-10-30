// A CommonJS module of the app: given to plugins as the host package `@example/legacy`.

module.exports = {
	pad(text, width) {
		return String(text).padStart(width, ".");
	},
};
