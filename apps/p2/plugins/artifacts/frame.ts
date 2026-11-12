// An html artifact's page as its frame loads it: the stored version with two scripts in front, the diagnostics (sizes,
// errors, CSP violations: the channel `p2-artifact-diagnostic`) and the bridge (`bridge.ts`, `window.p2view`), served
// by the server's `/artifact-frame` route under a CSP that sandboxes it: scripts (eval too: the agent's
// `artifact_html_eval`) and https CDN resources, no app origin, frames, forms or plugins.
import { VIEW_BRIDGE_SCRIPT } from "./bridge.ts";

// The preview's diagnostics bridge: console errors and warnings, uncaught errors, CSP violations and lost WebGL
// contexts, plus the document's content height (level "size", for inline previews sized to their content). Drawings fill
// the frame's width: an SVG document with a viewBox (or an absolute width and height, made its viewBox) is set to
// 100% wide and high, so it scales with its aspect and reports viewBox height at its width; an HTML document whose
// body is just a viewBox SVG or an image gets them 100% wide at height auto (zero specificity: any author rule wins).
// HTML is measured without its scrollbar: a frame still too short shows one, and the narrower page would report a
// taller height, which keeps the scrollbar once the frame grows to it.
const DIAGNOSTIC_SCRIPT = `(()=>{const channel="p2-artifact-diagnostic";const send=(level,args)=>{try{parent.postMessage({channel,level,message:args.map(value=>{try{return typeof value==="string"?value:JSON.stringify(value)}catch{return String(value)}}).join(" ").slice(0,4000)},"*")}catch{}};for(const level of ["error","warn"]){const original=console[level];console[level]=(...args)=>{send(level,args);original.apply(console,args)}}addEventListener("error",event=>send("error",[event.message,event.filename&&(event.filename+":"+event.lineno+":"+event.colno)].filter(Boolean)));addEventListener("unhandledrejection",event=>send("error",[event.reason?.stack||event.reason||"Unhandled promise rejection"]));addEventListener("securitypolicyviolation",event=>send("csp",[event.violatedDirective,event.blockedURI||"blocked"]));addEventListener("webglcontextlost",event=>send("webgl",["WebGL context lost"]),true);send("ready",["Preview diagnostics connected"]);const fit=()=>{const root=document.documentElement;if(root instanceof SVGSVGElement){const width=root.width.baseVal,height=root.height.baseVal,absolute=length=>length.unitType!==SVGLength.SVG_LENGTHTYPE_PERCENTAGE&&length.value>0;if(!root.hasAttribute("viewBox")&&absolute(width)&&absolute(height))root.setAttribute("viewBox","0 0 "+width.value+" "+height.value);const box=root.viewBox.baseVal;if(box&&box.width>0&&box.height>0){root.setAttribute("width","100%");root.setAttribute("height","100%")}}else if(root){const style=document.createElement("style");style.textContent=":where(body>svg[viewBox]:only-child,body>img:only-child){display:block;width:100%;height:auto}";(document.head||root).prepend(style)}};try{fit()}catch{}let reported=0;const measure=()=>{const root=document.documentElement;if(!root)return;let height;if(root instanceof SVGSVGElement){const box=root.viewBox.baseVal;height=root.height.baseVal.unitType===SVGLength.SVG_LENGTHTYPE_PERCENTAGE&&box&&box.width>0&&box.height>0?root.getBoundingClientRect().width*box.height/box.width:root.getBoundingClientRect().height}else{const overflow=root.style.overflow;root.style.overflow="hidden";height=Math.max(root.getBoundingClientRect().height,document.body?document.body.scrollHeight:0);root.style.overflow=overflow}height=Math.ceil(height);if(height===reported)return;reported=height;try{parent.postMessage({channel,level:"size",message:"",height},"*")}catch{}};const observe=()=>{try{const observer=new ResizeObserver(measure);observer.observe(document.documentElement);if(document.body)observer.observe(document.body)}catch{}measure()};addEventListener("load",measure);addEventListener("resize",measure);if(document.readyState==="loading")addEventListener("DOMContentLoaded",observe);else observe();})();`;

/** The frame's CSP: as the old artifacts' previews, with `'unsafe-eval'` for the agent's code. */
export const FRAME_CSP =
	"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-modals allow-pointer-lock";

/** `html` with the diagnostics and the bridge at the top of its head (or of the document); the stored source unchanged. */
export function framePage(html: string): string {
	const scripts = `<script>${DIAGNOSTIC_SCRIPT}</script><script>${VIEW_BRIDGE_SCRIPT}</script>`;
	const head = /<head(?:\s[^>]*)?>/i.exec(html);
	if (head) return `${html.slice(0, head.index + head[0].length)}${scripts}${html.slice(head.index + head[0].length)}`;
	return `${scripts}${html}`;
}
