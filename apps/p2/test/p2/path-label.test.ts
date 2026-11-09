// Home-directory abbreviations used by the sidebar and other web directory labels.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { locationLabel, shortPath } from "../../src/web/path-label.ts";

describe("compact directory labels", () => {
	it("abbreviates macOS, Linux, root and Termux homes without changing the rest of the path", () => {
		for (const home of ["/Users/armin", "/home/armin", "/root", "/data/data/com.termux/files/home"]) {
			assert.equal(shortPath(home), "~", home);
			assert.equal(shortPath(`${home}/`), "~/", home);
			assert.equal(shortPath(`${home}/Development/pi-mono`), "~/Development/pi-mono", home);
		}
	});

	it("leaves other directories and already abbreviated paths unchanged", () => {
		for (const path of [
			"/",
			"/Users",
			"/home",
			"/rooted/project",
			"/data/data/com.termux/files/homeless/project",
			"/work/Users/armin/project",
			"/work/home/armin/project",
			"/work/project",
			"~/project",
			"project",
			"",
			"C:\\Users\\armin\\project",
		])
			assert.equal(shortPath(path), path);
	});

	it("uses compact paths for both local and remote sidebar locations", () => {
		assert.equal(locationLabel(null, "/Users/armin/Development/pi-mono"), "~/Development/pi-mono");
		assert.equal(locationLabel(undefined, "/home/armin/project"), "~/project");
		assert.equal(locationLabel("gpu", "/home/armin/project"), "gpu:~/project");
		assert.equal(locationLabel("mac", "/Users/armin/project"), "mac:~/project");
		assert.equal(locationLabel("sandbox", "/root/project"), "sandbox:~/project");
		assert.equal(locationLabel("gpu", "/work/project"), "gpu:/work/project");
	});
});
