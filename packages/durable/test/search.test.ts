import { describe, expect, it } from "vitest";
import { rankDocuments, tokenize } from "../src/search.ts";

describe("tokenize", () => {
	it("preserves identifier boundaries, English stop words, and singular forms", () => {
		expect(tokenize("listIssues for the GitHub_repo")).toEqual(["list", "issue", "git", "hub", "repo"]);
		expect(tokenize("searches queries HTTPServer")).toEqual(["search", "query", "http", "server"]);
		expect(tokenize("repo.issues/search:queries")).toEqual(["repo", "issue", "search", "query"]);
	});

	it.each([
		["搜索仓库问题", ["搜索", "仓库", "问题"]],
		["文書を検索", ["文書", "を", "検索"]],
		["문서 검색", ["문서", "검색"]],
		["ค้นหาเอกสาร", ["ค้นหา", "เอกสาร"]],
		["Поиск документов", ["поиск", "документов"]],
		["البحث عن الملفات", ["البحث", "عن", "الملفات"]],
		["फ़ाइल खोजें", ["फ़ाइल", "खोजें"]],
		["Éléments cafés", ["éléments", "cafés"]],
	])("segments Unicode words in %s", (text, expected) => {
		expect(tokenize(text)).toEqual(expected);
	});

	it("preserves non-ASCII words and splits mixed-language identifiers", () => {
		expect(tokenize("搜索GitHub_repoIssues résumé cafés")).toEqual([
			"搜索",
			"git",
			"hub",
			"repo",
			"issue",
			"résumé",
			"cafés",
		]);
	});

	it("normalizes canonically equivalent Unicode text", () => {
		expect(tokenize("CAFÉ cafe\u0301")).toEqual(["café", "café"]);
	});

	it("ignores whitespace, punctuation, and emoji", () => {
		expect(tokenize(" \t，。!? 😀 ")).toEqual([]);
	});
});

describe("rankDocuments", () => {
	const documents = [
		{ name: "list_issues", text: "List issues in a repository" },
		{ name: "create_pull_request", text: "Open a pull request" },
		{ name: "search_docs", text: "Search the documentation" },
	];

	it.each([
		["搜索仓库问题", "问题"],
		["文書を検索", "検索"],
		["문서 검색", "검색"],
		["ค้นหาเอกสาร", "เอกสาร"],
		["Поиск документов", "документов"],
		["البحث عن الملفات", "الملفات"],
		["फ़ाइल खोजें", "खोजें"],
		["Rechercher un café", "cafe\u0301"],
	])("matches Unicode queries against %s", (text, query) => {
		expect(rankDocuments(query, [...documents, { name: "localized", text }], 8)).toEqual(["localized"]);
	});

	it("preserves English matching and respects the limit", () => {
		expect(rankDocuments("issue", documents, 8)).toEqual(["list_issues"]);
		expect(rankDocuments("pull requests", documents, 8)).toEqual(["create_pull_request"]);
		expect(rankDocuments("issues documentation", documents, 1)).toHaveLength(1);
	});

	it("returns nothing for empty or unknown queries", () => {
		expect(rankDocuments("", documents, 8)).toEqual([]);
		expect(rankDocuments("the", documents, 8)).toEqual([]);
		expect(rankDocuments("未知", documents, 8)).toEqual([]);
	});
});
