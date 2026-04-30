import { CopyButton } from "@mariozechner/mini-lit/dist/CopyButton.js";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { PreviewCodeToggle } from "@mariozechner/mini-lit/dist/PreviewCodeToggle.js";
import hljs from "highlight.js";
import { html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { i18n } from "../../utils/i18n.js";
import { ArtifactElement } from "./ArtifactElement.js";

@customElement("svg-artifact")
export class SvgArtifact extends ArtifactElement {
	@property() override filename = "";

	private _content = "";
	@state() private previewUrl = "";

	override get content(): string {
		return this._content;
	}
	override set content(value: string) {
		if (this._content === value) {
			return;
		}
		this._content = value;
		this.updatePreviewUrl();
		this.requestUpdate();
	}

	@state() private viewMode: "preview" | "code" = "preview";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this; // light DOM
	}

	private setViewMode(mode: "preview" | "code") {
		this.viewMode = mode;
	}

	private revokePreviewUrl() {
		if (this.previewUrl) {
			URL.revokeObjectURL(this.previewUrl);
			this.previewUrl = "";
		}
	}

	private updatePreviewUrl() {
		this.revokePreviewUrl();
		if (!this._content) {
			return;
		}
		this.previewUrl = URL.createObjectURL(new Blob([this._content], { type: "image/svg+xml" }));
	}

	public getHeaderButtons() {
		const toggle = new PreviewCodeToggle();
		toggle.mode = this.viewMode;
		toggle.addEventListener("mode-change", (e: Event) => {
			this.setViewMode((e as CustomEvent).detail);
		});

		const copyButton = new CopyButton();
		copyButton.text = this._content;
		copyButton.title = i18n("Copy SVG");
		copyButton.showText = false;

		return html`
			<div class="flex items-center gap-2">
				${toggle}
				${copyButton}
				${DownloadButton({ content: this._content, filename: this.filename, mimeType: "image/svg+xml", title: i18n("Download SVG") })}
			</div>
		`;
	}

	override connectedCallback() {
		super.connectedCallback();
		if (this._content && !this.previewUrl) {
			this.updatePreviewUrl();
		}
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.revokePreviewUrl();
	}

	override render() {
		return html`
			<div class="h-full flex flex-col">
				<div class="flex-1 overflow-auto">
					${
						this.viewMode === "preview"
							? html`<div class="h-full flex items-center justify-center p-4">
								${
									this.previewUrl
										? html`<img
												class="max-w-full max-h-full w-full h-full object-contain"
												src="${this.previewUrl}"
												alt="${this.filename}"
											/>`
										: ""
								}
							</div>`
							: html`<pre class="m-0 p-4 text-xs"><code class="hljs language-xml">${unsafeHTML(
									hljs.highlight(this.content, { language: "xml", ignoreIllegals: true }).value,
								)}</code></pre>`
					}
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"svg-artifact": SvgArtifact;
	}
}
