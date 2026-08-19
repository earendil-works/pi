import type { LanguageDefinition } from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import css from "highlight.js/lib/languages/css.js";
import diffLanguage from "highlight.js/lib/languages/diff.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import markdown from "highlight.js/lib/languages/markdown.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import xml from "highlight.js/lib/languages/xml.js";
import yaml from "highlight.js/lib/languages/yaml.js";

type LanguageModule = { default: LanguageDefinition };
type LanguageLoader = () => Promise<LanguageModule>;

export const HIGHLIGHT_LANGUAGE_DEFINITIONS: Record<string, LanguageDefinition> = {
	xml: xml,
	bash: bash,
	css: css,
	markdown: markdown,
	diff: diffLanguage,
	ruby: ruby,
	javascript: javascript,
	json: json,
	python: python,
	yaml: yaml,
	typescript: typescript,
};

// Intentional exception to the no-dynamic-import rule: literal dynamic imports
// let Bun embed every grammar in the standalone binary while keeping evaluation
// lazy, and let Node load only the requested grammar.
export const HIGHLIGHT_LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
	"1c": () => import("highlight.js/lib/languages/1c.js"),
	abnf: () => import("highlight.js/lib/languages/abnf.js"),
	accesslog: () => import("highlight.js/lib/languages/accesslog.js"),
	actionscript: () => import("highlight.js/lib/languages/actionscript.js"),
	ada: () => import("highlight.js/lib/languages/ada.js"),
	angelscript: () => import("highlight.js/lib/languages/angelscript.js"),
	apache: () => import("highlight.js/lib/languages/apache.js"),
	applescript: () => import("highlight.js/lib/languages/applescript.js"),
	arcade: () => import("highlight.js/lib/languages/arcade.js"),
	arduino: () => import("highlight.js/lib/languages/arduino.js"),
	armasm: () => import("highlight.js/lib/languages/armasm.js"),
	asciidoc: () => import("highlight.js/lib/languages/asciidoc.js"),
	aspectj: () => import("highlight.js/lib/languages/aspectj.js"),
	autohotkey: () => import("highlight.js/lib/languages/autohotkey.js"),
	autoit: () => import("highlight.js/lib/languages/autoit.js"),
	avrasm: () => import("highlight.js/lib/languages/avrasm.js"),
	awk: () => import("highlight.js/lib/languages/awk.js"),
	axapta: () => import("highlight.js/lib/languages/axapta.js"),
	basic: () => import("highlight.js/lib/languages/basic.js"),
	bnf: () => import("highlight.js/lib/languages/bnf.js"),
	brainfuck: () => import("highlight.js/lib/languages/brainfuck.js"),
	"c-like": () => import("highlight.js/lib/languages/c-like.js"),
	c: () => import("highlight.js/lib/languages/c.js"),
	cal: () => import("highlight.js/lib/languages/cal.js"),
	capnproto: () => import("highlight.js/lib/languages/capnproto.js"),
	ceylon: () => import("highlight.js/lib/languages/ceylon.js"),
	clean: () => import("highlight.js/lib/languages/clean.js"),
	clojure: () => import("highlight.js/lib/languages/clojure.js"),
	"clojure-repl": () => import("highlight.js/lib/languages/clojure-repl.js"),
	cmake: () => import("highlight.js/lib/languages/cmake.js"),
	coffeescript: () => import("highlight.js/lib/languages/coffeescript.js"),
	coq: () => import("highlight.js/lib/languages/coq.js"),
	cos: () => import("highlight.js/lib/languages/cos.js"),
	cpp: () => import("highlight.js/lib/languages/cpp.js"),
	crmsh: () => import("highlight.js/lib/languages/crmsh.js"),
	crystal: () => import("highlight.js/lib/languages/crystal.js"),
	csharp: () => import("highlight.js/lib/languages/csharp.js"),
	csp: () => import("highlight.js/lib/languages/csp.js"),
	d: () => import("highlight.js/lib/languages/d.js"),
	dart: () => import("highlight.js/lib/languages/dart.js"),
	delphi: () => import("highlight.js/lib/languages/delphi.js"),
	django: () => import("highlight.js/lib/languages/django.js"),
	dns: () => import("highlight.js/lib/languages/dns.js"),
	dockerfile: () => import("highlight.js/lib/languages/dockerfile.js"),
	dos: () => import("highlight.js/lib/languages/dos.js"),
	dsconfig: () => import("highlight.js/lib/languages/dsconfig.js"),
	dts: () => import("highlight.js/lib/languages/dts.js"),
	dust: () => import("highlight.js/lib/languages/dust.js"),
	ebnf: () => import("highlight.js/lib/languages/ebnf.js"),
	elixir: () => import("highlight.js/lib/languages/elixir.js"),
	elm: () => import("highlight.js/lib/languages/elm.js"),
	erb: () => import("highlight.js/lib/languages/erb.js"),
	"erlang-repl": () => import("highlight.js/lib/languages/erlang-repl.js"),
	erlang: () => import("highlight.js/lib/languages/erlang.js"),
	excel: () => import("highlight.js/lib/languages/excel.js"),
	fix: () => import("highlight.js/lib/languages/fix.js"),
	flix: () => import("highlight.js/lib/languages/flix.js"),
	fortran: () => import("highlight.js/lib/languages/fortran.js"),
	fsharp: () => import("highlight.js/lib/languages/fsharp.js"),
	gams: () => import("highlight.js/lib/languages/gams.js"),
	gauss: () => import("highlight.js/lib/languages/gauss.js"),
	gcode: () => import("highlight.js/lib/languages/gcode.js"),
	gherkin: () => import("highlight.js/lib/languages/gherkin.js"),
	glsl: () => import("highlight.js/lib/languages/glsl.js"),
	gml: () => import("highlight.js/lib/languages/gml.js"),
	go: () => import("highlight.js/lib/languages/go.js"),
	golo: () => import("highlight.js/lib/languages/golo.js"),
	gradle: () => import("highlight.js/lib/languages/gradle.js"),
	groovy: () => import("highlight.js/lib/languages/groovy.js"),
	haml: () => import("highlight.js/lib/languages/haml.js"),
	handlebars: () => import("highlight.js/lib/languages/handlebars.js"),
	haskell: () => import("highlight.js/lib/languages/haskell.js"),
	haxe: () => import("highlight.js/lib/languages/haxe.js"),
	hsp: () => import("highlight.js/lib/languages/hsp.js"),
	htmlbars: () => import("highlight.js/lib/languages/htmlbars.js"),
	http: () => import("highlight.js/lib/languages/http.js"),
	hy: () => import("highlight.js/lib/languages/hy.js"),
	inform7: () => import("highlight.js/lib/languages/inform7.js"),
	ini: () => import("highlight.js/lib/languages/ini.js"),
	irpf90: () => import("highlight.js/lib/languages/irpf90.js"),
	isbl: () => import("highlight.js/lib/languages/isbl.js"),
	java: () => import("highlight.js/lib/languages/java.js"),
	"jboss-cli": () => import("highlight.js/lib/languages/jboss-cli.js"),
	julia: () => import("highlight.js/lib/languages/julia.js"),
	"julia-repl": () => import("highlight.js/lib/languages/julia-repl.js"),
	kotlin: () => import("highlight.js/lib/languages/kotlin.js"),
	lasso: () => import("highlight.js/lib/languages/lasso.js"),
	latex: () => import("highlight.js/lib/languages/latex.js"),
	ldif: () => import("highlight.js/lib/languages/ldif.js"),
	leaf: () => import("highlight.js/lib/languages/leaf.js"),
	less: () => import("highlight.js/lib/languages/less.js"),
	lisp: () => import("highlight.js/lib/languages/lisp.js"),
	livecodeserver: () => import("highlight.js/lib/languages/livecodeserver.js"),
	livescript: () => import("highlight.js/lib/languages/livescript.js"),
	llvm: () => import("highlight.js/lib/languages/llvm.js"),
	lsl: () => import("highlight.js/lib/languages/lsl.js"),
	lua: () => import("highlight.js/lib/languages/lua.js"),
	makefile: () => import("highlight.js/lib/languages/makefile.js"),
	mathematica: () => import("highlight.js/lib/languages/mathematica.js"),
	matlab: () => import("highlight.js/lib/languages/matlab.js"),
	maxima: () => import("highlight.js/lib/languages/maxima.js"),
	mel: () => import("highlight.js/lib/languages/mel.js"),
	mercury: () => import("highlight.js/lib/languages/mercury.js"),
	mipsasm: () => import("highlight.js/lib/languages/mipsasm.js"),
	mizar: () => import("highlight.js/lib/languages/mizar.js"),
	perl: () => import("highlight.js/lib/languages/perl.js"),
	mojolicious: () => import("highlight.js/lib/languages/mojolicious.js"),
	monkey: () => import("highlight.js/lib/languages/monkey.js"),
	moonscript: () => import("highlight.js/lib/languages/moonscript.js"),
	n1ql: () => import("highlight.js/lib/languages/n1ql.js"),
	nginx: () => import("highlight.js/lib/languages/nginx.js"),
	nim: () => import("highlight.js/lib/languages/nim.js"),
	nix: () => import("highlight.js/lib/languages/nix.js"),
	"node-repl": () => import("highlight.js/lib/languages/node-repl.js"),
	nsis: () => import("highlight.js/lib/languages/nsis.js"),
	objectivec: () => import("highlight.js/lib/languages/objectivec.js"),
	ocaml: () => import("highlight.js/lib/languages/ocaml.js"),
	openscad: () => import("highlight.js/lib/languages/openscad.js"),
	oxygene: () => import("highlight.js/lib/languages/oxygene.js"),
	parser3: () => import("highlight.js/lib/languages/parser3.js"),
	pf: () => import("highlight.js/lib/languages/pf.js"),
	pgsql: () => import("highlight.js/lib/languages/pgsql.js"),
	php: () => import("highlight.js/lib/languages/php.js"),
	"php-template": () => import("highlight.js/lib/languages/php-template.js"),
	plaintext: () => import("highlight.js/lib/languages/plaintext.js"),
	pony: () => import("highlight.js/lib/languages/pony.js"),
	powershell: () => import("highlight.js/lib/languages/powershell.js"),
	processing: () => import("highlight.js/lib/languages/processing.js"),
	profile: () => import("highlight.js/lib/languages/profile.js"),
	prolog: () => import("highlight.js/lib/languages/prolog.js"),
	properties: () => import("highlight.js/lib/languages/properties.js"),
	protobuf: () => import("highlight.js/lib/languages/protobuf.js"),
	puppet: () => import("highlight.js/lib/languages/puppet.js"),
	purebasic: () => import("highlight.js/lib/languages/purebasic.js"),
	"python-repl": () => import("highlight.js/lib/languages/python-repl.js"),
	q: () => import("highlight.js/lib/languages/q.js"),
	qml: () => import("highlight.js/lib/languages/qml.js"),
	r: () => import("highlight.js/lib/languages/r.js"),
	reasonml: () => import("highlight.js/lib/languages/reasonml.js"),
	rib: () => import("highlight.js/lib/languages/rib.js"),
	roboconf: () => import("highlight.js/lib/languages/roboconf.js"),
	routeros: () => import("highlight.js/lib/languages/routeros.js"),
	rsl: () => import("highlight.js/lib/languages/rsl.js"),
	ruleslanguage: () => import("highlight.js/lib/languages/ruleslanguage.js"),
	rust: () => import("highlight.js/lib/languages/rust.js"),
	sas: () => import("highlight.js/lib/languages/sas.js"),
	scala: () => import("highlight.js/lib/languages/scala.js"),
	scheme: () => import("highlight.js/lib/languages/scheme.js"),
	scilab: () => import("highlight.js/lib/languages/scilab.js"),
	scss: () => import("highlight.js/lib/languages/scss.js"),
	shell: () => import("highlight.js/lib/languages/shell.js"),
	smali: () => import("highlight.js/lib/languages/smali.js"),
	smalltalk: () => import("highlight.js/lib/languages/smalltalk.js"),
	sml: () => import("highlight.js/lib/languages/sml.js"),
	sqf: () => import("highlight.js/lib/languages/sqf.js"),
	sql_more: () => import("highlight.js/lib/languages/sql_more.js"),
	sql: () => import("highlight.js/lib/languages/sql.js"),
	stan: () => import("highlight.js/lib/languages/stan.js"),
	stata: () => import("highlight.js/lib/languages/stata.js"),
	step21: () => import("highlight.js/lib/languages/step21.js"),
	stylus: () => import("highlight.js/lib/languages/stylus.js"),
	subunit: () => import("highlight.js/lib/languages/subunit.js"),
	swift: () => import("highlight.js/lib/languages/swift.js"),
	taggerscript: () => import("highlight.js/lib/languages/taggerscript.js"),
	tap: () => import("highlight.js/lib/languages/tap.js"),
	tcl: () => import("highlight.js/lib/languages/tcl.js"),
	thrift: () => import("highlight.js/lib/languages/thrift.js"),
	tp: () => import("highlight.js/lib/languages/tp.js"),
	twig: () => import("highlight.js/lib/languages/twig.js"),
	vala: () => import("highlight.js/lib/languages/vala.js"),
	vbnet: () => import("highlight.js/lib/languages/vbnet.js"),
	vbscript: () => import("highlight.js/lib/languages/vbscript.js"),
	"vbscript-html": () => import("highlight.js/lib/languages/vbscript-html.js"),
	verilog: () => import("highlight.js/lib/languages/verilog.js"),
	vhdl: () => import("highlight.js/lib/languages/vhdl.js"),
	vim: () => import("highlight.js/lib/languages/vim.js"),
	x86asm: () => import("highlight.js/lib/languages/x86asm.js"),
	xl: () => import("highlight.js/lib/languages/xl.js"),
	xquery: () => import("highlight.js/lib/languages/xquery.js"),
	zephir: () => import("highlight.js/lib/languages/zephir.js"),
};

const aliasPairs = `
as=actionscript asc=angelscript apacheconf=apache osascript=applescript ino=arduino arm=armasm html=xml
xhtml=xml rss=xml atom=xml xjb=xml xsd=xml xsl=xml plist=xml wsf=xml svg=xml adoc=asciidoc ahk=autohotkey
x++=axapta sh=bash zsh=bash bf=brainfuck c=c-like h=c cc=cpp c++=cpp h++=cpp hpp=cpp hh=cpp hxx=cpp cxx=cpp
capnp=capnproto icl=clean dcl=clean clj=clojure cmake.in=cmake coffee=coffeescript cson=coffeescript
iced=coffeescript cls=cos crm=crmsh pcmk=crmsh cr=crystal cs=csharp c#=csharp md=markdown mkdown=markdown
mkd=markdown dpr=delphi dfm=delphi pas=delphi pascal=delphi freepascal=delphi lazarus=delphi lpr=delphi
lfm=delphi patch=diff jinja=django bind=dns zone=dns docker=dockerfile bat=dos cmd=dos dst=dust rb=ruby
gemspec=ruby podspec=ruby thor=ruby irb=ruby erl=erlang xlsx=excel xls=excel f90=fortran f95=fortran fs=fsharp
gms=gams gss=gauss nc=gcode feature=gherkin golang=go hbs=htmlbars html.hbs=htmlbars html.handlebars=htmlbars
htmlbars=htmlbars hs=haskell hx=haxe https=http hylang=hy i7=inform7 toml=ini jsp=java js=javascript
jsx=javascript mjs=javascript cjs=javascript wildfly-cli=jboss-cli kt=kotlin kts=kotlin ls=livescript
lassoscript=lasso tex=latex mk=makefile mak=makefile make=makefile mma=mathematica wl=mathematica m=mercury
moo=mercury mips=mipsasm pl=perl pm=perl moon=moonscript nginxconf=nginx nixos=nix mm=objectivec
objc=objectivec obj-c=objectivec obj-c++=objectivec objective-c++=objectivec ml=sml scad=openscad pf.conf=pf
postgres=pgsql postgresql=pgsql php3=php php4=php php5=php php6=php php7=php php8=php text=plaintext
txt=plaintext ps=powershell ps1=powershell pp=puppet pb=purebasic pbi=purebasic py=python gyp=python
ipython=python pycon=python-repl k=q kdb=q qt=qml re=reasonml graph=roboconf instances=roboconf
mikrotik=routeros rs=rust sci=scilab console=shell st=smalltalk mysql=sql_more oracle=sql_more stanfuncs=stan
do=stata ado=stata p21=step21 step=step21 stp=step21 styl=stylus yml=yaml tk=tcl craftcms=twig ts=typescript
tsx=typescript vb=vbnet vbs=vbscript v=verilog sv=verilog svh=verilog tao=xl xpath=xquery xq=xquery zep=zephir
`
	.trim()
	.split(/\s+/);

export const HIGHLIGHT_LANGUAGE_ALIASES = new Map(
	aliasPairs.map((pair) => {
		const separator = pair.indexOf("=");
		return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
	}),
);

const dependencyPairs = `
xml=css,javascript html=xml asciidoc=xml clojure-repl=clojure coffeescript=javascript cos=javascript,sql,xml
markdown=xml dart=markdown django=xml dockerfile=bash dust=xml erb=ruby,xml haml=ruby handlebars=xml htmlbars=xml
javascript=css,xml julia-repl=julia livescript=javascript perl=mojolicious mojolicious=perl,xml node-repl=javascript
parser3=xml pgsql=bash,java,json,lua,perl,php,python,r,ruby,scheme,tcl,xml php-template=php,xml python-repl=python
qml=xml shell=bash yaml=ruby tap=yaml toml=ini twig=xml typescript=css,xml vbscript-html=vbscript,xml xquery=xml
`
	.trim()
	.split(/\s+/);

export const HIGHLIGHT_LANGUAGE_DEPENDENCIES = new Map(
	dependencyPairs.map((pair) => {
		const separator = pair.indexOf("=");
		return [pair.slice(0, separator), pair.slice(separator + 1).split(",")] as const;
	}),
);
