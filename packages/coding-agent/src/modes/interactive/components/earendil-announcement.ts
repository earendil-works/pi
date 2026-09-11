import * as fs from "node:fs";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { getBundledInteractiveAssetPath } from "../../../config.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const BLOG_URL = "https://mariozechner.at/posts/2026-04-08-ive-sold-out/";
const IMAGE_FILENAME = "clankolas.png";

let cachedImageBase64: string | undefined;
let attemptedImageLoad = false;

function loadImageBase64(): string | undefined {
	if (attemptedImageLoad) {
		return cachedImageBase64;
	}

	attemptedImageLoad = true;
	try {
		cachedImageBase64 = fs.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME)).toString("base64");
	} catch {
		cachedImageBase64 = undefined;
	}
	return cachedImageBase64;
}

export class EarendilAnnouncementComponent extends Container {
	private readonly title: Text;
	private readonly description: Text;
	private readonly link: Text;

	constructor() {
		super();

		this.title = new Text("", 1, 0);
		this.description = new Text("", 1, 0);
		this.link = new Text("", 1, 0);

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(this.title);
		this.addChild(new Spacer(1));
		this.addChild(this.description);
		this.addChild(this.link);
		this.addChild(new Spacer(1));

		const imageBase64 = loadImageBase64();
		if (imageBase64) {
			this.addChild(
				new Image(
					imageBase64,
					"image/png",
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			this.addChild(new Spacer(1));
		}

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.refreshText();
	}

	override invalidate(): void {
		super.invalidate();
		this.refreshText();
	}

	private refreshText(): void {
		this.title.setText(theme.bold(theme.fg("accent", "pi has joined Earendil")));
		this.description.setText(theme.fg("muted", "Read the blog post:"));
		this.link.setText(theme.fg("mdLink", BLOG_URL));
	}
}
