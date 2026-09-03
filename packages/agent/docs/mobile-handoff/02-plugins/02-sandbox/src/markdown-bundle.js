"use strict";
var __m = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // packages/tui/bundle-bench.ts
  var bundle_bench_exports = {};
  __export(bundle_bench_exports, {
    bench: () => bench
  });

  // node_modules/marked/lib/marked.esm.js
  function M() {
    return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
  }
  var T = M();
  function N(l3) {
    T = l3;
  }
  var _ = { exec: () => null };
  function E(l3) {
    let e = [];
    return (t) => {
      let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
      return s || (s = l3(n), e[n] = s), s;
    };
  }
  function d(l3, e = "") {
    let t = typeof l3 == "string" ? l3 : l3.source, n = { replace: (s, r) => {
      let i = typeof r == "string" ? r : r.source;
      return i = i.replace(m.caret, "$1"), t = t.replace(s, i), n;
    }, getRegex: () => new RegExp(t, e) };
    return n;
  }
  var Te = ((l3 = "") => {
    try {
      return !!new RegExp("(?<=1)(?<!1)" + l3);
    } catch {
      return false;
    }
  })();
  var m = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l3) => new RegExp(`^( {0,3}${l3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: E((l3) => new RegExp(`^ {0,${l3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: E((l3) => new RegExp(`^ {0,${l3}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`)), fencesBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}(?:\`\`\`|~~~)`)), headingBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}#`)), htmlBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}<(?:[a-z].*>|!--)`, "i")), blockquoteBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}>`)) };
  var Oe = /^(?:[ \t]*(?:\n|$))+/;
  var we = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  var ye = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
  var B = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  var Pe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  var j = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
  var oe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
  var ae = d(oe).replace(/bull/g, j).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
  var Se = d(oe).replace(/bull/g, j).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
  var F = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/;
  var $e = /^[^\n]+/;
  var U = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
  var Le = d(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", U).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
  var _e = d(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, j).getRegex();
  var H = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
  var K = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  var ze = d("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", K).replace("tag", H).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
  var le = d(F).replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
  var Me = d(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", le).getRegex();
  var W = { blockquote: Me, code: we, def: Le, fences: ye, heading: Pe, hr: B, html: ze, lheading: ae, list: _e, newline: Oe, paragraph: le, table: _, text: $e };
  var se = d("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
  var Ee = { ...W, lheading: Se, table: se, paragraph: d(F).replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", se).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex() };
  var Ie = { ...W, html: d(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", K).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: _, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: d(F).replace("hr", B).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", ae).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
  var Ae = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  var Ce = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  var ue = /^( {2,}|\\)\n(?!\s*$)/;
  var Be = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
  var I = /[\p{P}\p{S}]/u;
  var Z = /[\s\p{P}\p{S}]/u;
  var X = /[^\s\p{P}\p{S}]/u;
  var De = d(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, Z).getRegex();
  var pe = /(?!~)[\p{P}\p{S}]/u;
  var qe = /(?!~)[\s\p{P}\p{S}]/u;
  var ve = /(?:[^\s\p{P}\p{S}]|~)/u;
  var He = d(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Te ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
  var ce = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
  var Ze = d(ce, "u").replace(/punct/g, I).getRegex();
  var Ge = d(ce, "u").replace(/punct/g, pe).getRegex();
  var he = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
  var Ne = d(he, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
  var Qe = d(he, "gu").replace(/notPunctSpace/g, ve).replace(/punctSpace/g, qe).replace(/punct/g, pe).getRegex();
  var je = d("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
  var Fe = d(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, I).getRegex();
  var Ue = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
  var Ke = d(Ue, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
  var We = d(/\\(punct)/, "gu").replace(/punct/g, I).getRegex();
  var Xe = d(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
  var Je = d(K).replace("(?:-->|$)", "-->").getRegex();
  var Ve = d("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", Je).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
  var v = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
  var Ye = d(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", v).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
  var ke = d(/^!?\[(label)\]\[(ref)\]/).replace("label", v).replace("ref", U).getRegex();
  var de = d(/^!?\[(ref)\](?:\[\])?/).replace("ref", U).getRegex();
  var et = d("reflink|nolink(?!\\()", "g").replace("reflink", ke).replace("nolink", de).getRegex();
  var ie = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
  var J = { _backpedal: _, anyPunctuation: We, autolink: Xe, blockSkip: He, br: ue, code: Ce, del: _, delLDelim: _, delRDelim: _, emStrongLDelim: Ze, emStrongRDelimAst: Ne, emStrongRDelimUnd: je, escape: Ae, link: Ye, nolink: de, punctuation: De, reflink: ke, reflinkSearch: et, tag: Ve, text: Be, url: _ };
  var tt = { ...J, link: d(/^!?\[(label)\]\((.*?)\)/).replace("label", v).getRegex(), reflink: d(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", v).getRegex() };
  var Q = { ...J, emStrongRDelimAst: Qe, emStrongLDelim: Ge, delLDelim: Fe, delRDelim: Ke, url: d(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ie).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: d(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ie).getRegex() };
  var nt = { ...Q, br: d(ue).replace("{2,}", "*").getRegex(), text: d(Q.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
  var D = { normal: W, gfm: Ee, pedantic: Ie };
  var A = { normal: J, gfm: Q, breaks: nt, pedantic: tt };
  var rt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var ge = (l3) => rt[l3];
  function O(l3, e) {
    if (e) {
      if (m.escapeTest.test(l3)) return l3.replace(m.escapeReplace, ge);
    } else if (m.escapeTestNoEncode.test(l3)) return l3.replace(m.escapeReplaceNoEncode, ge);
    return l3;
  }
  function V(l3) {
    try {
      l3 = encodeURI(l3).replace(m.percentDecode, "%");
    } catch {
      return null;
    }
    return l3;
  }
  function Y(l3, e) {
    let t = l3.replace(m.findPipe, (r, i, o) => {
      let u = false, a = i;
      for (; --a >= 0 && o[a] === "\\"; ) u = !u;
      return u ? "|" : " |";
    }), n = t.split(m.splitPipe), s = 0;
    if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
    else for (; n.length < e; ) n.push("");
    for (; s < n.length; s++) n[s] = n[s].trim().replace(m.slashPipe, "|");
    return n;
  }
  function $(l3, e, t) {
    let n = l3.length;
    if (n === 0) return "";
    let s = 0;
    for (; s < n; ) {
      let r = l3.charAt(n - s - 1);
      if (r === e && !t) s++;
      else if (r !== e && t) s++;
      else break;
    }
    return l3.slice(0, n - s);
  }
  function ee(l3) {
    let e = l3.split(`
`), t = e.length - 1;
    for (; t >= 0 && m.blankLine.test(e[t]); ) t--;
    return e.length - t <= 2 ? l3 : e.slice(0, t + 1).join(`
`);
  }
  function fe(l3, e) {
    if (l3.indexOf(e[1]) === -1) return -1;
    let t = 0;
    for (let n = 0; n < l3.length; n++) if (l3[n] === "\\") n++;
    else if (l3[n] === e[0]) t++;
    else if (l3[n] === e[1] && (t--, t < 0)) return n;
    return t > 0 ? -2 : -1;
  }
  function me(l3, e = 0) {
    let t = e, n = "";
    for (let s of l3) if (s === "	") {
      let r = 4 - t % 4;
      n += " ".repeat(r), t += r;
    } else n += s, t++;
    return n;
  }
  function xe(l3, e, t, n, s) {
    let r = e.href, i = e.title || null, o = l3[1].replace(s.other.outputLinkReplace, "$1");
    n.state.inLink = true;
    let u = { type: l3[0].charAt(0) === "!" ? "image" : "link", raw: t, href: r, title: i, text: o, tokens: n.inlineTokens(o) };
    return n.state.inLink = false, u;
  }
  function st(l3, e, t) {
    let n = l3.match(t.other.indentCodeCompensation);
    if (n === null) return e;
    let s = n[1];
    return e.split(`
`).map((r) => {
      let i = r.match(t.other.beginningSpace);
      if (i === null) return r;
      let [o] = i;
      return o.length >= s.length ? r.slice(s.length) : r;
    }).join(`
`);
  }
  var w = class {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "rules");
      __publicField(this, "lexer");
      this.options = e || T;
    }
    space(e) {
      let t = this.rules.block.newline.exec(e);
      if (t && t[0].length > 0) return { type: "space", raw: t[0] };
    }
    code(e) {
      let t = this.rules.block.code.exec(e);
      if (t) {
        let n = this.options.pedantic ? t[0] : ee(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
        return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
      }
    }
    fences(e) {
      let t = this.rules.block.fences.exec(e);
      if (t) {
        let n = t[0], s = st(n, t[3] || "", this.rules);
        return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
      }
    }
    heading(e) {
      let t = this.rules.block.heading.exec(e);
      if (t) {
        let n = t[2].trim();
        if (this.rules.other.endingHash.test(n)) {
          let s = $(n, "#");
          (this.options.pedantic || !s || this.rules.other.endingSpaceChar.test(s)) && (n = s.trim());
        }
        return { type: "heading", raw: $(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
      }
    }
    hr(e) {
      let t = this.rules.block.hr.exec(e);
      if (t) return { type: "hr", raw: $(t[0], `
`) };
    }
    blockquote(e) {
      let t = this.rules.block.blockquote.exec(e);
      if (t) {
        let n = $(t[0], `
`).split(`
`), s = "", r = "", i = [];
        for (; n.length > 0; ) {
          let o = false, u = [], a;
          for (a = 0; a < n.length; a++) if (this.rules.other.blockquoteStart.test(n[a])) u.push(n[a]), o = true;
          else if (!o) u.push(n[a]);
          else break;
          n = n.slice(a);
          let c = u.join(`
`), p = c.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
          s = s ? `${s}
${c}` : c, r = r ? `${r}
${p}` : p;
          let k = this.lexer.state.top;
          if (this.lexer.state.top = true, this.lexer.blockTokens(p, i, true), this.lexer.state.top = k, n.length === 0) break;
          let h = i.at(-1);
          if (h?.type === "code") break;
          if (h?.type === "blockquote") {
            let R = h, f = R.raw + `
` + n.join(`
`), S = this.blockquote(f);
            i[i.length - 1] = S, s = s.substring(0, s.length - R.raw.length) + S.raw, r = r.substring(0, r.length - R.text.length) + S.text;
            break;
          } else if (h?.type === "list") {
            let R = h, f = R.raw + `
` + n.join(`
`), S = this.list(f);
            i[i.length - 1] = S, s = s.substring(0, s.length - h.raw.length) + S.raw, r = r.substring(0, r.length - R.raw.length) + S.raw, n = f.substring(i.at(-1).raw.length).split(`
`);
            continue;
          }
        }
        return { type: "blockquote", raw: s, tokens: i, text: r };
      }
    }
    list(e) {
      let t = this.rules.block.list.exec(e);
      if (t) {
        let n = t[1].trim(), s = n.length > 1, r = { type: "list", raw: "", ordered: s, start: s ? +n.slice(0, -1) : "", loose: false, items: [] };
        n = s ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = s ? n : "[*+-]");
        let i = this.rules.other.listItemRegex(n), o = false;
        for (; e; ) {
          let a = false, c = "", p = "";
          if (!(t = i.exec(e)) || this.rules.block.hr.test(e)) break;
          c = t[0], e = e.substring(c.length);
          let k = me(t[2].split(`
`, 1)[0], t[1].length), h = e.split(`
`, 1)[0], R = !k.trim(), f = 0;
          if (this.options.pedantic ? (f = 2, p = k.trimStart()) : R ? f = t[1].length + 1 : (f = k.search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, p = k.slice(f), f += t[1].length), R && this.rules.other.blankLine.test(h) && (c += h + `
`, e = e.substring(h.length + 1), a = true), !a) {
            let S = this.rules.other.nextBulletRegex(f), te = this.rules.other.hrRegex(f), ne = this.rules.other.fencesBeginRegex(f), re = this.rules.other.headingBeginRegex(f), be = this.rules.other.htmlBeginRegex(f), Re = this.rules.other.blockquoteBeginRegex(f);
            for (; e; ) {
              let G = e.split(`
`, 1)[0], C;
              if (h = G, this.options.pedantic ? (h = h.replace(this.rules.other.listReplaceNesting, "  "), C = h) : C = h.replace(this.rules.other.tabCharGlobal, "    "), ne.test(h) || re.test(h) || be.test(h) || Re.test(h) || S.test(h) || te.test(h)) break;
              if (C.search(this.rules.other.nonSpaceChar) >= f || !h.trim()) p += `
` + C.slice(f);
              else {
                if (R || k.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ne.test(k) || re.test(k) || te.test(k)) break;
                p += `
` + h;
              }
              R = !h.trim(), c += G + `
`, e = e.substring(G.length + 1), k = C.slice(f);
            }
          }
          r.loose || (o ? r.loose = true : this.rules.other.doubleBlankLine.test(c) && (o = true)), r.items.push({ type: "list_item", raw: c, task: !!this.options.gfm && this.rules.other.listIsTask.test(p), loose: false, text: p, tokens: [] }), r.raw += c;
        }
        let u = r.items.at(-1);
        if (u) u.raw = u.raw.trimEnd(), u.text = u.text.trimEnd();
        else return;
        r.raw = r.raw.trimEnd();
        for (let a of r.items) {
          this.lexer.state.top = false, a.tokens = this.lexer.blockTokens(a.text, []);
          let c = a.tokens[0];
          if (a.task && (c?.type === "text" || c?.type === "paragraph")) {
            a.text = a.text.replace(this.rules.other.listReplaceTask, ""), c.raw = c.raw.replace(this.rules.other.listReplaceTask, ""), c.text = c.text.replace(this.rules.other.listReplaceTask, "");
            for (let k = this.lexer.inlineQueue.length - 1; k >= 0; k--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[k].src)) {
              this.lexer.inlineQueue[k].src = this.lexer.inlineQueue[k].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
            let p = this.rules.other.listTaskCheckbox.exec(a.raw);
            if (p) {
              let k = { type: "checkbox", raw: p[0] + " ", checked: p[0] !== "[ ]" };
              a.checked = k.checked, r.loose ? a.tokens[0] && ["paragraph", "text"].includes(a.tokens[0].type) && "tokens" in a.tokens[0] && a.tokens[0].tokens ? (a.tokens[0].raw = k.raw + a.tokens[0].raw, a.tokens[0].text = k.raw + a.tokens[0].text, a.tokens[0].tokens.unshift(k)) : a.tokens.unshift({ type: "paragraph", raw: k.raw, text: k.raw, tokens: [k] }) : a.tokens.unshift(k);
            }
          } else a.task && (a.task = false);
          if (!r.loose) {
            let p = a.tokens.filter((h) => h.type === "space"), k = p.length > 0 && p.some((h) => this.rules.other.anyLine.test(h.raw));
            r.loose = k;
          }
        }
        if (r.loose) for (let a of r.items) {
          a.loose = true;
          for (let c of a.tokens) c.type === "text" && (c.type = "paragraph");
        }
        return r;
      }
    }
    html(e) {
      let t = this.rules.block.html.exec(e);
      if (t) {
        let n = ee(t[0]);
        return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
      }
    }
    def(e) {
      let t = this.rules.block.def.exec(e);
      if (t) {
        let n = t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
        return { type: "def", tag: n, raw: $(t[0], `
`), href: s, title: r };
      }
    }
    table(e) {
      let t = this.rules.block.table.exec(e);
      if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
      let n = Y(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], i = { type: "table", raw: $(t[0], `
`), header: [], align: [], rows: [] };
      if (n.length === s.length) {
        for (let o of s) this.rules.other.tableAlignRight.test(o) ? i.align.push("right") : this.rules.other.tableAlignCenter.test(o) ? i.align.push("center") : this.rules.other.tableAlignLeft.test(o) ? i.align.push("left") : i.align.push(null);
        for (let o = 0; o < n.length; o++) i.header.push({ text: n[o], tokens: this.lexer.inline(n[o]), header: true, align: i.align[o] });
        for (let o of r) i.rows.push(Y(o, i.header.length).map((u, a) => ({ text: u, tokens: this.lexer.inline(u), header: false, align: i.align[a] })));
        return i;
      }
    }
    lheading(e) {
      let t = this.rules.block.lheading.exec(e);
      if (t) {
        let n = t[1].trim();
        return { type: "heading", raw: $(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
      }
    }
    paragraph(e) {
      let t = this.rules.block.paragraph.exec(e);
      if (t) {
        let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
        return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
      }
    }
    text(e) {
      let t = this.rules.block.text.exec(e);
      if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
    }
    escape(e) {
      let t = this.rules.inline.escape.exec(e);
      if (t) return { type: "escape", raw: t[0], text: t[1] };
    }
    tag(e) {
      let t = this.rules.inline.tag.exec(e);
      if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
    }
    link(e) {
      let t = this.rules.inline.link.exec(e);
      if (t) {
        let n = t[2].trim();
        if (!this.options.pedantic && this.rules.other.startAngleBracket.test(n)) {
          if (!this.rules.other.endAngleBracket.test(n)) return;
          let i = $(n.slice(0, -1), "\\");
          if ((n.length - i.length) % 2 === 0) return;
        } else {
          let i = fe(t[2], "()");
          if (i === -2) return;
          if (i > -1) {
            let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + i;
            t[2] = t[2].substring(0, i), t[0] = t[0].substring(0, u).trim(), t[3] = "";
          }
        }
        let s = t[2], r = "";
        if (this.options.pedantic) {
          let i = this.rules.other.pedanticHrefTitle.exec(s);
          i && (s = i[1], r = i[3]);
        } else r = t[3] ? t[3].slice(1, -1) : "";
        return s = s.trim(), this.rules.other.startAngleBracket.test(s) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(n) ? s = s.slice(1) : s = s.slice(1, -1)), xe(t, { href: s && s.replace(this.rules.inline.anyPunctuation, "$1"), title: r && r.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
      }
    }
    reflink(e, t) {
      let n;
      if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
        let s = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), r = t[s.toLowerCase()];
        if (!r) {
          let i = n[0].charAt(0);
          return { type: "text", raw: i, text: i };
        }
        return xe(n, r, n[0], this.lexer, this.rules);
      }
    }
    emStrong(e, t, n = "") {
      let s = this.rules.inline.emStrongLDelim.exec(e);
      if (!s || !s[1] && !s[2] && !s[3] && !s[4] || s[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
      if (!(s[1] || s[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
        let i = [...s[0]].length - 1, o, u, a = i, c = 0, p = s[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
        for (p.lastIndex = 0, t = t.slice(-1 * e.length + i); (s = p.exec(t)) !== null; ) {
          if (o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !o) continue;
          if (u = [...o].length, s[3] || s[4]) {
            a += u;
            continue;
          } else if ((s[5] || s[6]) && i % 3 && !((i + u) % 3)) {
            c += u;
            continue;
          }
          if (a -= u, a > 0) continue;
          u = Math.min(u, u + a + c);
          let k = [...s[0]][0].length, h = e.slice(0, i + s.index + k + u);
          if (Math.min(i, u) % 2) {
            let f = h.slice(1, -1);
            return { type: "em", raw: h, text: f, tokens: this.lexer.inlineTokens(f) };
          }
          let R = h.slice(2, -2);
          return { type: "strong", raw: h, text: R, tokens: this.lexer.inlineTokens(R) };
        }
      }
    }
    codespan(e) {
      let t = this.rules.inline.code.exec(e);
      if (t) {
        let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
        return s && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
      }
    }
    br(e) {
      let t = this.rules.inline.br.exec(e);
      if (t) return { type: "br", raw: t[0] };
    }
    del(e, t, n = "") {
      let s = this.rules.inline.delLDelim.exec(e);
      if (!s) return;
      if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
        let i = [...s[0]].length - 1, o, u, a = i, c = this.rules.inline.delRDelim;
        for (c.lastIndex = 0, t = t.slice(-1 * e.length + i); (s = c.exec(t)) !== null; ) {
          if (o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !o || (u = [...o].length, u !== i)) continue;
          if (s[3] || s[4]) {
            a += u;
            continue;
          }
          if (a -= u, a > 0) continue;
          u = Math.min(u, u + a);
          let p = [...s[0]][0].length, k = e.slice(0, i + s.index + p + u), h = k.slice(i, -i);
          return { type: "del", raw: k, text: h, tokens: this.lexer.inlineTokens(h) };
        }
      }
    }
    autolink(e) {
      let t = this.rules.inline.autolink.exec(e);
      if (t) {
        let n, s;
        return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, tokens: [{ type: "text", raw: n, text: n }] };
      }
    }
    url(e) {
      let t;
      if (t = this.rules.inline.url.exec(e)) {
        let n, s;
        if (t[2] === "@") n = t[0], s = "mailto:" + n;
        else {
          let r;
          do
            r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
          while (r !== t[0]);
          n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
        }
        return { type: "link", raw: t[0], text: n, href: s, tokens: [{ type: "text", raw: n, text: n }] };
      }
    }
    inlineText(e) {
      let t = this.rules.inline.text.exec(e);
      if (t) {
        let n = this.lexer.state.inRawBlock;
        return { type: "text", raw: t[0], text: t[0], escaped: n };
      }
    }
  };
  var x = class l {
    constructor(e) {
      __publicField(this, "tokens");
      __publicField(this, "options");
      __publicField(this, "state");
      __publicField(this, "inlineQueue");
      __publicField(this, "tokenizer");
      this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || T, this.options.tokenizer = this.options.tokenizer || new w(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, top: true };
      let t = { other: m, block: D.normal, inline: A.normal };
      this.options.pedantic ? (t.block = D.pedantic, t.inline = A.pedantic) : this.options.gfm && (t.block = D.gfm, this.options.breaks ? t.inline = A.breaks : t.inline = A.gfm), this.tokenizer.rules = t;
    }
    static get rules() {
      return { block: D, inline: A };
    }
    static lex(e, t) {
      return new l(t).lex(e);
    }
    static lexInline(e, t) {
      return new l(t).inlineTokens(e);
    }
    lex(e) {
      e = e.replace(m.carriageReturn, `
`), this.blockTokens(e, this.tokens);
      for (let t = 0; t < this.inlineQueue.length; t++) {
        let n = this.inlineQueue[t];
        this.inlineTokens(n.src, n.tokens);
      }
      return this.inlineQueue = [], this.tokens;
    }
    blockTokens(e, t = [], n = false) {
      this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, ""));
      let s = 1 / 0;
      for (; e; ) {
        if (e.length < s) s = e.length;
        else {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
        let r;
        if (this.options.extensions?.block?.some((o) => (r = o.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
        if (r = this.tokenizer.space(e)) {
          e = e.substring(r.raw.length);
          let o = t.at(-1);
          r.raw.length === 1 && o !== void 0 ? o.raw += `
` : t.push(r);
          continue;
        }
        if (r = this.tokenizer.code(e)) {
          e = e.substring(r.raw.length);
          let o = t.at(-1);
          o?.type === "paragraph" || o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.at(-1).src = o.text) : t.push(r);
          continue;
        }
        if (r = this.tokenizer.fences(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.heading(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.hr(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.blockquote(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.list(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.html(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.def(e)) {
          e = e.substring(r.raw.length);
          let o = t.at(-1);
          o?.type === "paragraph" || o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.raw, this.inlineQueue.at(-1).src = o.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
          continue;
        }
        if (r = this.tokenizer.table(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        if (r = this.tokenizer.lheading(e)) {
          e = e.substring(r.raw.length), t.push(r);
          continue;
        }
        let i = e;
        if (this.options.extensions?.startBlock) {
          let o = 1 / 0, u = e.slice(1), a;
          this.options.extensions.startBlock.forEach((c) => {
            a = c.call({ lexer: this }, u), typeof a == "number" && a >= 0 && (o = Math.min(o, a));
          }), o < 1 / 0 && o >= 0 && (i = e.substring(0, o + 1));
        }
        if (this.state.top && (r = this.tokenizer.paragraph(i))) {
          let o = t.at(-1);
          n && o?.type === "paragraph" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : t.push(r), n = i.length !== e.length, e = e.substring(r.raw.length);
          continue;
        }
        if (r = this.tokenizer.text(e)) {
          e = e.substring(r.raw.length);
          let o = t.at(-1);
          o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : t.push(r);
          continue;
        }
        if (e) {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
      }
      return this.state.top = true, t;
    }
    inline(e, t = []) {
      return this.inlineQueue.push({ src: e, tokens: t }), t;
    }
    inlineTokens(e, t = []) {
      this.tokenizer.lexer = this;
      let n = e, s = null;
      if (this.tokens.links) {
        let a = Object.keys(this.tokens.links);
        if (a.length > 0) for (; (s = this.tokenizer.rules.inline.reflinkSearch.exec(n)) !== null; ) a.includes(s[0].slice(s[0].lastIndexOf("[") + 1, -1)) && (n = n.slice(0, s.index) + "[" + "a".repeat(s[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
      }
      for (; (s = this.tokenizer.rules.inline.anyPunctuation.exec(n)) !== null; ) n = n.slice(0, s.index) + "++" + n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
      let r;
      for (; (s = this.tokenizer.rules.inline.blockSkip.exec(n)) !== null; ) r = s[2] ? s[2].length : 0, n = n.slice(0, s.index + r) + "[" + "a".repeat(s[0].length - r - 2) + "]" + n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
      n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
      let i = false, o = "", u = 1 / 0;
      for (; e; ) {
        if (e.length < u) u = e.length;
        else {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
        i || (o = ""), i = false;
        let a;
        if (this.options.extensions?.inline?.some((p) => (a = p.call({ lexer: this }, e, t)) ? (e = e.substring(a.raw.length), t.push(a), true) : false)) continue;
        if (a = this.tokenizer.escape(e)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (a = this.tokenizer.tag(e)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (a = this.tokenizer.link(e)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (a = this.tokenizer.reflink(e, this.tokens.links)) {
          e = e.substring(a.raw.length);
          let p = t.at(-1);
          a.type === "text" && p?.type === "text" ? (p.raw += a.raw, p.text += a.text) : t.push(a);
          continue;
        }
        if (a = this.tokenizer.emStrong(e, n, o)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (a = this.tokenizer.codespan(e)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (a = this.tokenizer.br(e)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (a = this.tokenizer.del(e, n, o)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (a = this.tokenizer.autolink(e)) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        if (!this.state.inLink && (a = this.tokenizer.url(e))) {
          e = e.substring(a.raw.length), t.push(a);
          continue;
        }
        let c = e;
        if (this.options.extensions?.startInline) {
          let p = 1 / 0, k = e.slice(1), h;
          this.options.extensions.startInline.forEach((R) => {
            h = R.call({ lexer: this }, k), typeof h == "number" && h >= 0 && (p = Math.min(p, h));
          }), p < 1 / 0 && p >= 0 && (c = e.substring(0, p + 1));
        }
        if (a = this.tokenizer.inlineText(c)) {
          e = e.substring(a.raw.length), a.raw.slice(-1) !== "_" && (o = a.raw.slice(-1)), i = true;
          let p = t.at(-1);
          p?.type === "text" ? (p.raw += a.raw, p.text += a.text) : t.push(a);
          continue;
        }
        if (e) {
          this.infiniteLoopError(e.charCodeAt(0));
          break;
        }
      }
      return t;
    }
    infiniteLoopError(e) {
      let t = "Infinite loop on byte: " + e;
      if (this.options.silent) console.error(t);
      else throw new Error(t);
    }
  };
  var y = class {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "parser");
      this.options = e || T;
    }
    space(e) {
      return "";
    }
    code({ text: e, lang: t, escaped: n }) {
      let s = (t || "").match(m.notSpaceStart)?.[0], r = e.replace(m.endingNewline, "") + `
`;
      return s ? '<pre><code class="language-' + O(s) + '">' + (n ? r : O(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : O(r, true)) + `</code></pre>
`;
    }
    blockquote({ tokens: e }) {
      return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
    }
    html({ text: e }) {
      return e;
    }
    def(e) {
      return "";
    }
    heading({ tokens: e, depth: t }) {
      return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
    }
    hr(e) {
      return `<hr>
`;
    }
    list(e) {
      let t = e.ordered, n = e.start, s = "";
      for (let o = 0; o < e.items.length; o++) {
        let u = e.items[o];
        s += this.listitem(u);
      }
      let r = t ? "ol" : "ul", i = t && n !== 1 ? ' start="' + n + '"' : "";
      return "<" + r + i + `>
` + s + "</" + r + `>
`;
    }
    listitem(e) {
      return `<li>${this.parser.parse(e.tokens)}</li>
`;
    }
    checkbox({ checked: e }) {
      return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
    }
    paragraph({ tokens: e }) {
      return `<p>${this.parser.parseInline(e)}</p>
`;
    }
    table(e) {
      let t = "", n = "";
      for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
      t += this.tablerow({ text: n });
      let s = "";
      for (let r = 0; r < e.rows.length; r++) {
        let i = e.rows[r];
        n = "";
        for (let o = 0; o < i.length; o++) n += this.tablecell(i[o]);
        s += this.tablerow({ text: n });
      }
      return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
    }
    tablerow({ text: e }) {
      return `<tr>
${e}</tr>
`;
    }
    tablecell(e) {
      let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
      return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
    }
    strong({ tokens: e }) {
      return `<strong>${this.parser.parseInline(e)}</strong>`;
    }
    em({ tokens: e }) {
      return `<em>${this.parser.parseInline(e)}</em>`;
    }
    codespan({ text: e }) {
      return `<code>${O(e, true)}</code>`;
    }
    br(e) {
      return "<br>";
    }
    del({ tokens: e }) {
      return `<del>${this.parser.parseInline(e)}</del>`;
    }
    link({ href: e, title: t, tokens: n }) {
      let s = this.parser.parseInline(n), r = V(e);
      if (r === null) return s;
      e = r;
      let i = '<a href="' + e + '"';
      return t && (i += ' title="' + O(t) + '"'), i += ">" + s + "</a>", i;
    }
    image({ href: e, title: t, text: n, tokens: s }) {
      s && (n = this.parser.parseInline(s, this.parser.textRenderer));
      let r = V(e);
      if (r === null) return O(n);
      e = r;
      let i = `<img src="${e}" alt="${O(n)}"`;
      return t && (i += ` title="${O(t)}"`), i += ">", i;
    }
    text(e) {
      return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : O(e.text);
    }
  };
  var L = class {
    strong({ text: e }) {
      return e;
    }
    em({ text: e }) {
      return e;
    }
    codespan({ text: e }) {
      return e;
    }
    del({ text: e }) {
      return e;
    }
    html({ text: e }) {
      return e;
    }
    text({ text: e }) {
      return e;
    }
    link({ text: e }) {
      return "" + e;
    }
    image({ text: e }) {
      return "" + e;
    }
    br() {
      return "";
    }
    checkbox({ raw: e }) {
      return e;
    }
  };
  var b = class l2 {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "renderer");
      __publicField(this, "textRenderer");
      this.options = e || T, this.options.renderer = this.options.renderer || new y(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new L();
    }
    static parse(e, t) {
      return new l2(t).parse(e);
    }
    static parseInline(e, t) {
      return new l2(t).parseInline(e);
    }
    parse(e) {
      this.renderer.parser = this;
      let t = "";
      for (let n = 0; n < e.length; n++) {
        let s = e[n];
        if (this.options.extensions?.renderers?.[s.type]) {
          let i = s, o = this.options.extensions.renderers[i.type].call({ parser: this }, i);
          if (o !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(i.type)) {
            t += o || "";
            continue;
          }
        }
        let r = s;
        switch (r.type) {
          case "space": {
            t += this.renderer.space(r);
            break;
          }
          case "hr": {
            t += this.renderer.hr(r);
            break;
          }
          case "heading": {
            t += this.renderer.heading(r);
            break;
          }
          case "code": {
            t += this.renderer.code(r);
            break;
          }
          case "table": {
            t += this.renderer.table(r);
            break;
          }
          case "blockquote": {
            t += this.renderer.blockquote(r);
            break;
          }
          case "list": {
            t += this.renderer.list(r);
            break;
          }
          case "checkbox": {
            t += this.renderer.checkbox(r);
            break;
          }
          case "html": {
            t += this.renderer.html(r);
            break;
          }
          case "def": {
            t += this.renderer.def(r);
            break;
          }
          case "paragraph": {
            t += this.renderer.paragraph(r);
            break;
          }
          case "text": {
            t += this.renderer.text(r);
            break;
          }
          default: {
            let i = 'Token with "' + r.type + '" type was not found.';
            if (this.options.silent) return console.error(i), "";
            throw new Error(i);
          }
        }
      }
      return t;
    }
    parseInline(e, t = this.renderer) {
      this.renderer.parser = this;
      let n = "";
      for (let s = 0; s < e.length; s++) {
        let r = e[s];
        if (this.options.extensions?.renderers?.[r.type]) {
          let o = this.options.extensions.renderers[r.type].call({ parser: this }, r);
          if (o !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
            n += o || "";
            continue;
          }
        }
        let i = r;
        switch (i.type) {
          case "escape": {
            n += t.text(i);
            break;
          }
          case "html": {
            n += t.html(i);
            break;
          }
          case "link": {
            n += t.link(i);
            break;
          }
          case "image": {
            n += t.image(i);
            break;
          }
          case "checkbox": {
            n += t.checkbox(i);
            break;
          }
          case "strong": {
            n += t.strong(i);
            break;
          }
          case "em": {
            n += t.em(i);
            break;
          }
          case "codespan": {
            n += t.codespan(i);
            break;
          }
          case "br": {
            n += t.br(i);
            break;
          }
          case "del": {
            n += t.del(i);
            break;
          }
          case "text": {
            n += t.text(i);
            break;
          }
          default: {
            let o = 'Token with "' + i.type + '" type was not found.';
            if (this.options.silent) return console.error(o), "";
            throw new Error(o);
          }
        }
      }
      return n;
    }
  };
  var _a;
  var P = (_a = class {
    constructor(e) {
      __publicField(this, "options");
      __publicField(this, "block");
      this.options = e || T;
    }
    preprocess(e) {
      return e;
    }
    postprocess(e) {
      return e;
    }
    processAllTokens(e) {
      return e;
    }
    emStrongMask(e) {
      return e;
    }
    provideLexer(e = this.block) {
      return e ? x.lex : x.lexInline;
    }
    provideParser(e = this.block) {
      return e ? b.parse : b.parseInline;
    }
  }, __publicField(_a, "passThroughHooks", /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"])), __publicField(_a, "passThroughHooksRespectAsync", /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"])), _a);
  var q = class {
    constructor(...e) {
      __publicField(this, "defaults", M());
      __publicField(this, "options", this.setOptions);
      __publicField(this, "parse", this.parseMarkdown(true));
      __publicField(this, "parseInline", this.parseMarkdown(false));
      __publicField(this, "Parser", b);
      __publicField(this, "Renderer", y);
      __publicField(this, "TextRenderer", L);
      __publicField(this, "Lexer", x);
      __publicField(this, "Tokenizer", w);
      __publicField(this, "Hooks", P);
      this.use(...e);
    }
    walkTokens(e, t) {
      let n = [];
      for (let s of e) switch (n = n.concat(t.call(this, s)), s.type) {
        case "table": {
          let r = s;
          for (let i of r.header) n = n.concat(this.walkTokens(i.tokens, t));
          for (let i of r.rows) for (let o of i) n = n.concat(this.walkTokens(o.tokens, t));
          break;
        }
        case "list": {
          let r = s;
          n = n.concat(this.walkTokens(r.items, t));
          break;
        }
        default: {
          let r = s;
          this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((i) => {
            let o = r[i].flat(1 / 0);
            n = n.concat(this.walkTokens(o, t));
          }) : r.tokens && (n = n.concat(this.walkTokens(r.tokens, t)));
        }
      }
      return n;
    }
    use(...e) {
      let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
      return e.forEach((n) => {
        let s = { ...n };
        if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((r) => {
          if (!r.name) throw new Error("extension name required");
          if ("renderer" in r) {
            let i = t.renderers[r.name];
            i ? t.renderers[r.name] = function(...o) {
              let u = r.renderer.apply(this, o);
              return u === false && (u = i.apply(this, o)), u;
            } : t.renderers[r.name] = r.renderer;
          }
          if ("tokenizer" in r) {
            if (!r.level || r.level !== "block" && r.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
            let i = t[r.level];
            i ? i.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
          }
          "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
        }), s.extensions = t), n.renderer) {
          let r = this.defaults.renderer || new y(this.defaults);
          for (let i in n.renderer) {
            if (!(i in r)) throw new Error(`renderer '${i}' does not exist`);
            if (["options", "parser"].includes(i)) continue;
            let o = i, u = n.renderer[o], a = r[o];
            r[o] = (...c) => {
              let p = u.apply(r, c);
              return p === false && (p = a.apply(r, c)), p || "";
            };
          }
          s.renderer = r;
        }
        if (n.tokenizer) {
          let r = this.defaults.tokenizer || new w(this.defaults);
          for (let i in n.tokenizer) {
            if (!(i in r)) throw new Error(`tokenizer '${i}' does not exist`);
            if (["options", "rules", "lexer"].includes(i)) continue;
            let o = i, u = n.tokenizer[o], a = r[o];
            r[o] = (...c) => {
              let p = u.apply(r, c);
              return p === false && (p = a.apply(r, c)), p;
            };
          }
          s.tokenizer = r;
        }
        if (n.hooks) {
          let r = this.defaults.hooks || new P();
          for (let i in n.hooks) {
            if (!(i in r)) throw new Error(`hook '${i}' does not exist`);
            if (["options", "block"].includes(i)) continue;
            let o = i, u = n.hooks[o], a = r[o];
            P.passThroughHooks.has(i) ? r[o] = (c) => {
              if (this.defaults.async && P.passThroughHooksRespectAsync.has(i)) return (async () => {
                let k = await u.call(r, c);
                return a.call(r, k);
              })();
              let p = u.call(r, c);
              return a.call(r, p);
            } : r[o] = (...c) => {
              if (this.defaults.async) return (async () => {
                let k = await u.apply(r, c);
                return k === false && (k = await a.apply(r, c)), k;
              })();
              let p = u.apply(r, c);
              return p === false && (p = a.apply(r, c)), p;
            };
          }
          s.hooks = r;
        }
        if (n.walkTokens) {
          let r = this.defaults.walkTokens, i = n.walkTokens;
          s.walkTokens = function(o) {
            let u = [];
            return u.push(i.call(this, o)), r && (u = u.concat(r.call(this, o))), u;
          };
        }
        this.defaults = { ...this.defaults, ...s };
      }), this;
    }
    setOptions(e) {
      return this.defaults = { ...this.defaults, ...e }, this;
    }
    lexer(e, t) {
      return x.lex(e, t ?? this.defaults);
    }
    parser(e, t) {
      return b.parse(e, t ?? this.defaults);
    }
    parseMarkdown(e) {
      return (n, s) => {
        let r = { ...s }, i = { ...this.defaults, ...r }, o = this.onError(!!i.silent, !!i.async);
        if (this.defaults.async === true && r.async === false) return o(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
        if (typeof n > "u" || n === null) return o(new Error("marked(): input parameter is undefined or null"));
        if (typeof n != "string") return o(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
        if (i.hooks && (i.hooks.options = i, i.hooks.block = e), i.async) return (async () => {
          let u = i.hooks ? await i.hooks.preprocess(n) : n, c = await (i.hooks ? await i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(u, i), p = i.hooks ? await i.hooks.processAllTokens(c) : c;
          i.walkTokens && await Promise.all(this.walkTokens(p, i.walkTokens));
          let h = await (i.hooks ? await i.hooks.provideParser(e) : e ? b.parse : b.parseInline)(p, i);
          return i.hooks ? await i.hooks.postprocess(h) : h;
        })().catch(o);
        try {
          i.hooks && (n = i.hooks.preprocess(n));
          let a = (i.hooks ? i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(n, i);
          i.hooks && (a = i.hooks.processAllTokens(a)), i.walkTokens && this.walkTokens(a, i.walkTokens);
          let p = (i.hooks ? i.hooks.provideParser(e) : e ? b.parse : b.parseInline)(a, i);
          return i.hooks && (p = i.hooks.postprocess(p)), p;
        } catch (u) {
          return o(u);
        }
      };
    }
    onError(e, t) {
      return (n) => {
        if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
          let s = "<p>An error occurred:</p><pre>" + O(n.message + "", true) + "</pre>";
          return t ? Promise.resolve(s) : s;
        }
        if (t) return Promise.reject(n);
        throw n;
      };
    }
  };
  var z = new q();
  function g(l3, e) {
    return z.parse(l3, e);
  }
  g.options = g.setOptions = function(l3) {
    return z.setOptions(l3), g.defaults = z.defaults, N(g.defaults), g;
  };
  g.getDefaults = M;
  g.defaults = T;
  g.use = function(...l3) {
    return z.use(...l3), g.defaults = z.defaults, N(g.defaults), g;
  };
  g.walkTokens = function(l3, e) {
    return z.walkTokens(l3, e);
  };
  g.parseInline = z.parseInline;
  g.Parser = b;
  g.parser = b.parse;
  g.Renderer = y;
  g.TextRenderer = L;
  g.Lexer = x;
  g.lexer = x.lex;
  g.Tokenizer = w;
  g.Hooks = P;
  g.parse = g;
  var Ft = g.options;
  var Ut = g.setOptions;
  var Kt = g.use;
  var Wt = g.walkTokens;
  var Xt = g.parseInline;
  var Vt = b.parse;
  var Yt = x.lex;

  // node_modules/get-east-asian-width/lookup-data.js
  var ambiguousMinimalCodePoint = 161;
  var ambiguousMaximumCodePoint = 1114109;
  var ambiguousRanges = [161, 161, 164, 164, 167, 168, 170, 170, 173, 174, 176, 180, 182, 186, 188, 191, 198, 198, 208, 208, 215, 216, 222, 225, 230, 230, 232, 234, 236, 237, 240, 240, 242, 243, 247, 250, 252, 252, 254, 254, 257, 257, 273, 273, 275, 275, 283, 283, 294, 295, 299, 299, 305, 307, 312, 312, 319, 322, 324, 324, 328, 331, 333, 333, 338, 339, 358, 359, 363, 363, 462, 462, 464, 464, 466, 466, 468, 468, 470, 470, 472, 472, 474, 474, 476, 476, 593, 593, 609, 609, 708, 708, 711, 711, 713, 715, 717, 717, 720, 720, 728, 731, 733, 733, 735, 735, 768, 879, 913, 929, 931, 937, 945, 961, 963, 969, 1025, 1025, 1040, 1103, 1105, 1105, 8208, 8208, 8211, 8214, 8216, 8217, 8220, 8221, 8224, 8226, 8228, 8231, 8240, 8240, 8242, 8243, 8245, 8245, 8251, 8251, 8254, 8254, 8308, 8308, 8319, 8319, 8321, 8324, 8364, 8364, 8451, 8451, 8453, 8453, 8457, 8457, 8467, 8467, 8470, 8470, 8481, 8482, 8486, 8486, 8491, 8491, 8531, 8532, 8539, 8542, 8544, 8555, 8560, 8569, 8585, 8585, 8592, 8601, 8632, 8633, 8658, 8658, 8660, 8660, 8679, 8679, 8704, 8704, 8706, 8707, 8711, 8712, 8715, 8715, 8719, 8719, 8721, 8721, 8725, 8725, 8730, 8730, 8733, 8736, 8739, 8739, 8741, 8741, 8743, 8748, 8750, 8750, 8756, 8759, 8764, 8765, 8776, 8776, 8780, 8780, 8786, 8786, 8800, 8801, 8804, 8807, 8810, 8811, 8814, 8815, 8834, 8835, 8838, 8839, 8853, 8853, 8857, 8857, 8869, 8869, 8895, 8895, 8978, 8978, 9312, 9449, 9451, 9547, 9552, 9587, 9600, 9615, 9618, 9621, 9632, 9633, 9635, 9641, 9650, 9651, 9654, 9655, 9660, 9661, 9664, 9665, 9670, 9672, 9675, 9675, 9678, 9681, 9698, 9701, 9711, 9711, 9733, 9734, 9737, 9737, 9742, 9743, 9756, 9756, 9758, 9758, 9792, 9792, 9794, 9794, 9824, 9825, 9827, 9829, 9831, 9834, 9836, 9837, 9839, 9839, 9886, 9887, 9919, 9919, 9926, 9933, 9935, 9939, 9941, 9953, 9955, 9955, 9960, 9961, 9963, 9969, 9972, 9972, 9974, 9977, 9979, 9980, 9982, 9983, 10045, 10045, 10102, 10111, 11094, 11097, 12872, 12879, 57344, 63743, 65024, 65039, 65533, 65533, 127232, 127242, 127248, 127277, 127280, 127337, 127344, 127373, 127375, 127376, 127387, 127404, 917760, 917999, 983040, 1048573, 1048576, 1114109];
  var fullwidthMinimalCodePoint = 12288;
  var fullwidthMaximumCodePoint = 65510;
  var fullwidthRanges = [12288, 12288, 65281, 65376, 65504, 65510];
  var wideMinimalCodePoint = 4352;
  var wideMaximumCodePoint = 262141;
  var wideRanges = [4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141];

  // node_modules/get-east-asian-width/utilities.js
  var isInRange = (ranges, codePoint) => {
    let low = 0;
    let high = Math.floor(ranges.length / 2) - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const i = mid * 2;
      if (codePoint < ranges[i]) {
        high = mid - 1;
      } else if (codePoint > ranges[i + 1]) {
        low = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  };

  // node_modules/get-east-asian-width/lookup.js
  var commonCjkCodePoint = 19968;
  var [wideFastPathStart, wideFastPathEnd] = /* @__PURE__ */ findWideFastPathRange(wideRanges);
  function findWideFastPathRange(ranges) {
    let fastPathStart = ranges[0];
    let fastPathEnd = ranges[1];
    for (let index = 0; index < ranges.length; index += 2) {
      const start = ranges[index];
      const end = ranges[index + 1];
      if (commonCjkCodePoint >= start && commonCjkCodePoint <= end) {
        return [start, end];
      }
      if (end - start > fastPathEnd - fastPathStart) {
        fastPathStart = start;
        fastPathEnd = end;
      }
    }
    return [fastPathStart, fastPathEnd];
  }
  var isAmbiguous = (codePoint) => {
    if (codePoint < ambiguousMinimalCodePoint || codePoint > ambiguousMaximumCodePoint) {
      return false;
    }
    return isInRange(ambiguousRanges, codePoint);
  };
  var isFullWidth = (codePoint) => {
    if (codePoint < fullwidthMinimalCodePoint || codePoint > fullwidthMaximumCodePoint) {
      return false;
    }
    return isInRange(fullwidthRanges, codePoint);
  };
  var isWide = (codePoint) => {
    if (codePoint >= wideFastPathStart && codePoint <= wideFastPathEnd) {
      return true;
    }
    if (codePoint < wideMinimalCodePoint || codePoint > wideMaximumCodePoint) {
      return false;
    }
    return isInRange(wideRanges, codePoint);
  };

  // node_modules/get-east-asian-width/index.js
  function validate(codePoint) {
    if (!Number.isSafeInteger(codePoint)) {
      throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
    }
  }
  function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
    validate(codePoint);
    if (isFullWidth(codePoint) || isWide(codePoint) || ambiguousAsWide && isAmbiguous(codePoint)) {
      return 2;
    }
    return 1;
  }

  // packages/tui/src/utils.ts
  var graphemeSegmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
  var wordSegmenter = new Intl.Segmenter(void 0, { granularity: "word" });
  function couldBeEmoji(segment) {
    const cp = segment.codePointAt(0);
    return cp >= 126976 && cp <= 130047 || // Emoji and Pictograph
    cp >= 8960 && cp <= 9215 || // Misc technical
    cp >= 9728 && cp <= 10175 || // Misc symbols, dingbats
    cp >= 11088 && cp <= 11093 || // Specific stars/circles
    segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
    segment.length > 2;
  }
  var zeroWidthRegex = new RegExp("^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Mark}|\\p{Surrogate})+$", "v");
  var leadingNonPrintingRegex = new RegExp("^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+", "v");
  var nonPrintingCharRegex = new RegExp("^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Mark}|\\p{Surrogate})$", "v");
  var markCharRegex = new RegExp("^\\p{Mark}$", "v");
  var terminalSpacingMarkRegex = new RegExp("^(?:[\\p{Spacing_Mark}--[\\u1734\\u302E\\u302F]]|[\\u065F\\u0F7F\\u102B\\u102C\\u1031\\u1033-\\u1035\\u1038\\u103A-\\u103E])+$", "v");
  var rgiEmojiRegex = new RegExp("^\\p{RGI_Emoji}$", "v");
  var WIDTH_CACHE_SIZE = 512;
  var widthCache = /* @__PURE__ */ new Map();
  var cjkBreakRegex = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
  function isPrintableAscii(str) {
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code < 32 || code > 126) {
        return false;
      }
    }
    return true;
  }
  function graphemeWidth(segment) {
    if (segment === "	") {
      return 3;
    }
    if (terminalSpacingMarkRegex.test(segment)) {
      return [...segment].length;
    }
    if (zeroWidthRegex.test(segment)) {
      return 0;
    }
    if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
      return 2;
    }
    const base = segment.replace(leadingNonPrintingRegex, "");
    const cp = base.codePointAt(0);
    if (cp === void 0) {
      return 0;
    }
    if (cp >= 127462 && cp <= 127487) {
      return 2;
    }
    let width = eastAsianWidth(cp);
    let followsMark = false;
    const chars = [...base];
    for (const char of chars.slice(1)) {
      if (terminalSpacingMarkRegex.test(char)) {
        width += 1;
        followsMark = false;
      } else if (markCharRegex.test(char)) {
        followsMark = true;
      } else if (!nonPrintingCharRegex.test(char)) {
        const c = char.codePointAt(0);
        if (followsMark || c >= 65280 && c <= 65519) {
          width += eastAsianWidth(c);
        } else if (c === 3635 || c === 3763) {
          width += 1;
        }
        followsMark = false;
      }
    }
    return width;
  }
  function visibleWidth(str) {
    if (str.length === 0) {
      return 0;
    }
    if (isPrintableAscii(str)) {
      return str.length;
    }
    const cached = widthCache.get(str);
    if (cached !== void 0) {
      return cached;
    }
    let clean = str;
    if (str.includes("	")) {
      clean = clean.replace(/\t/g, "   ");
    }
    if (clean.includes("\x1B")) {
      let stripped = "";
      let i = 0;
      while (i < clean.length) {
        const ansi = extractAnsiCode(clean, i);
        if (ansi) {
          i += ansi.length;
          continue;
        }
        stripped += clean[i];
        i++;
      }
      clean = stripped;
    }
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(clean)) {
      width += graphemeWidth(segment);
    }
    if (widthCache.size >= WIDTH_CACHE_SIZE) {
      const firstKey = widthCache.keys().next().value;
      if (firstKey !== void 0) {
        widthCache.delete(firstKey);
      }
    }
    widthCache.set(str, width);
    return width;
  }
  function extractAnsiCode(str, pos) {
    if (pos >= str.length || str[pos] !== "\x1B") return null;
    const next = str[pos + 1];
    if (next === "[") {
      let j2 = pos + 2;
      while (j2 < str.length && !/[mGKHJ]/.test(str[j2])) j2++;
      if (j2 < str.length) return { code: str.substring(pos, j2 + 1), length: j2 + 1 - pos };
      return null;
    }
    if (next === "]") {
      let j2 = pos + 2;
      while (j2 < str.length) {
        if (str[j2] === "\x07") return { code: str.substring(pos, j2 + 1), length: j2 + 1 - pos };
        if (str[j2] === "\x1B" && str[j2 + 1] === "\\") return { code: str.substring(pos, j2 + 2), length: j2 + 2 - pos };
        j2++;
      }
      return null;
    }
    if (next === "_") {
      let j2 = pos + 2;
      while (j2 < str.length) {
        if (str[j2] === "\x07") return { code: str.substring(pos, j2 + 1), length: j2 + 1 - pos };
        if (str[j2] === "\x1B" && str[j2 + 1] === "\\") return { code: str.substring(pos, j2 + 2), length: j2 + 2 - pos };
        j2++;
      }
      return null;
    }
    return null;
  }
  function parseOsc8Hyperlink(ansiCode) {
    if (!ansiCode.startsWith("\x1B]8;")) {
      return void 0;
    }
    const terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1B\\";
    const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
    const separatorIndex = body.indexOf(";");
    if (separatorIndex === -1) {
      return void 0;
    }
    const params = body.slice(0, separatorIndex);
    const url = body.slice(separatorIndex + 1);
    if (!url) {
      return null;
    }
    return { params, url, terminator };
  }
  function formatOsc8Hyperlink(hyperlink2) {
    return `\x1B]8;${hyperlink2.params};${hyperlink2.url}${hyperlink2.terminator}`;
  }
  function formatOsc8Close(terminator) {
    return `\x1B]8;;${terminator}`;
  }
  var AnsiCodeTracker = class {
    constructor() {
      // Track individual attributes separately so we can reset them specifically
      this.bold = false;
      this.dim = false;
      this.italic = false;
      this.underline = false;
      this.blink = false;
      this.inverse = false;
      this.hidden = false;
      this.strikethrough = false;
      this.fgColor = null;
      // Stores the full code like "31" or "38;5;240"
      this.bgColor = null;
      // Stores the full code like "41" or "48;5;240"
      this.activeHyperlink = null;
    }
    process(ansiCode) {
      const hyperlink2 = parseOsc8Hyperlink(ansiCode);
      if (hyperlink2 !== void 0) {
        this.activeHyperlink = hyperlink2;
        return;
      }
      if (!ansiCode.endsWith("m")) {
        return;
      }
      const match = ansiCode.match(/\x1b\[([\d;]*)m/);
      if (!match) return;
      const params = match[1];
      if (params === "" || params === "0") {
        this.reset();
        return;
      }
      const parts = params.split(";");
      let i = 0;
      while (i < parts.length) {
        const code = Number.parseInt(parts[i], 10);
        if (code === 38 || code === 48) {
          if (parts[i + 1] === "5" && parts[i + 2] !== void 0) {
            const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
            if (code === 38) {
              this.fgColor = colorCode;
            } else {
              this.bgColor = colorCode;
            }
            i += 3;
            continue;
          } else if (parts[i + 1] === "2" && parts[i + 4] !== void 0) {
            const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
            if (code === 38) {
              this.fgColor = colorCode;
            } else {
              this.bgColor = colorCode;
            }
            i += 5;
            continue;
          }
        }
        switch (code) {
          case 0:
            this.reset();
            break;
          case 1:
            this.bold = true;
            break;
          case 2:
            this.dim = true;
            break;
          case 3:
            this.italic = true;
            break;
          case 4:
            this.underline = true;
            break;
          case 5:
            this.blink = true;
            break;
          case 7:
            this.inverse = true;
            break;
          case 8:
            this.hidden = true;
            break;
          case 9:
            this.strikethrough = true;
            break;
          case 21:
            this.bold = false;
            break;
          case 22:
            this.bold = false;
            this.dim = false;
            break;
          case 23:
            this.italic = false;
            break;
          case 24:
            this.underline = false;
            break;
          case 25:
            this.blink = false;
            break;
          case 27:
            this.inverse = false;
            break;
          case 28:
            this.hidden = false;
            break;
          case 29:
            this.strikethrough = false;
            break;
          case 39:
            this.fgColor = null;
            break;
          case 49:
            this.bgColor = null;
            break;
          default:
            if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
              this.fgColor = String(code);
            } else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) {
              this.bgColor = String(code);
            }
            break;
        }
        i++;
      }
    }
    reset() {
      this.bold = false;
      this.dim = false;
      this.italic = false;
      this.underline = false;
      this.blink = false;
      this.inverse = false;
      this.hidden = false;
      this.strikethrough = false;
      this.fgColor = null;
      this.bgColor = null;
    }
    /** Clear all state for reuse. */
    clear() {
      this.reset();
      this.activeHyperlink = null;
    }
    getActiveCodes() {
      const codes = [];
      if (this.bold) codes.push("1");
      if (this.dim) codes.push("2");
      if (this.italic) codes.push("3");
      if (this.underline) codes.push("4");
      if (this.blink) codes.push("5");
      if (this.inverse) codes.push("7");
      if (this.hidden) codes.push("8");
      if (this.strikethrough) codes.push("9");
      if (this.fgColor) codes.push(this.fgColor);
      if (this.bgColor) codes.push(this.bgColor);
      let result = codes.length > 0 ? `\x1B[${codes.join(";")}m` : "";
      if (this.activeHyperlink) {
        result += formatOsc8Hyperlink(this.activeHyperlink);
      }
      return result;
    }
    hasActiveCodes() {
      return this.bold || this.dim || this.italic || this.underline || this.blink || this.inverse || this.hidden || this.strikethrough || this.fgColor !== null || this.bgColor !== null || this.activeHyperlink !== null;
    }
    /**
     * Get reset codes for attributes that need to be turned off at line end.
     * Underline must be closed to prevent bleeding into padding.
     * Active OSC 8 hyperlinks must be closed and re-opened on the next line.
     * Returns empty string if no attributes need closing.
     */
    getLineEndReset() {
      let result = "";
      if (this.underline) {
        result += "\x1B[24m";
      }
      if (this.activeHyperlink) {
        result += formatOsc8Close(this.activeHyperlink.terminator);
      }
      return result;
    }
  };
  function updateTrackerFromText(text, tracker) {
    let i = 0;
    while (i < text.length) {
      const ansiResult = extractAnsiCode(text, i);
      if (ansiResult) {
        tracker.process(ansiResult.code);
        i += ansiResult.length;
      } else {
        i++;
      }
    }
  }
  function splitIntoTokensWithAnsi(text) {
    const tokens = [];
    let current = "";
    let pendingAnsi = "";
    let currentKind = null;
    let i = 0;
    const flushCurrent = () => {
      if (!current) {
        return;
      }
      tokens.push(current);
      current = "";
      currentKind = null;
    };
    while (i < text.length) {
      const ansiResult = extractAnsiCode(text, i);
      if (ansiResult) {
        pendingAnsi += ansiResult.code;
        i += ansiResult.length;
        continue;
      }
      let end = i;
      while (end < text.length && !extractAnsiCode(text, end)) {
        end++;
      }
      for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
        const segmentIsSpace = segment === " ";
        if (!segmentIsSpace && cjkBreakRegex.test(segment)) {
          flushCurrent();
          const token = pendingAnsi + segment;
          pendingAnsi = "";
          tokens.push(token);
          continue;
        }
        const segmentKind = segmentIsSpace ? "space" : "word";
        if (current && currentKind !== segmentKind) {
          flushCurrent();
        }
        if (pendingAnsi) {
          current += pendingAnsi;
          pendingAnsi = "";
        }
        currentKind = segmentKind;
        current += segment;
      }
      i = end;
    }
    if (pendingAnsi) {
      if (current) {
        current += pendingAnsi;
      } else if (tokens.length > 0) {
        tokens[tokens.length - 1] += pendingAnsi;
      } else {
        current = pendingAnsi;
      }
    }
    if (current) {
      tokens.push(current);
    }
    return tokens;
  }
  function wrapTextWithAnsi(text, width) {
    if (!text) {
      return [""];
    }
    const inputLines = text.split(/\r\n|\r|\n/);
    const result = [];
    const tracker = new AnsiCodeTracker();
    for (const inputLine of inputLines) {
      const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
      const wrappedLines = wrapSingleLine(prefix + inputLine, width);
      for (const wrappedLine of wrappedLines) {
        result.push(wrappedLine);
      }
      updateTrackerFromText(inputLine, tracker);
    }
    return result.length > 0 ? result : [""];
  }
  function wrapSingleLine(line, width) {
    if (!line) {
      return [""];
    }
    const visibleLength = visibleWidth(line);
    if (visibleLength <= width) {
      return [line];
    }
    const wrapped = [];
    const tracker = new AnsiCodeTracker();
    const tokens = splitIntoTokensWithAnsi(line);
    let currentLine = "";
    let currentVisibleLength = 0;
    for (const token of tokens) {
      const tokenVisibleLength = visibleWidth(token);
      const isWhitespace = token.trim() === "";
      if (tokenVisibleLength > width && !isWhitespace) {
        if (currentLine) {
          const lineEndReset = tracker.getLineEndReset();
          if (lineEndReset) {
            currentLine += lineEndReset;
          }
          wrapped.push(currentLine);
          currentLine = "";
          currentVisibleLength = 0;
        }
        const broken = breakLongWord(token, width, tracker);
        for (let i = 0; i < broken.length - 1; i++) {
          wrapped.push(broken[i]);
        }
        currentLine = broken[broken.length - 1];
        currentVisibleLength = visibleWidth(currentLine);
        continue;
      }
      const totalNeeded = currentVisibleLength + tokenVisibleLength;
      if (totalNeeded > width && currentVisibleLength > 0) {
        let lineToWrap = currentLine.trimEnd();
        const lineEndReset = tracker.getLineEndReset();
        if (lineEndReset) {
          lineToWrap += lineEndReset;
        }
        wrapped.push(lineToWrap);
        if (isWhitespace) {
          currentLine = tracker.getActiveCodes();
          currentVisibleLength = 0;
        } else {
          currentLine = tracker.getActiveCodes() + token;
          currentVisibleLength = tokenVisibleLength;
        }
      } else {
        currentLine += token;
        currentVisibleLength += tokenVisibleLength;
      }
      updateTrackerFromText(token, tracker);
    }
    if (currentLine) {
      wrapped.push(currentLine);
    }
    return wrapped.length > 0 ? wrapped.map((line2) => line2.trimEnd()) : [""];
  }
  function breakLongWord(word, width, tracker) {
    const lines = [];
    let currentLine = tracker.getActiveCodes();
    let currentWidth = 0;
    let i = 0;
    const segments = [];
    while (i < word.length) {
      const ansiResult = extractAnsiCode(word, i);
      if (ansiResult) {
        segments.push({ type: "ansi", value: ansiResult.code });
        i += ansiResult.length;
      } else {
        let end = i;
        while (end < word.length) {
          const nextAnsi = extractAnsiCode(word, end);
          if (nextAnsi) break;
          end++;
        }
        const textPortion = word.slice(i, end);
        for (const seg of graphemeSegmenter.segment(textPortion)) {
          segments.push({ type: "grapheme", value: seg.segment });
        }
        i = end;
      }
    }
    for (const seg of segments) {
      if (seg.type === "ansi") {
        currentLine += seg.value;
        tracker.process(seg.value);
        continue;
      }
      const grapheme = seg.value;
      if (!grapheme) continue;
      const graphemeWidth2 = visibleWidth(grapheme);
      if (currentWidth + graphemeWidth2 > width) {
        const lineEndReset = tracker.getLineEndReset();
        if (lineEndReset) {
          currentLine += lineEndReset;
        }
        lines.push(currentLine);
        currentLine = tracker.getActiveCodes();
        currentWidth = 0;
      }
      currentLine += grapheme;
      currentWidth += graphemeWidth2;
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines.length > 0 ? lines : [""];
  }
  function applyBackgroundToLine(line, width, bgFn) {
    const visibleLen = visibleWidth(line);
    const paddingNeeded = Math.max(0, width - visibleLen);
    const padding = " ".repeat(paddingNeeded);
    const withPadding = line + padding;
    return bgFn(withPadding);
  }
  var pooledStyleTracker = new AnsiCodeTracker();

  // packages/tui/src/latex.ts
  var SYMBOLS = {
    alpha: "\u03B1",
    beta: "\u03B2",
    gamma: "\u03B3",
    delta: "\u03B4",
    epsilon: "\u03F5",
    varepsilon: "\u03B5",
    zeta: "\u03B6",
    eta: "\u03B7",
    theta: "\u03B8",
    vartheta: "\u03D1",
    iota: "\u03B9",
    kappa: "\u03BA",
    varkappa: "\u03F0",
    lambda: "\u03BB",
    mu: "\u03BC",
    nu: "\u03BD",
    xi: "\u03BE",
    pi: "\u03C0",
    varpi: "\u03D6",
    rho: "\u03C1",
    varrho: "\u03F1",
    sigma: "\u03C3",
    varsigma: "\u03C2",
    tau: "\u03C4",
    upsilon: "\u03C5",
    phi: "\u03D5",
    varphi: "\u03C6",
    chi: "\u03C7",
    psi: "\u03C8",
    omega: "\u03C9",
    Gamma: "\u0393",
    Delta: "\u0394",
    Theta: "\u0398",
    Lambda: "\u039B",
    Xi: "\u039E",
    Pi: "\u03A0",
    Sigma: "\u03A3",
    Upsilon: "\u03A5",
    Phi: "\u03A6",
    Psi: "\u03A8",
    Omega: "\u03A9",
    pm: "\xB1",
    mp: "\u2213",
    times: "\xD7",
    div: "\xF7",
    cdot: "\xB7",
    ast: "\u2217",
    star: "\u22C6",
    circ: "\u2218",
    bullet: "\u2022",
    oplus: "\u2295",
    ominus: "\u2296",
    otimes: "\u2297",
    oslash: "\u2298",
    odot: "\u2299",
    bigcirc: "\u25CB",
    dagger: "\u2020",
    ddagger: "\u2021",
    amalg: "\u2A3F",
    uplus: "\u228E",
    sqcap: "\u2293",
    sqcup: "\u2294",
    triangleleft: "\u25C1",
    triangleright: "\u25B7",
    wr: "\u2240",
    cap: "\u2229",
    cup: "\u222A",
    bigcap: "\u22C2",
    bigcup: "\u22C3",
    bigwedge: "\u22C0",
    bigvee: "\u22C1",
    bigsqcup: "\u2A06",
    biguplus: "\u2A04",
    bigoplus: "\u2A01",
    bigotimes: "\u2A02",
    bigodot: "\u2A00",
    setminus: "\u2216",
    in: "\u2208",
    notin: "\u2209",
    ni: "\u220B",
    subset: "\u2282",
    supset: "\u2283",
    subseteq: "\u2286",
    supseteq: "\u2287",
    sqsubset: "\u228F",
    sqsupset: "\u2290",
    sqsubseteq: "\u2291",
    sqsupseteq: "\u2292",
    prec: "\u227A",
    preceq: "\u227C",
    succ: "\u227B",
    succeq: "\u227D",
    ll: "\u226A",
    gg: "\u226B",
    le: "\u2264",
    leq: "\u2264",
    leqslant: "\u2264",
    ge: "\u2265",
    geq: "\u2265",
    geqslant: "\u2265",
    ne: "\u2260",
    neq: "\u2260",
    equiv: "\u2261",
    approx: "\u2248",
    sim: "\u223C",
    simeq: "\u2243",
    cong: "\u2245",
    asymp: "\u224D",
    doteq: "\u2250",
    propto: "\u221D",
    parallel: "\u2225",
    perp: "\u22A5",
    mid: "\u2223",
    vdash: "\u22A2",
    dashv: "\u22A3",
    models: "\u22A8",
    Vdash: "\u22A9",
    Vvdash: "\u22AA",
    nvdash: "\u22AC",
    nvDash: "\u22AD",
    forall: "\u2200",
    exists: "\u2203",
    nexists: "\u2204",
    neg: "\xAC",
    land: "\u2227",
    wedge: "\u2227",
    lor: "\u2228",
    vee: "\u2228",
    to: "\u2192",
    rightarrow: "\u2192",
    longrightarrow: "\u2192",
    leftarrow: "\u2190",
    longleftarrow: "\u2190",
    gets: "\u2190",
    leftrightarrow: "\u2194",
    longleftrightarrow: "\u2194",
    hookleftarrow: "\u21A9",
    hookrightarrow: "\u21AA",
    twoheadleftarrow: "\u219E",
    twoheadrightarrow: "\u21A0",
    leftharpoonup: "\u21BC",
    leftharpoondown: "\u21BD",
    rightharpoonup: "\u21C0",
    rightharpoondown: "\u21C1",
    rightleftharpoons: "\u21CC",
    leftrightharpoons: "\u21CB",
    nearrow: "\u2197",
    searrow: "\u2198",
    swarrow: "\u2199",
    nwarrow: "\u2196",
    rightsquigarrow: "\u21DD",
    leadsto: "\u21DD",
    Rightarrow: "\u21D2",
    Longrightarrow: "\u21D2",
    Leftarrow: "\u21D0",
    Longleftarrow: "\u21D0",
    Leftrightarrow: "\u21D4",
    Longleftrightarrow: "\u21D4",
    implies: "\u21D2",
    iff: "\u21D4",
    mapsto: "\u21A6",
    longmapsto: "\u21A6",
    uparrow: "\u2191",
    downarrow: "\u2193",
    partial: "\u2202",
    nabla: "\u2207",
    int: "\u222B",
    iint: "\u222C",
    iiint: "\u222D",
    oint: "\u222E",
    sum: "\u2211",
    prod: "\u220F",
    coprod: "\u2210",
    infty: "\u221E",
    emptyset: "\u2205",
    varnothing: "\u2205",
    angle: "\u2220",
    therefore: "\u2234",
    because: "\u2235",
    aleph: "\u2135",
    beth: "\u2136",
    gimel: "\u2137",
    daleth: "\u2138",
    top: "\u22A4",
    bot: "\u22A5",
    triangle: "\u25B3",
    square: "\u25A1",
    lozenge: "\u25CA",
    checkmark: "\u2713",
    complement: "\u2201",
    wp: "\u2118",
    prime: "\u2032",
    ldots: "\u2026",
    dots: "\u2026",
    cdots: "\u22EF",
    vdots: "\u22EE",
    ddots: "\u22F1",
    ell: "\u2113",
    hbar: "\u210F",
    Im: "\u2111",
    Re: "\u211C",
    langle: "\u27E8",
    rangle: "\u27E9",
    vert: "|",
    lvert: "|",
    rvert: "|",
    Vert: "\u2016",
    lVert: "\u2016",
    rVert: "\u2016",
    lbrace: "{",
    rbrace: "}",
    backslash: "\\",
    lfloor: "\u230A",
    rfloor: "\u230B",
    lceil: "\u2308",
    rceil: "\u2309",
    colon: ":"
  };
  var NAMED_OPERATORS = /* @__PURE__ */ new Set([
    "arccos",
    "arcsin",
    "arctan",
    "arg",
    "cos",
    "cosh",
    "cot",
    "coth",
    "csc",
    "deg",
    "det",
    "dim",
    "exp",
    "gcd",
    "hom",
    "inf",
    "ker",
    "lg",
    "lim",
    "liminf",
    "limsup",
    "ln",
    "log",
    "max",
    "min",
    "Pr",
    "sec",
    "sin",
    "sinh",
    "sup",
    "tan",
    "tanh"
  ]);
  var LIMIT_OPERATORS = /* @__PURE__ */ new Set([
    "argmax",
    "argmin",
    "inf",
    "injlim",
    "lim",
    "liminf",
    "limsup",
    "max",
    "min",
    "projlim",
    "sup"
  ]);
  var DISPLAY_LIMIT_SYMBOLS = /* @__PURE__ */ new Set([
    "bigcap",
    "bigcup",
    "bigodot",
    "bigoplus",
    "bigotimes",
    "bigsqcup",
    "biguplus",
    "bigvee",
    "bigwedge",
    "coprod",
    "int",
    "iint",
    "iiint",
    "oint",
    "prod",
    "sum"
  ]);
  var RELATION_COMMANDS = /* @__PURE__ */ new Set([
    "Leftarrow",
    "Leftrightarrow",
    "Longleftarrow",
    "Longleftrightarrow",
    "Longrightarrow",
    "Rightarrow",
    "Vdash",
    "Vvdash",
    "approx",
    "asymp",
    "cong",
    "dashv",
    "doteq",
    "downarrow",
    "equiv",
    "ge",
    "geq",
    "geqslant",
    "gets",
    "gg",
    "hookleftarrow",
    "hookrightarrow",
    "iff",
    "implies",
    "in",
    "leadsto",
    "le",
    "leftarrow",
    "leftharpoondown",
    "leftharpoonup",
    "leftrightarrow",
    "leftrightharpoons",
    "leq",
    "leqslant",
    "ll",
    "longleftarrow",
    "longleftrightarrow",
    "longmapsto",
    "longrightarrow",
    "mapsto",
    "mid",
    "models",
    "ne",
    "nearrow",
    "neq",
    "ni",
    "notin",
    "nvdash",
    "nvDash",
    "nwarrow",
    "parallel",
    "perp",
    "prec",
    "preceq",
    "propto",
    "rightharpoondown",
    "rightharpoonup",
    "rightleftharpoons",
    "rightarrow",
    "rightsquigarrow",
    "searrow",
    "sim",
    "simeq",
    "sqsubset",
    "sqsubseteq",
    "sqsupset",
    "sqsupseteq",
    "subset",
    "subseteq",
    "succ",
    "succeq",
    "supset",
    "supseteq",
    "swarrow",
    "to",
    "triangleleft",
    "triangleright",
    "twoheadleftarrow",
    "twoheadrightarrow",
    "uparrow",
    "vdash"
  ]);
  var NEGATED_SYMBOLS = {
    "<": "\u226E",
    ">": "\u226F",
    "=": "\u2260",
    "\u2208": "\u2209",
    "\u220B": "\u220C",
    "\u2223": "\u2224",
    "\u2225": "\u2226",
    "\u223C": "\u2241",
    "\u2243": "\u2244",
    "\u2245": "\u2247",
    "\u2248": "\u2249",
    "\u2261": "\u2262",
    "\u2264": "\u2270",
    "\u2265": "\u2271",
    "\u227A": "\u2280",
    "\u227B": "\u2281",
    "\u2282": "\u2284",
    "\u2283": "\u2285",
    "\u2286": "\u2288",
    "\u2287": "\u2289",
    "\u22A2": "\u22AC",
    "\u22A8": "\u22AD",
    "\u2194": "\u21AE",
    "\u2190": "\u219A",
    "\u2192": "\u219B",
    "\u21D2": "\u21CF",
    "\u21D0": "\u21CD",
    "\u21D4": "\u21CE",
    "\u227C": "\u22E0",
    "\u227D": "\u22E1"
  };
  var BLACKBOARD = {
    C: "\u2102",
    H: "\u210D",
    N: "\u2115",
    P: "\u2119",
    Q: "\u211A",
    R: "\u211D",
    Z: "\u2124"
  };
  var SUPERSCRIPTS = {
    "0": "\u2070",
    "1": "\xB9",
    "2": "\xB2",
    "3": "\xB3",
    "4": "\u2074",
    "5": "\u2075",
    "6": "\u2076",
    "7": "\u2077",
    "8": "\u2078",
    "9": "\u2079",
    "+": "\u207A",
    "-": "\u207B",
    "=": "\u207C",
    "(": "\u207D",
    ")": "\u207E",
    a: "\u1D43",
    b: "\u1D47",
    c: "\u1D9C",
    d: "\u1D48",
    e: "\u1D49",
    f: "\u1DA0",
    g: "\u1D4D",
    h: "\u02B0",
    i: "\u2071",
    j: "\u02B2",
    k: "\u1D4F",
    l: "\u02E1",
    m: "\u1D50",
    n: "\u207F",
    o: "\u1D52",
    p: "\u1D56",
    r: "\u02B3",
    s: "\u02E2",
    t: "\u1D57",
    u: "\u1D58",
    v: "\u1D5B",
    w: "\u02B7",
    x: "\u02E3",
    y: "\u02B8",
    z: "\u1DBB"
  };
  var SUBSCRIPTS = {
    "0": "\u2080",
    "1": "\u2081",
    "2": "\u2082",
    "3": "\u2083",
    "4": "\u2084",
    "5": "\u2085",
    "6": "\u2086",
    "7": "\u2087",
    "8": "\u2088",
    "9": "\u2089",
    "+": "\u208A",
    "-": "\u208B",
    "=": "\u208C",
    "(": "\u208D",
    ")": "\u208E",
    a: "\u2090",
    e: "\u2091",
    h: "\u2095",
    i: "\u1D62",
    j: "\u2C7C",
    k: "\u2096",
    l: "\u2097",
    m: "\u2098",
    n: "\u2099",
    o: "\u2092",
    p: "\u209A",
    r: "\u1D63",
    s: "\u209B",
    t: "\u209C",
    u: "\u1D64",
    v: "\u1D65",
    x: "\u2093"
  };
  var SPACING_COMMANDS = /* @__PURE__ */ new Set([
    ",",
    ":",
    ";",
    " ",
    ">",
    "enspace",
    "enskip",
    "medspace",
    "quad",
    "qquad",
    "thickspace",
    "thinspace"
  ]);
  var NEGATIVE_SPACING_COMMANDS = /* @__PURE__ */ new Set(["!", "negmedspace", "negthickspace", "negthinspace"]);
  var NEGATIVE_SPACE = "\0";
  var IGNORED_COMMANDS = /* @__PURE__ */ new Set([
    "displaystyle",
    "limits",
    "nolimits",
    "scriptstyle",
    "scriptscriptstyle",
    "textstyle"
  ]);
  var SIZE_COMMANDS = /* @__PURE__ */ new Set([
    "big",
    "Big",
    "bigg",
    "Bigg",
    "bigl",
    "Bigl",
    "biggl",
    "Biggl",
    "bigr",
    "Bigr",
    "biggr",
    "Biggr"
  ]);
  var PLAIN_WRAPPERS = /* @__PURE__ */ new Set([
    "emph",
    "mathcal",
    "mathbf",
    "mathfrak",
    "mathit",
    "mathrm",
    "mathnormal",
    "mathscr",
    "mathsf",
    "mathtt",
    "mathup",
    "mbox",
    "overbrace",
    "pmb",
    "smash",
    "substack",
    "text",
    "textbf",
    "textit",
    "textmd",
    "textnormal",
    "textrm",
    "textsc",
    "textsf",
    "textsl",
    "texttt",
    "textup",
    "underbrace",
    "bm",
    "boldsymbol"
  ]);
  var ACCENTS = {
    acute: "\u0301",
    bar: "\u0305",
    breve: "\u0306",
    check: "\u030C",
    ddot: "\u0308",
    dot: "\u0307",
    grave: "\u0300",
    hat: "\u0302",
    mathring: "\u030A",
    overleftarrow: "\u20D6",
    overleftrightarrow: "\u20E1",
    overline: "\u0305",
    overrightarrow: "\u20D7",
    tilde: "\u0303",
    underline: "\u0332",
    vec: "\u20D7",
    widehat: "\u0302",
    widetilde: "\u0303"
  };
  function replaceCharacters(value, replacements) {
    let result = "";
    for (const character of value) {
      const replacement = replacements[character];
      if (replacement === void 0) {
        return void 0;
      }
      result += replacement;
    }
    return result;
  }
  function formatScript(value, kind) {
    value = value.trim();
    const replacements = kind === "sub" ? SUBSCRIPTS : SUPERSCRIPTS;
    const unicode = replaceCharacters(value.replace(/\s*([=+-])\s*/g, "$1"), replacements);
    if (unicode !== void 0) {
      return unicode;
    }
    const prefix = kind === "sub" ? "_" : "^";
    if (Array.from(value).length === 1 || kind === "sub" && /^[A-Za-z]+$/.test(value)) {
      return `${prefix}${value}`;
    }
    return `${prefix}(${value})`;
  }
  function formatFraction(numerator, denominator) {
    numerator = numerator.trim();
    denominator = denominator.trim();
    const simpleNumerator = /^[\p{L}\p{N}.]+$/u.test(numerator);
    const simpleDenominator = /^[\p{N}.]+$/u.test(denominator) || Array.from(denominator).length === 1;
    return `${simpleNumerator ? numerator : `(${numerator})`}/${simpleDenominator ? denominator : `(${denominator})`}`;
  }
  function formatRoot(value, symbol = "\u221A") {
    value = value.trim();
    return /^[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`;
  }
  var NAMED_OPERATOR_START = "\u{F0004}";
  var NAMED_OPERATOR_END = "\u{F0005}";
  var NAMED_OPERATOR_LEFT_SPACING_PATTERN = /(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu;
  var NAMED_OPERATOR_RIGHT_SPACING_PATTERN = /\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu;
  function normalizeOutput(value) {
    return value.replace(NAMED_OPERATOR_LEFT_SPACING_PATTERN, " ").replaceAll(NAMED_OPERATOR_START, "").replace(NAMED_OPERATOR_RIGHT_SPACING_PATTERN, " ").replaceAll(NAMED_OPERATOR_END, "").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter((line, index, lines) => line.length > 0 || index > 0 && index < lines.length - 1).join("\n").trim();
  }
  var LAYOUT_MARKER_START = "\u{F0000}";
  var LAYOUT_MARKER_END = "\u{F0001}";
  var LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
  var TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
  var PROTECTED_SPACE = "\u{F0002}";
  function padLayoutLine(line, width, centered = false) {
    const padding = Math.max(0, width - visibleWidth(line));
    const left = centered ? Math.floor(padding / 2) : 0;
    return `${" ".repeat(left)}${line}${" ".repeat(padding - left)}`;
  }
  function joinLayouts(layouts) {
    if (layouts.length === 0) {
      return { lines: [""], width: 0, baseline: 0 };
    }
    const baseline = Math.max(...layouts.map((layout) => layout.baseline));
    const below = Math.max(...layouts.map((layout) => layout.lines.length - layout.baseline - 1));
    const lines = [];
    for (let row = 0; row <= baseline + below; row++) {
      let line = "";
      for (const layout of layouts) {
        const sourceRow = row - baseline + layout.baseline;
        line += sourceRow >= 0 && sourceRow < layout.lines.length ? padLayoutLine(layout.lines[sourceRow] ?? "", layout.width) : " ".repeat(layout.width);
      }
      lines.push(line.trimEnd());
    }
    return {
      lines,
      width: layouts.reduce((width, layout) => width + layout.width, 0),
      baseline
    };
  }
  function renderLayout(source, nodes) {
    const renderedLines = [];
    let firstBaseline = 0;
    for (const sourceLine of source.split("\n")) {
      const layouts = [];
      let position = 0;
      let previousNode;
      for (const match of sourceLine.matchAll(LAYOUT_MARKER_PATTERN)) {
        const index = match.index;
        const node = nodes[Number(match[1])];
        if (!node) {
          continue;
        }
        if (index > position) {
          const sliced = sourceLine.slice(position, index);
          const trimmed = (previousNode ? sliced.trimStart() : sliced).trimEnd();
          const preserveLeadingSpace = previousNode?.type === "matrix" && /^\s/.test(sliced);
          const preserveTrailingSpace = node.type === "matrix" && /\s$/.test(sliced);
          const text = trimmed ? `${preserveLeadingSpace ? " " : ""}${trimmed}${preserveTrailingSpace ? " " : ""}` : preserveLeadingSpace || preserveTrailingSpace ? " " : "";
          layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
        }
        if (node.type === "fraction") {
          const numerator = renderLayout(node.numerator, nodes);
          const denominator = renderLayout(node.denominator, nodes);
          const contentWidth = Math.max(numerator.width, denominator.width, 1);
          const width = contentWidth + 2;
          layouts.push({
            lines: [
              ...numerator.lines.map((line) => padLayoutLine(line, width, true)),
              ` ${"\u2500".repeat(contentWidth)} `,
              ...denominator.lines.map((line) => padLayoutLine(line, width, true))
            ],
            width,
            baseline: numerator.lines.length
          });
        } else if (node.type === "operator") {
          const contentWidth = Math.max(
            visibleWidth(node.operator),
            node.lower === void 0 ? 0 : visibleWidth(node.lower),
            node.upper === void 0 ? 0 : visibleWidth(node.upper)
          );
          const lines = [];
          if (node.upper !== void 0) {
            lines.push(`${padLayoutLine(node.upper, contentWidth, true)} `);
          }
          lines.push(`${padLayoutLine(node.operator, contentWidth, true)} `);
          if (node.lower !== void 0) {
            lines.push(`${padLayoutLine(node.lower, contentWidth, true)} `);
          }
          layouts.push({
            lines,
            width: contentWidth + 1,
            baseline: node.upper === void 0 ? 0 : 1
          });
        } else {
          const width = Math.max(0, ...node.lines.map((line) => visibleWidth(line)));
          layouts.push({
            lines: node.lines.map((line) => padLayoutLine(line, width)),
            width,
            baseline: node.baseline
          });
        }
        position = index + match[0].length;
        previousNode = node;
      }
      if (position < sourceLine.length) {
        const sliced = sourceLine.slice(position);
        const trimmed = previousNode ? sliced.trimStart() : sliced;
        const text = previousNode?.type === "matrix" && /^\s/.test(sliced) ? ` ${trimmed}` : trimmed;
        layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
      }
      const lineLayout = joinLayouts(layouts);
      if (renderedLines.length === 0) {
        firstBaseline = lineLayout.baseline;
      }
      renderedLines.push(...lineLayout.lines);
    }
    return {
      lines: renderedLines,
      width: Math.max(0, ...renderedLines.map((line) => visibleWidth(line))),
      baseline: firstBaseline
    };
  }
  var LatexParser = class _LatexParser {
    constructor(source, layoutNodes, display) {
      this.position = 0;
      this.supported = true;
      this.stackFractions = true;
      this.source = source;
      this.layoutNodes = layoutNodes;
      this.display = display;
    }
    render() {
      const rendered = this.parseSequence();
      if (!this.supported || this.position !== this.source.length) {
        return void 0;
      }
      return normalizeOutput(rendered);
    }
    parseSequence(endCharacter) {
      let result = "";
      while (this.position < this.source.length) {
        const character = this.source[this.position];
        if (endCharacter && character === endCharacter) {
          this.position++;
          return result;
        }
        if (character === "}") {
          this.supported = false;
          return result;
        }
        if (character === "{") {
          this.position++;
          result += this.parseSequence("}");
          continue;
        }
        if (character === "\\") {
          const command = this.parseCommand();
          if (command === NEGATIVE_SPACE) {
            result = result.trimEnd();
            if (result.endsWith(NAMED_OPERATOR_END)) {
              result = result.slice(0, -NAMED_OPERATOR_END.length);
            }
          } else {
            result += command;
          }
          continue;
        }
        if (character === "^" || character === "_") {
          this.position++;
          result = result.trimEnd();
          const script = formatScript(this.parseRequiredArgument(false), character === "_" ? "sub" : "sup");
          if (result.endsWith(NAMED_OPERATOR_END)) {
            result = `${result.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`;
          } else {
            result += script;
          }
          continue;
        }
        if (/\s/.test(character)) {
          result += this.parseWhitespace();
          continue;
        }
        if (character === "=" || character === "<" || character === ">") {
          result = `${result.trimEnd()} ${character} `;
          this.position++;
          continue;
        }
        if (character === "&") {
          this.position++;
          continue;
        }
        if (character === "~") {
          this.position++;
          result += " ";
          continue;
        }
        if (character === ".") {
          const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
          const node = marker ? this.layoutNodes[Number(marker[1])] : void 0;
          if (node?.type === "matrix") {
            const lastLine = node.lines.length - 1;
            node.lines[lastLine] = `${node.lines[lastLine] ?? ""}${character}`;
            this.position++;
            continue;
          }
        }
        result += character;
        this.position++;
      }
      if (endCharacter) {
        this.supported = false;
      }
      return result;
    }
    parseWhitespace() {
      while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
        this.position++;
      }
      return " ";
    }
    parseCommand() {
      this.position++;
      if (this.position >= this.source.length) {
        this.supported = false;
        return "";
      }
      let command = "";
      const first = this.source[this.position] ?? "";
      if (first === "\n" || first === "\r") {
        this.position++;
        if (first === "\r" && this.source[this.position] === "\n") {
          this.position++;
        }
        return " ";
      }
      if (/[A-Za-z]/.test(first)) {
        const start = this.position;
        while (this.position < this.source.length && /[A-Za-z]/.test(this.source[this.position] ?? "")) {
          this.position++;
        }
        command = this.source.slice(start, this.position);
      } else {
        command = first;
        this.position++;
      }
      if (command === "\\") {
        return "\n";
      }
      if (SPACING_COMMANDS.has(command)) {
        return " ";
      }
      if (NEGATIVE_SPACING_COMMANDS.has(command)) {
        return NEGATIVE_SPACE;
      }
      if (IGNORED_COMMANDS.has(command)) {
        return "";
      }
      if (command === "{" || command === "}" || command === "$" || command === "%" || command === "#" || command === "_" || command === "&") {
        return command;
      }
      if (command === "|") {
        return "\u2016";
      }
      if (command === "not") {
        const value = this.parseRequiredArgument(false).trim();
        const negated = NEGATED_SYMBOLS[value];
        if (negated !== void 0) {
          return ` ${negated} `;
        }
        const characters = Array.from(value);
        if (characters.length === 0) {
          this.supported = false;
          return "";
        }
        return ` ${characters[0]}\u0338${characters.slice(1).join("")} `;
      }
      if (LIMIT_OPERATORS.has(command)) {
        return this.parseOperator(command, "bracket", true, true);
      }
      const symbol = SYMBOLS[command];
      if (symbol !== void 0) {
        if (DISPLAY_LIMIT_SYMBOLS.has(command)) {
          return this.parseOperator(symbol, "script", true);
        }
        return command === "cdot" || command === "times" || RELATION_COMMANDS.has(command) ? ` ${symbol} ` : symbol;
      }
      if (NAMED_OPERATORS.has(command)) {
        return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
      }
      if (SIZE_COMMANDS.has(command)) {
        return "";
      }
      if (command === "left" || command === "middle" || command === "right") {
        if (this.source[this.position] === ".") {
          this.position++;
        }
        return "";
      }
      if (command === "frac" || command === "dfrac" || command === "tfrac") {
        const shouldStack = this.display && this.stackFractions && command !== "tfrac";
        const numerator = this.parseRequiredArgument(!shouldStack);
        const denominator = this.parseRequiredArgument(!shouldStack);
        if (shouldStack) {
          const index = this.layoutNodes.push({
            type: "fraction",
            numerator: normalizeOutput(numerator),
            denominator: normalizeOutput(denominator)
          }) - 1;
          return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
        }
        return formatFraction(numerator, denominator);
      }
      if (command === "sqrt") {
        const degree = this.parseOptionalArgument()?.trim();
        const value = this.parseRequiredArgument();
        if (degree === void 0 || degree === "2") {
          return formatRoot(value);
        }
        if (degree === "3") {
          return formatRoot(value, "\u221B");
        }
        if (degree === "4") {
          return formatRoot(value, "\u221C");
        }
        return `${formatScript(degree, "sup")}${formatRoot(value)}`;
      }
      if (command === "boxed" || command === "fbox") {
        return `[${this.parseRequiredArgument().trim()}]`;
      }
      if (command === "binom" || command === "dbinom" || command === "tbinom") {
        return `(${this.parseRequiredArgument()} choose ${this.parseRequiredArgument()})`;
      }
      const accent = ACCENTS[command];
      if (accent !== void 0) {
        const value = this.parseRequiredArgument();
        return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
      }
      if (command === "mathbb") {
        const value = this.parseRequiredArgument();
        return Array.from(value, (character) => BLACKBOARD[character] ?? character).join("");
      }
      if (command === "operatorname") {
        const starred = this.source[this.position] === "*";
        if (starred) {
          this.position++;
        }
        const operator = normalizeOutput(this.parseRequiredArgument()).trim();
        return this.parseOperator(operator, "bracket", starred, true);
      }
      if (command === "mod" || command === "bmod") {
        return " mod ";
      }
      if (command === "pmod" || command === "pod") {
        const value = this.parseRequiredArgument().trim();
        return command === "pmod" ? ` (mod ${value})` : ` (${value})`;
      }
      if (command === "overset" || command === "stackrel") {
        const upper = this.parseRequiredArgument();
        const value = this.parseRequiredArgument().trim();
        return `${value}${formatScript(upper, "sup")}`;
      }
      if (command === "underset") {
        const lower = this.parseRequiredArgument();
        const value = this.parseRequiredArgument().trim();
        return `${value}${formatScript(lower, "sub")}`;
      }
      if (PLAIN_WRAPPERS.has(command)) {
        const value = this.parseRequiredArgument();
        return command.startsWith("text") || command === "mbox" ? value : value.trim();
      }
      if (command === "begin") {
        return this.parseEnvironment();
      }
      if (command === "end") {
        this.supported = false;
        return "";
      }
      this.supported = false;
      return `\\${command}`;
    }
    parseOperator(operator, inlineLowerStyle, displayLimits, spaced = false) {
      let useDisplayLimits = displayLimits;
      let modifierPosition = this.position;
      while (modifierPosition < this.source.length && /[ \t]/.test(this.source[modifierPosition] ?? "")) {
        modifierPosition++;
      }
      const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(modifierPosition));
      if (modifier) {
        useDisplayLimits = modifier[1] === "limits";
        this.position = modifierPosition + modifier[0].length;
      }
      let lower;
      let upper;
      while (true) {
        let scriptPosition = this.position;
        while (scriptPosition < this.source.length && /[ \t]/.test(this.source[scriptPosition] ?? "")) {
          scriptPosition++;
        }
        const kind = this.source[scriptPosition];
        if (kind !== "_" && kind !== "^") {
          break;
        }
        this.position = scriptPosition + 1;
        const value = normalizeOutput(this.parseRequiredArgument(false)).replaceAll(" ", "");
        if (kind === "_") {
          if (lower !== void 0) {
            this.supported = false;
          }
          lower = value;
        } else {
          if (upper !== void 0) {
            this.supported = false;
          }
          upper = value;
        }
      }
      if (this.display && useDisplayLimits && (lower !== void 0 || upper !== void 0)) {
        const index = this.layoutNodes.push({ type: "operator", operator, lower, upper }) - 1;
        return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
      }
      let rendered = operator;
      if (lower !== void 0) {
        rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
      }
      if (upper !== void 0) {
        rendered += formatScript(upper, "sup");
      }
      return spaced ? ` ${rendered} ` : rendered;
    }
    parseRequiredArgument(stackFractions = true) {
      const previousStackFractions = this.stackFractions;
      this.stackFractions = previousStackFractions && stackFractions;
      const value = this.parseRequiredArgumentValue();
      this.stackFractions = previousStackFractions;
      return value;
    }
    parseRequiredArgumentValue() {
      while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
        this.position++;
      }
      if (this.position >= this.source.length) {
        this.supported = false;
        return "";
      }
      if (this.source[this.position] === "{") {
        this.position++;
        return this.parseSequence("}");
      }
      if (this.source[this.position] === "\\") {
        return this.parseCommand();
      }
      const value = this.source[this.position] ?? "";
      this.position++;
      return value;
    }
    parseOptionalArgument() {
      while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
        this.position++;
      }
      if (this.source[this.position] !== "[") {
        return void 0;
      }
      const end = this.source.indexOf("]", this.position + 1);
      if (end < 0) {
        this.supported = false;
        return void 0;
      }
      const value = this.source.slice(this.position + 1, end);
      this.position = end + 1;
      return this.renderNested(value);
    }
    readRawGroup() {
      while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
        this.position++;
      }
      if (this.source[this.position] !== "{") {
        this.supported = false;
        return void 0;
      }
      const start = ++this.position;
      let depth = 1;
      while (this.position < this.source.length) {
        const character = this.source[this.position];
        if (character === "\\") {
          this.position += 2;
          continue;
        }
        if (character === "{") depth++;
        if (character === "}") depth--;
        if (depth === 0) {
          const value = this.source.slice(start, this.position);
          this.position++;
          return value;
        }
        this.position++;
      }
      this.supported = false;
      return void 0;
    }
    splitEnvironmentRows(body) {
      return body.split(/\\\\(?:\[[^\]\n]*\])?/);
    }
    parseEnvironment() {
      const environment = this.readRawGroup();
      if (!environment) {
        return "";
      }
      const endMarker = `\\end{${environment}}`;
      const end = this.source.indexOf(endMarker, this.position);
      if (end < 0) {
        this.supported = false;
        return "";
      }
      const body = this.source.slice(this.position, end);
      this.position = end + endMarker.length;
      if (environment === "equation" || environment === "equation*" || environment === "displaymath") {
        return this.renderNested(body).trim();
      }
      if (environment === "aligned" || environment === "align" || environment === "align*" || environment === "alignedat" || environment === "alignat" || environment === "alignat*" || environment === "gather" || environment === "gathered" || environment === "multline" || environment === "multline*" || environment === "split") {
        const alignedAt = ["alignedat", "alignat", "alignat*"].includes(environment);
        const alignedBody = alignedAt ? body.replace(/^\s*\{[^}]*\}/, "") : body;
        return this.splitEnvironmentRows(alignedBody).map((row) => {
          const cells = row.split("&");
          const source = alignedAt ? Array.from(
            { length: Math.ceil(cells.length / 2) },
            (_2, index) => cells.slice(index * 2, index * 2 + 2).join("")
          ).join(" ") : cells.join("");
          return this.renderNested(source).trim();
        }).filter(Boolean).join("\n");
      }
      if (environment === "cases" || environment === "cases*") {
        const rows = this.splitEnvironmentRows(body).map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim())).filter((row) => row.some(Boolean));
        return rows.map((row, index) => {
          const value = (row[0] ?? "").replace(/,\s*$/, "");
          const condition = row[1] ?? "";
          const delimiter = index === 0 ? "\u23A7" : index === rows.length - 1 ? "\u23A9" : "\u23A8";
          const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
          return `${delimiter} ${value}${condition ? `${conditionPrefix}${condition}` : ""}`;
        }).join("\n");
      }
      if (["array", "matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"].includes(environment)) {
        const matrixBody = environment === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body;
        return this.renderMatrix(environment, matrixBody);
      }
      this.supported = false;
      return body;
    }
    renderMatrix(environment, body) {
      const matrix = this.splitEnvironmentRows(body).map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim())).filter((row) => row.some(Boolean));
      const columnCount = Math.max(0, ...matrix.map((row) => row.length));
      const columnWidths = Array.from(
        { length: columnCount },
        (_2, column) => Math.max(0, ...matrix.map((row) => visibleWidth(row[column] ?? "")))
      );
      const rows = matrix.map(
        (row) => Array.from({ length: columnCount }, (_2, column) => {
          const cell = row[column] ?? "";
          return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - visibleWidth(cell)))}`;
        }).join(" \u2502 ")
      );
      let lines;
      if (environment === "array" || environment === "matrix" || environment === "smallmatrix") {
        lines = rows;
      } else {
        const delimiters = {
          pmatrix: ["\u239B", "\u239E", "\u239C", "\u239F", "\u239D", "\u23A0"],
          bmatrix: ["\u23A1", "\u23A4", "\u23A2", "\u23A5", "\u23A3", "\u23A6"],
          Bmatrix: ["\u23A7", "\u23AB", "\u23A8", "\u23AC", "\u23A9", "\u23AD"],
          vmatrix: ["\u2502", "\u2502", "\u2502", "\u2502", "\u2502", "\u2502"],
          Vmatrix: ["\u2551", "\u2551", "\u2551", "\u2551", "\u2551", "\u2551"]
        };
        const delimiter = delimiters[environment];
        if (!delimiter) {
          this.supported = false;
          return rows.join("\n");
        }
        lines = rows.map((row, index2) => {
          const left = index2 === 0 ? delimiter[0] : index2 === rows.length - 1 ? delimiter[4] : delimiter[2];
          const right = index2 === 0 ? delimiter[1] : index2 === rows.length - 1 ? delimiter[5] : delimiter[3];
          return `${left} ${row} ${right}`;
        });
      }
      if (lines.length <= 1) {
        return lines[0] ?? "";
      }
      const index = this.layoutNodes.push({ type: "matrix", lines, baseline: 0 }) - 1;
      return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
    }
    renderNested(source, stackFractions = true) {
      const rendered = new _LatexParser(source, this.layoutNodes, this.display && stackFractions).render();
      if (rendered === void 0) {
        this.supported = false;
        return source;
      }
      return rendered;
    }
  };
  function renderLatex(source, options = {}) {
    const layoutNodes = [];
    const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
    if (rendered === void 0) {
      return void 0;
    }
    if (layoutNodes.length === 0) {
      return rendered.replaceAll(PROTECTED_SPACE, " ");
    }
    const lines = renderLayout(rendered, layoutNodes).lines;
    const indentation = Math.min(
      ...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length)
    );
    return lines.map((line) => line.slice(indentation).trimEnd()).join("\n").trimEnd().replaceAll(PROTECTED_SPACE, " ");
  }

  // ../../../tmp/qtest/shim/terminal-image.ts
  var getCapabilities = () => ({ images: false, hyperlinks: false });
  var hyperlink = (text, _url) => text;
  var isImageLine = () => false;

  // packages/tui/src/components/markdown.ts
  var STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
  var StrictStrikethroughTokenizer = class extends w {
    del(src) {
      const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
      if (!match) {
        return void 0;
      }
      const text = match[2];
      return {
        type: "del",
        raw: match[0],
        text,
        tokens: this.lexer.inlineTokens(text)
      };
    }
  };
  function isEscaped(source, index) {
    let backslashes = 0;
    for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
      backslashes++;
    }
    return backslashes % 2 === 1;
  }
  function findClosingDelimiter(source, closing, start) {
    let index = source.indexOf(closing, start);
    while (index >= 0 && isEscaped(source, index)) {
      index = source.indexOf(closing, index + closing.length);
    }
    return index;
  }
  function looksLikePendingDollarMath(source) {
    return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
  }
  function tokenizeInlineLatex(source) {
    let opening = "";
    let closing = "";
    if (source.startsWith("$$")) {
      opening = "$$";
      closing = "$$";
    } else if (source.startsWith("\\(")) {
      opening = "\\(";
      closing = "\\)";
    } else if (source.startsWith("\\[")) {
      opening = "\\[";
      closing = "\\]";
    } else if (source.startsWith("$") && !/^\$\s/.test(source)) {
      opening = "$";
      closing = "$";
    } else {
      return void 0;
    }
    const closingIndex = findClosingDelimiter(source, closing, opening.length);
    if (closingIndex >= 0 && opening === "$" && (/\s$/.test(source.slice(opening.length, closingIndex)) || /^\d/.test(source.slice(closingIndex + 1)) || /^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) && /^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1)) || source.slice(opening.length, closingIndex).includes("`"))) {
      return void 0;
    }
    if (closingIndex < 0) {
      const pendingSource = source.slice(opening.length);
      if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
        return { type: "latex", raw: source, text: pendingSource, pending: true };
      }
      return void 0;
    }
    const text = source.slice(opening.length, closingIndex);
    if (!text || text.includes("\n")) {
      return void 0;
    }
    const raw = source.slice(0, closingIndex + closing.length);
    return { type: "latex", raw, text };
  }
  function tokenizeBlockLatex(source) {
    const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
    if (dollarMatch?.[1]) {
      return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
    }
    const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
    if (bracketMatch?.[1]) {
      return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
    }
    const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
    if (pendingBracket) {
      return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
    }
    const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
    if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
      return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
    }
    return void 0;
  }
  var LATEX_MARKDOWN_EXTENSIONS = [
    {
      name: "latexBlock",
      level: "block",
      start(source) {
        const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
        return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : void 0;
      },
      tokenizer: tokenizeBlockLatex
    },
    {
      name: "latex",
      level: "inline",
      start(source) {
        const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
          (index) => index >= 0
        );
        return indices.length > 0 ? Math.min(...indices) : void 0;
      },
      tokenizer: tokenizeInlineLatex
    }
  ];
  function trimPartialClosingFences(tokens) {
    const token = tokens[tokens.length - 1];
    if (token?.type === "list") {
      trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
      return;
    }
    if (token?.type === "blockquote") {
      trimPartialClosingFences(token.tokens ?? []);
      return;
    }
    if (token?.type !== "code") {
      return;
    }
    const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
    const lastLine = token.raw.split("\n").pop();
    if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
      return;
    }
    token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
  }
  var markdownParser = new q();
  markdownParser.setOptions({
    tokenizer: new StrictStrikethroughTokenizer()
  });
  markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });
  var Markdown = class {
    constructor(text, paddingX, paddingY, theme, defaultTextStyle, options) {
      this.text = text;
      this.paddingX = paddingX;
      this.paddingY = paddingY;
      this.theme = theme;
      this.defaultTextStyle = defaultTextStyle;
      this.options = options ? { ...options } : {};
    }
    setText(text) {
      this.text = text;
      this.invalidate();
    }
    invalidate() {
      this.cachedText = void 0;
      this.cachedWidth = void 0;
      this.cachedLines = void 0;
    }
    render(width) {
      if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
        return this.cachedLines;
      }
      const contentWidth = Math.max(1, width - this.paddingX * 2);
      const text = this.options.transform?.(this.text, contentWidth) ?? this.text;
      if (!text || text.trim() === "") {
        const result2 = [];
        this.cachedText = this.text;
        this.cachedWidth = width;
        this.cachedLines = result2;
        return result2;
      }
      const normalizedText = text.replace(/\t/g, "   ");
      const tokens = markdownParser.lexer(normalizedText);
      trimPartialClosingFences(tokens);
      const renderedLines = [];
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const nextToken = tokens[i + 1];
        const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
        for (const tokenLine of tokenLines) {
          renderedLines.push(tokenLine);
        }
      }
      const wrappedLines = [];
      for (const line of renderedLines) {
        if (isImageLine(line)) {
          wrappedLines.push(line);
        } else {
          for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
            wrappedLines.push(wrappedLine);
          }
        }
      }
      const leftMargin = " ".repeat(this.paddingX);
      const rightMargin = " ".repeat(this.paddingX);
      const bgFn = this.defaultTextStyle?.bgColor;
      const contentLines = [];
      for (const line of wrappedLines) {
        if (isImageLine(line)) {
          contentLines.push(line);
          continue;
        }
        const lineWithMargins = leftMargin + line + rightMargin;
        if (bgFn) {
          contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
        } else {
          const visibleLen = visibleWidth(lineWithMargins);
          const paddingNeeded = Math.max(0, width - visibleLen);
          contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
        }
      }
      const emptyLine = " ".repeat(width);
      const emptyLines = [];
      for (let i = 0; i < this.paddingY; i++) {
        const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
        emptyLines.push(line);
      }
      const result = emptyLines.concat(contentLines, emptyLines);
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = result;
      return result.length > 0 ? result : [""];
    }
    /**
     * Apply default text style to a string.
     * This is the base styling applied to all text content.
     * NOTE: Background color is NOT applied here - it's applied at the padding stage
     * to ensure it extends to the full line width.
     */
    applyDefaultStyle(text) {
      if (!this.defaultTextStyle) {
        return text;
      }
      let styled = text;
      if (this.defaultTextStyle.color) {
        styled = this.defaultTextStyle.color(styled);
      }
      if (this.defaultTextStyle.bold) {
        styled = this.theme.bold(styled);
      }
      if (this.defaultTextStyle.italic) {
        styled = this.theme.italic(styled);
      }
      if (this.defaultTextStyle.strikethrough) {
        styled = this.theme.strikethrough(styled);
      }
      if (this.defaultTextStyle.underline) {
        styled = this.theme.underline(styled);
      }
      return styled;
    }
    getDefaultStylePrefix() {
      if (!this.defaultTextStyle) {
        return "";
      }
      if (this.defaultStylePrefix !== void 0) {
        return this.defaultStylePrefix;
      }
      const sentinel = "\0";
      let styled = sentinel;
      if (this.defaultTextStyle.color) {
        styled = this.defaultTextStyle.color(styled);
      }
      if (this.defaultTextStyle.bold) {
        styled = this.theme.bold(styled);
      }
      if (this.defaultTextStyle.italic) {
        styled = this.theme.italic(styled);
      }
      if (this.defaultTextStyle.strikethrough) {
        styled = this.theme.strikethrough(styled);
      }
      if (this.defaultTextStyle.underline) {
        styled = this.theme.underline(styled);
      }
      const sentinelIndex = styled.indexOf(sentinel);
      this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
      return this.defaultStylePrefix;
    }
    getStylePrefix(styleFn) {
      const sentinel = "\0";
      const styled = styleFn(sentinel);
      const sentinelIndex = styled.indexOf(sentinel);
      return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
    }
    getDefaultInlineStyleContext() {
      return {
        applyText: (text) => this.applyDefaultStyle(text),
        stylePrefix: this.getDefaultStylePrefix()
      };
    }
    renderToken(token, width, nextTokenType, styleContext) {
      const lines = [];
      switch (token.type) {
        case "heading": {
          const headingLevel = token.depth;
          const headingPrefix = `${"#".repeat(headingLevel)} `;
          let headingStyleFn;
          if (headingLevel === 1) {
            headingStyleFn = (text) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
          } else {
            headingStyleFn = (text) => this.theme.heading(this.theme.bold(text));
          }
          const headingStyleContext = {
            applyText: headingStyleFn,
            stylePrefix: this.getStylePrefix(headingStyleFn)
          };
          const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
          const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
          lines.push(styledHeading);
          if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
          }
          break;
        }
        case "paragraph": {
          const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
          lines.push(paragraphText);
          if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
            lines.push("");
          }
          break;
        }
        case "text":
          lines.push(this.renderInlineTokens([token], styleContext));
          break;
        case "latexBlock": {
          const latexToken = token;
          const rendered = !latexToken.pending && this.options.renderLatex !== false ? renderLatex(latexToken.text, { display: true }) ?? latexToken.raw.trim() : latexToken.raw.trim();
          for (const line of rendered.split("\n")) {
            lines.push(this.applyDefaultStyle(line));
          }
          if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
          }
          break;
        }
        case "code": {
          const indent = this.theme.codeBlockIndent ?? "  ";
          lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
          if (this.theme.highlightCode) {
            const highlightedLines = this.theme.highlightCode(token.text, token.lang);
            for (const hlLine of highlightedLines) {
              lines.push(`${indent}${hlLine}`);
            }
          } else {
            const codeLines = token.text.split("\n");
            for (const codeLine of codeLines) {
              lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
            }
          }
          lines.push(this.theme.codeBlockBorder("```"));
          if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
          }
          break;
        }
        case "list": {
          const listLines = this.renderList(token, 0, width, styleContext);
          lines.push(...listLines);
          break;
        }
        case "table": {
          const tableLines = this.renderTable(token, width, nextTokenType, styleContext);
          lines.push(...tableLines);
          break;
        }
        case "blockquote": {
          const quoteStyle = (text) => this.theme.quote(this.theme.italic(text));
          const quoteStylePrefix = this.getStylePrefix(quoteStyle);
          const applyQuoteStyle = (line) => {
            if (!quoteStylePrefix) {
              return quoteStyle(line);
            }
            const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1B[0m${quoteStylePrefix}`);
            return quoteStyle(lineWithReappliedStyle);
          };
          const quoteContentWidth = Math.max(1, width - 2);
          const quoteInlineStyleContext = {
            applyText: (text) => text,
            stylePrefix: quoteStylePrefix
          };
          const quoteTokens = token.tokens || [];
          const renderedQuoteLines = [];
          for (let i = 0; i < quoteTokens.length; i++) {
            const quoteToken = quoteTokens[i];
            const nextQuoteToken = quoteTokens[i + 1];
            renderedQuoteLines.push(
              ...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext)
            );
          }
          while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
            renderedQuoteLines.pop();
          }
          for (const quoteLine of renderedQuoteLines) {
            const styledLine = applyQuoteStyle(quoteLine);
            const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
            for (const wrappedLine of wrappedLines) {
              lines.push(this.theme.quoteBorder("\u2502 ") + wrappedLine);
            }
          }
          if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
          }
          break;
        }
        case "hr":
          lines.push(this.theme.hr("\u2500".repeat(Math.min(width, 80))));
          if (nextTokenType && nextTokenType !== "space") {
            lines.push("");
          }
          break;
        case "html":
          if ("raw" in token && typeof token.raw === "string") {
            lines.push(this.applyDefaultStyle(token.raw.trim()));
          }
          break;
        case "space":
          lines.push("");
          break;
        default:
          if ("text" in token && typeof token.text === "string") {
            lines.push(token.text);
          }
      }
      return lines;
    }
    renderInlineTokens(tokens, styleContext) {
      let result = "";
      const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
      const { applyText, stylePrefix } = resolvedStyleContext;
      const applyTextWithNewlines = (text) => {
        const segments = text.split("\n");
        return segments.map((segment) => applyText(segment)).join("\n");
      };
      for (const token of tokens) {
        switch (token.type) {
          case "latex": {
            const latexToken = token;
            const rendered = !latexToken.pending && this.options.renderLatex !== false ? renderLatex(latexToken.text) ?? latexToken.raw : latexToken.raw;
            result += applyTextWithNewlines(rendered);
            break;
          }
          case "escape":
            result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
            break;
          case "text":
            if (token.tokens && token.tokens.length > 0) {
              result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
            } else {
              result += applyTextWithNewlines(token.text);
            }
            break;
          case "paragraph":
            result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
            break;
          case "strong": {
            const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
            result += this.theme.bold(boldContent) + stylePrefix;
            break;
          }
          case "em": {
            const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
            result += this.theme.italic(italicContent) + stylePrefix;
            break;
          }
          case "codespan":
            result += this.theme.code(token.text) + stylePrefix;
            break;
          case "link": {
            const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
            const styledLink = this.theme.link(this.theme.underline(linkText));
            if (getCapabilities().hyperlinks) {
              result += hyperlink(styledLink, token.href) + stylePrefix;
            } else {
              const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
              if (token.text === token.href || token.text === hrefForComparison) {
                result += styledLink + stylePrefix;
              } else {
                result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
              }
            }
            break;
          }
          case "br":
            result += "\n";
            break;
          case "del": {
            const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
            result += this.theme.strikethrough(delContent) + stylePrefix;
            break;
          }
          case "html":
            if ("raw" in token && typeof token.raw === "string") {
              result += applyTextWithNewlines(token.raw);
            }
            break;
          default:
            if ("text" in token && typeof token.text === "string") {
              result += applyTextWithNewlines(token.text);
            }
        }
      }
      while (stylePrefix && result.endsWith(stylePrefix)) {
        result = result.slice(0, -stylePrefix.length);
      }
      return result;
    }
    getOrderedListMarker(item) {
      const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
      return match ? `${match[1]} ` : void 0;
    }
    getUnorderedListMarker(item) {
      const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
      return match ? `${match[1]} ` : void 0;
    }
    /**
     * Render a list with proper nesting support
     */
    renderList(token, depth, width, styleContext) {
      const lines = [];
      const indent = "    ".repeat(depth);
      const startNumber = typeof token.start === "number" ? token.start : 1;
      for (let i = 0; i < token.items.length; i++) {
        const item = token.items[i];
        const isLastItem = i === token.items.length - 1;
        const bullet = token.ordered ? this.options.preserveOrderedListMarkers ? this.getOrderedListMarker(item) ?? `${startNumber + i}. ` : `${startNumber + i}. ` : this.options.preserveOrderedListMarkers ? this.getUnorderedListMarker(item) ?? "- " : "- ";
        const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
        const marker = bullet + taskMarker;
        const firstPrefix = indent + this.theme.listBullet(marker);
        const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
        const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
        let renderedAnyLine = false;
        for (const itemToken of item.tokens) {
          if (itemToken.type === "list") {
            lines.push(...this.renderList(itemToken, depth + 1, width, styleContext));
            renderedAnyLine = true;
            continue;
          }
          const itemLines = this.renderToken(itemToken, itemWidth, void 0, styleContext);
          for (const line of itemLines) {
            for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
              const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
              lines.push(linePrefix + wrappedLine);
              renderedAnyLine = true;
            }
          }
        }
        if (!renderedAnyLine) {
          lines.push(firstPrefix);
        }
        if (token.loose && !isLastItem) {
          lines.push("");
        }
      }
      return lines;
    }
    /**
     * Get the visible width of the longest word in a string.
     */
    getLongestWordWidth(text, maxWidth) {
      const words = text.split(/\s+/).filter((word) => word.length > 0);
      let longest = 0;
      for (const word of words) {
        longest = Math.max(longest, visibleWidth(word));
      }
      if (maxWidth === void 0) {
        return longest;
      }
      return Math.min(longest, maxWidth);
    }
    /**
     * Wrap a table cell to fit into a column.
     *
     * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
     * consistently with the rest of the renderer.
     */
    wrapCellText(text, maxWidth, stylePrefix = "") {
      const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
      return lines.map((line, index) => {
        const styleReset = index < lines.length - 1 ? "\x1B[22;23;24;25;27;28;29;39m" : "";
        return `${line}${styleReset}${stylePrefix}`;
      });
    }
    /**
     * Render a table with width-aware cell wrapping.
     * Cells that don't fit are wrapped to multiple lines.
     */
    renderTable(token, availableWidth, nextTokenType, styleContext) {
      const lines = [];
      const numCols = token.header.length;
      if (numCols === 0) {
        return lines;
      }
      const borderOverhead = 3 * numCols + 1;
      const availableForCells = availableWidth - borderOverhead;
      if (availableForCells < numCols) {
        const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
        if (nextTokenType && nextTokenType !== "space") {
          fallbackLines.push("");
        }
        return fallbackLines;
      }
      const maxUnbrokenWordWidth = 30;
      const naturalWidths = [];
      const minWordWidths = [];
      for (let i = 0; i < numCols; i++) {
        const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
        naturalWidths[i] = visibleWidth(headerText);
        minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
      }
      for (const row of token.rows) {
        for (let i = 0; i < row.length; i++) {
          const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
          naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
          minWordWidths[i] = Math.max(
            minWordWidths[i] || 1,
            this.getLongestWordWidth(cellText, maxUnbrokenWordWidth)
          );
        }
      }
      let minColumnWidths = minWordWidths;
      let minCellsWidth = minColumnWidths.reduce((a, b2) => a + b2, 0);
      if (minCellsWidth > availableForCells) {
        minColumnWidths = new Array(numCols).fill(1);
        const remaining = availableForCells - numCols;
        if (remaining > 0) {
          const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
          const growth = minWordWidths.map((width) => {
            const weight = Math.max(0, width - 1);
            return totalWeight > 0 ? Math.floor(weight / totalWeight * remaining) : 0;
          });
          for (let i = 0; i < numCols; i++) {
            minColumnWidths[i] += growth[i] ?? 0;
          }
          const allocated = growth.reduce((total, width) => total + width, 0);
          let leftover = remaining - allocated;
          for (let i = 0; leftover > 0 && i < numCols; i++) {
            minColumnWidths[i]++;
            leftover--;
          }
        }
        minCellsWidth = minColumnWidths.reduce((a, b2) => a + b2, 0);
      }
      const totalNaturalWidth = naturalWidths.reduce((a, b2) => a + b2, 0) + borderOverhead;
      let columnWidths;
      if (totalNaturalWidth <= availableWidth) {
        columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
      } else {
        const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
          return total + Math.max(0, width - minColumnWidths[index]);
        }, 0);
        const extraWidth = Math.max(0, availableForCells - minCellsWidth);
        columnWidths = minColumnWidths.map((minWidth, index) => {
          const naturalWidth = naturalWidths[index];
          const minWidthDelta = Math.max(0, naturalWidth - minWidth);
          let grow = 0;
          if (totalGrowPotential > 0) {
            grow = Math.floor(minWidthDelta / totalGrowPotential * extraWidth);
          }
          return minWidth + grow;
        });
        const allocated = columnWidths.reduce((a, b2) => a + b2, 0);
        let remaining = availableForCells - allocated;
        while (remaining > 0) {
          let grew = false;
          for (let i = 0; i < numCols && remaining > 0; i++) {
            if (columnWidths[i] < naturalWidths[i]) {
              columnWidths[i]++;
              remaining--;
              grew = true;
            }
          }
          if (!grew) {
            break;
          }
        }
      }
      const topBorderCells = columnWidths.map((w2) => "\u2500".repeat(w2));
      lines.push(`\u250C\u2500${topBorderCells.join("\u2500\u252C\u2500")}\u2500\u2510`);
      const headerCellLines = token.header.map((cell, i) => {
        const text = this.renderInlineTokens(cell.tokens || [], styleContext);
        return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
      });
      const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));
      for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
        const rowParts = headerCellLines.map((cellLines, colIdx) => {
          const text = cellLines[lineIdx] || "";
          const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
          return this.theme.bold(padded);
        });
        lines.push(`\u2502 ${rowParts.join(" \u2502 ")} \u2502`);
      }
      const separatorCells = columnWidths.map((w2) => "\u2500".repeat(w2));
      const separatorLine = `\u251C\u2500${separatorCells.join("\u2500\u253C\u2500")}\u2500\u2524`;
      lines.push(separatorLine);
      for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
        const row = token.rows[rowIndex];
        const rowCellLines = row.map((cell, i) => {
          const text = this.renderInlineTokens(cell.tokens || [], styleContext);
          return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
        });
        const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));
        for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
          const rowParts = rowCellLines.map((cellLines, colIdx) => {
            const text = cellLines[lineIdx] || "";
            return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
          });
          lines.push(`\u2502 ${rowParts.join(" \u2502 ")} \u2502`);
        }
        if (rowIndex < token.rows.length - 1) {
          lines.push(separatorLine);
        }
      }
      const bottomBorderCells = columnWidths.map((w2) => "\u2500".repeat(w2));
      lines.push(`\u2514\u2500${bottomBorderCells.join("\u2500\u2534\u2500")}\u2500\u2518`);
      if (nextTokenType && nextTokenType !== "space") {
        lines.push("");
      }
      return lines;
    }
  };

  // packages/tui/bundle-bench.ts
  var sty = (n) => (t) => `\x1B[${n}m${t}\x1B[0m`;
  function bench(nPoints, count, reps) {
    const theme = {
      heading: sty(36),
      bold: sty(1),
      italic: sty(3),
      code: sty(33),
      codeBlock: sty(33),
      codeBlockBorder: sty(33),
      quote: sty(3),
      quoteBorder: sty(3),
      hr: sty(3),
      listBullet: sty(1),
      link: sty(34),
      linkUrl: sty(34),
      strikethrough: sty(3),
      underline: sty(1)
    };
    let text = "## Section\n\nHere is an explanation with **bold** and `inline code` plus a [link](http://x).\n\n";
    for (let i = 0; i < nPoints; i++) text += `- point ${i} with some trailing prose that wraps at narrow widths
`;
    text += "\n```ts\nconst x = 1;\n```\n";
    const comps = Array.from({ length: count }, () => new Markdown(text, 0, 0, theme));
    for (let i = 0; i < 20; i++) comps[0].render(40 + i % 20);
    const t0 = Date.now();
    for (let r = 0; r < reps; r++) for (const c of comps) c.render(40 + r % 60);
    return (Date.now() - t0) / reps;
  }
  return __toCommonJS(bundle_bench_exports);
})();

globalThis.__bench = __m.bench;