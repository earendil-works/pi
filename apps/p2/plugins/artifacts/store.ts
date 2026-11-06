import type { Ctx, Ref } from "@p2/app/v1";
import { ARTIFACTS, type Files, readWhole } from "@p2/app/v1/node";

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TYPES = ["html", "svg", "markdown", "text"] as const;

export type ArtifactType = (typeof TYPES)[number];
export type ArtifactInfo = { name: string; title: string; type: ArtifactType; version: number };
export type ArtifactInput = { name: string; title: string; type: ArtifactType; content: string };

// The preview's diagnostics bridge: console errors and warnings, uncaught errors, CSP violations and lost WebGL
// contexts, plus the document's content height (level "size", for inline previews sized to their content). Drawings fill
// the frame's width: an SVG document with a viewBox (or an absolute width and height, made its viewBox) is set to
// 100% wide and high, so it scales with its aspect and reports viewBox height at its width; an HTML document whose
// body is just a viewBox SVG or an image gets them 100% wide at height auto (zero specificity: any author rule wins).
// HTML is measured without its scrollbar: a frame still too short shows one, and the narrower page would report a
// taller height, which keeps the scrollbar once the frame grows to it.
const DIAGNOSTIC_SCRIPT = `(()=>{const channel="p2-artifact-diagnostic";const send=(level,args)=>{try{parent.postMessage({channel,level,message:args.map(value=>{try{return typeof value==="string"?value:JSON.stringify(value)}catch{return String(value)}}).join(" ").slice(0,4000)},"*")}catch{}};for(const level of ["error","warn"]){const original=console[level];console[level]=(...args)=>{send(level,args);original.apply(console,args)}}addEventListener("error",event=>send("error",[event.message,event.filename&&(event.filename+":"+event.lineno+":"+event.colno)].filter(Boolean)));addEventListener("unhandledrejection",event=>send("error",[event.reason?.stack||event.reason||"Unhandled promise rejection"]));addEventListener("securitypolicyviolation",event=>send("csp",[event.violatedDirective,event.blockedURI||"blocked"]));addEventListener("webglcontextlost",event=>send("webgl",["WebGL context lost"]),true);send("ready",["Preview diagnostics connected"]);const fit=()=>{const root=document.documentElement;if(root instanceof SVGSVGElement){const width=root.width.baseVal,height=root.height.baseVal,absolute=length=>length.unitType!==SVGLength.SVG_LENGTHTYPE_PERCENTAGE&&length.value>0;if(!root.hasAttribute("viewBox")&&absolute(width)&&absolute(height))root.setAttribute("viewBox","0 0 "+width.value+" "+height.value);const box=root.viewBox.baseVal;if(box&&box.width>0&&box.height>0){root.setAttribute("width","100%");root.setAttribute("height","100%")}}else if(root){const style=document.createElement("style");style.textContent=":where(body>svg[viewBox]:only-child,body>img:only-child){display:block;width:100%;height:auto}";(document.head||root).prepend(style)}};try{fit()}catch{}let reported=0;const measure=()=>{const root=document.documentElement;if(!root)return;let height;if(root instanceof SVGSVGElement){const box=root.viewBox.baseVal;height=root.height.baseVal.unitType===SVGLength.SVG_LENGTHTYPE_PERCENTAGE&&box&&box.width>0&&box.height>0?root.getBoundingClientRect().width*box.height/box.width:root.getBoundingClientRect().height}else{const overflow=root.style.overflow;root.style.overflow="hidden";height=Math.max(root.getBoundingClientRect().height,document.body?document.body.scrollHeight:0);root.style.overflow=overflow}height=Math.ceil(height);if(height===reported)return;reported=height;try{parent.postMessage({channel,level:"size",message:"",height},"*")}catch{}};const observe=()=>{try{const observer=new ResizeObserver(measure);observer.observe(document.documentElement);if(document.body)observer.observe(document.body)}catch{}measure()};addEventListener("load",measure);addEventListener("resize",measure);if(document.readyState==="loading")addEventListener("DOMContentLoaded",observe);else observe();})();`;

/** Add a diagnostics bridge without changing the immutable stored source. */
export function instrumentArtifact(info: ArtifactInfo, content: string): string {
	if (info.type === "html") {
		const head = /<head(?:\s[^>]*)?>/i.exec(content);
		const script = `<script>${DIAGNOSTIC_SCRIPT}</script>`;
		if (head)
			return `${content.slice(0, head.index + head[0].length)}${script}${content.slice(head.index + head[0].length)}`;
		return `${script}${content}`;
	}
	if (info.type === "svg") {
		const root = /<svg(?:\s[^>]*)?>/i.exec(content);
		// SVG is XML: the script's `&&` would end the document without CDATA. An empty root (`<svg/>`) has no inside.
		const script = `<script><![CDATA[${DIAGNOSTIC_SCRIPT}]]></script>`;
		if (root && !root[0].endsWith("/>"))
			return `${content.slice(0, root.index + root[0].length)}${script}${content.slice(root.index + root[0].length)}`;
	}
	return content;
}

export class ArtifactError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "ArtifactError";
		this.status = status;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validName(name: unknown): name is string {
	return typeof name === "string" && name.trim() === name && NAME.test(name);
}

function validVersion(version: unknown): version is number {
	return typeof version === "number" && Number.isSafeInteger(version) && version > 0;
}

function validTitle(title: unknown): title is string {
	return (
		typeof title === "string" &&
		title.length > 0 &&
		title.length <= 200 &&
		title.trim() === title &&
		title.isWellFormed() &&
		!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)
	);
}

function validType(type: unknown): type is ArtifactType {
	return TYPES.some((candidate) => candidate === type);
}

function validateInput(value: unknown): ArtifactInput {
	if (!record(value) || Object.keys(value).sort().join(",") !== "content,name,title,type")
		throw new ArtifactError(400, "Invalid artifact fields");
	if (!validName(value.name)) throw new ArtifactError(400, "Invalid artifact name");
	if (!validTitle(value.title)) throw new ArtifactError(400, "Invalid artifact title (1–200 characters)");
	if (!validType(value.type)) throw new ArtifactError(400, "Invalid artifact type");
	if (typeof value.content !== "string" || !value.content.isWellFormed())
		throw new ArtifactError(400, "Invalid artifact content");
	if (Buffer.byteLength(value.content, "utf8") > MAX_ARTIFACT_BYTES)
		throw new ArtifactError(413, "Artifact content exceeds 2 MiB");
	return { name: value.name, title: value.title, type: value.type, content: value.content };
}

/** The type an artifact's bytes are stored with. */
const MIME: Record<ArtifactType, string> = {
	html: "text/html",
	svg: "image/svg+xml",
	markdown: "text/markdown",
	text: "text/plain",
};

/**
 * Saves `input` as the next version of its artifact in the session's files (space `artifacts`, path = its name, Files
 * versions = artifact versions, never reused), written by the agent of conversation `ref`. Locators do not authorize
 * access; callers must authorize the session.
 */
export async function saveArtifact(
	files: Ref<typeof Files>,
	input: ArtifactInput,
	ref: string,
	ctx: Ctx,
): Promise<ArtifactInfo> {
	const value = validateInput(input);
	const file = await files.put(
		{
			space: ARTIFACTS,
			path: value.name,
			mime: MIME[value.type],
			source: "agent",
			ref,
			meta: { title: value.title, type: value.type },
			bytes: Buffer.from(value.content, "utf8"),
		},
		ctx,
	);
	return { name: value.name, title: value.title, type: value.type, version: file.version };
}

/** Version `version` of artifact `name` of the session's files; a missing or invalid one is "Artifact not found". */
export async function readArtifact(
	files: Ref<typeof Files>,
	name: string,
	version: number,
	ctx: Ctx,
): Promise<{ info: ArtifactInfo; content: string }> {
	if (!validName(name) || !validVersion(version)) throw new ArtifactError(404, "Artifact not found");
	const file = await files.get({ space: ARTIFACTS, path: name, version }, ctx);
	if (file === null || file.size > MAX_ARTIFACT_BYTES) throw new ArtifactError(404, "Artifact not found");
	const bytes = await readWhole(files, file, ctx);
	const content = bytes.toString("utf8");
	const meta = record(file.meta) ? file.meta : {};
	try {
		const value = validateInput({ name, title: meta.title, type: meta.type, content });
		if (!bytes.equals(Buffer.from(content, "utf8"))) throw new Error("Invalid UTF-8");
		return { info: { name, title: value.title, type: value.type, version }, content: value.content };
	} catch {
		throw new ArtifactError(404, "Artifact not found");
	}
}
