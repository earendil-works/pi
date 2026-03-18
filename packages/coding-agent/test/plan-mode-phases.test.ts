import { describe, expect, it } from "vitest";
import {
	buildDraftPath,
	buildPlanPath,
	classifyIntent,
	createInitialState,
	extractMomusVerdict,
	isClearanceComplete,
	parseClearanceMarkers,
} from "../examples/extensions/plan-mode/phases.js";

describe("classifyIntent", () => {
	it("returns trivial for short prompts", () => {
		expect(classifyIntent("fix the bug")).toBe("trivial");
		expect(classifyIntent("rename foo")).toBe("trivial");
		expect(classifyIntent("delete that file")).toBe("trivial");
	});

	it("returns trivial for questions", () => {
		expect(classifyIntent("what does this function do?")).toBe("trivial");
		expect(classifyIntent("how does the auth work?")).toBe("trivial");
		expect(classifyIntent("can you explain the build process?")).toBe("trivial");
	});

	it("returns trivial for single-action fix/debug requests", () => {
		expect(classifyIntent("fix the typo in the header component")).toBe("trivial");
		expect(classifyIntent("debug why the test is failing")).toBe("trivial");
		expect(classifyIntent("resolve the import error in utils")).toBe("trivial");
	});

	it("returns simple for moderate requests", () => {
		expect(classifyIntent("add a new utility function that validates email addresses and returns a boolean")).toBe(
			"simple",
		);
		expect(
			classifyIntent("refactor the authentication middleware to use async await instead of callbacks consistently"),
		).toBe("simple");
	});

	it("returns complex for multi-tech requests", () => {
		expect(
			classifyIntent("build a web app with react and tailwind that has a postgres database and stripe payments"),
		).toBe("complex");
		expect(classifyIntent("create an e-commerce platform with nextjs, prisma, and stripe checkout integration")).toBe(
			"complex",
		);
	});

	it("returns complex for multi-domain/deliverable requests", () => {
		expect(
			classifyIntent(
				"build a dashboard application with auth, api endpoints, and a react frontend using tailwind for styling",
			),
		).toBe("complex");
	});
});

describe("classifyIntent — conversational signals", () => {
	it("returns conversational for continuations", () => {
		expect(classifyIntent("continue")).toBe("conversational");
		expect(classifyIntent("go on")).toBe("conversational");
		expect(classifyIntent("proceed")).toBe("conversational");
		expect(classifyIntent("next")).toBe("conversational");
		expect(classifyIntent("keep going")).toBe("conversational");
	});

	it("returns conversational for confirmations", () => {
		expect(classifyIntent("yes")).toBe("conversational");
		expect(classifyIntent("ok")).toBe("conversational");
		expect(classifyIntent("go")).toBe("conversational");
		expect(classifyIntent("go ahead")).toBe("conversational");
		expect(classifyIntent("do it")).toBe("conversational");
		expect(classifyIntent("looks good")).toBe("conversational");
		expect(classifyIntent("lgtm")).toBe("conversational");
		expect(classifyIntent("sure")).toBe("conversational");
	});

	it("returns conversational for negations and cancels", () => {
		expect(classifyIntent("no")).toBe("conversational");
		expect(classifyIntent("cancel")).toBe("conversational");
		expect(classifyIntent("stop")).toBe("conversational");
		expect(classifyIntent("never mind")).toBe("conversational");
	});

	it("returns conversational for gratitude", () => {
		expect(classifyIntent("thanks")).toBe("conversational");
		expect(classifyIntent("thank you")).toBe("conversational");
	});

	it("does NOT return conversational for actual tasks", () => {
		expect(classifyIntent("continue building the auth system with proper error handling")).not.toBe("conversational");
		expect(classifyIntent("go build a dashboard")).not.toBe("conversational");
		expect(classifyIntent("ok now implement the login flow with OAuth and session management")).not.toBe(
			"conversational",
		);
	});
});

describe("classifyIntent — bug detection", () => {
	it("returns bug for error reports with broken/not working signals", () => {
		expect(classifyIntent("the login page is broken, I get a 500 error when clicking submit")).toBe("bug");
		expect(classifyIntent("the API endpoint stopped working after yesterday's deploy and returns errors")).toBe(
			"bug",
		);
		expect(classifyIntent("the payment flow is not working anymore, users are seeing a blank page")).toBe("bug");
	});

	it("returns bug for stack traces and error types", () => {
		expect(classifyIntent("TypeError: Cannot read property 'map' of undefined in UserList.tsx component")).toBe(
			"bug",
		);
		expect(classifyIntent("I'm getting a ECONNREFUSED when connecting to the database on port 5432")).toBe("bug");
	});

	it("returns bug for regression reports", () => {
		expect(classifyIntent("there's a regression in the payment flow after the last merge to main")).toBe("bug");
	});

	it("does NOT return bug for build requests with error-like words (anti-collision)", () => {
		expect(classifyIntent("build an error handling middleware for the express API")).not.toBe("bug");
		expect(classifyIntent("create a bug tracking system with a dashboard and reporting")).not.toBe("bug");
		expect(classifyIntent("implement crash reporting and error logging for the mobile app")).not.toBe("bug");
	});

	it("does NOT return bug for short fix requests (stays trivial)", () => {
		expect(classifyIntent("fix the bug")).toBe("trivial");
		expect(classifyIntent("debug this error")).toBe("trivial");
	});
});

describe("classifyIntent — question detection", () => {
	it("returns question for longer information requests", () => {
		expect(classifyIntent("how does the session manager handle token refresh and expiration?")).toBe("question");
		expect(classifyIntent("what is the purpose of the phases.ts file in the plan-mode extension?")).toBe("question");
		expect(classifyIntent("why are we using Neo4j for memory instead of a simpler key-value store?")).toBe(
			"question",
		);
		expect(classifyIntent("can you explain the wave execution flow and how dependencies are resolved?")).toBe(
			"question",
		);
	});

	it("returns question for prompts ending with question mark", () => {
		expect(classifyIntent("is there a test file for the login component in the test directory?")).toBe("question");
	});

	it("keeps short questions as trivial (existing behavior preserved)", () => {
		expect(classifyIntent("what does this function do?")).toBe("trivial");
		expect(classifyIntent("how does the auth work?")).toBe("trivial");
		expect(classifyIntent("can you explain the build process?")).toBe("trivial");
	});

	it("does NOT return question for build requests phrased as questions", () => {
		expect(classifyIntent("build a React component that shows user profiles with avatar and bio")).not.toBe(
			"question",
		);
		expect(classifyIntent("create a new API endpoint for user registration with email validation")).not.toBe(
			"question",
		);
	});
});

describe("parseClearanceMarkers", () => {
	it("parses individual markers", () => {
		expect(parseClearanceMarkers("[CLEAR:objective]")).toEqual({ objectiveClear: true });
		expect(parseClearanceMarkers("[CLEAR:scope]")).toEqual({ scopeBoundaries: true });
		expect(parseClearanceMarkers("[CLEAR:ambiguities]")).toEqual({ noAmbiguities: true });
		expect(parseClearanceMarkers("[CLEAR:approach]")).toEqual({ technicalApproach: true });
		expect(parseClearanceMarkers("[CLEAR:tests]")).toEqual({ testStrategy: true });
		expect(parseClearanceMarkers("[CLEAR:questions]")).toEqual({ noBlockingQuestions: true });
	});

	it("parses multiple markers in one text", () => {
		const text =
			"Some analysis.\n[CLEAR:objective] [CLEAR:scope] [CLEAR:ambiguities]\nMore text [CLEAR:approach] [CLEAR:tests] [CLEAR:questions]";
		const result = parseClearanceMarkers(text);
		expect(result).toEqual({
			objectiveClear: true,
			scopeBoundaries: true,
			noAmbiguities: true,
			technicalApproach: true,
			testStrategy: true,
			noBlockingQuestions: true,
		});
	});

	it("returns empty object for no markers", () => {
		expect(parseClearanceMarkers("Just some regular text")).toEqual({});
	});
});

describe("isClearanceComplete", () => {
	it("returns true when all checks are true", () => {
		expect(
			isClearanceComplete({
				objectiveClear: true,
				scopeBoundaries: true,
				noAmbiguities: true,
				technicalApproach: true,
				testStrategy: true,
				noBlockingQuestions: true,
			}),
		).toBe(true);
	});

	it("returns false when any check is false", () => {
		expect(
			isClearanceComplete({
				objectiveClear: true,
				scopeBoundaries: true,
				noAmbiguities: true,
				technicalApproach: true,
				testStrategy: false,
				noBlockingQuestions: true,
			}),
		).toBe(false);
	});

	it("returns false for initial state clearance", () => {
		const state = createInitialState();
		expect(isClearanceComplete(state.clearance)).toBe(false);
	});
});

describe("extractMomusVerdict", () => {
	it("extracts OKAY verdict", () => {
		expect(extractMomusVerdict("The plan looks good. [OKAY]")).toBe("OKAY");
		expect(extractMomusVerdict("[OKAY] Summary: plan is executable.")).toBe("OKAY");
	});

	it("extracts REJECT verdict", () => {
		expect(extractMomusVerdict("[REJECT] Blocking Issues:\n1. File not found")).toBe("REJECT");
	});

	it("returns null for no verdict", () => {
		expect(extractMomusVerdict("Still reviewing the plan...")).toBeNull();
	});

	it("is case-insensitive", () => {
		expect(extractMomusVerdict("[okay]")).toBe("OKAY");
		expect(extractMomusVerdict("[Reject]")).toBe("REJECT");
	});
});

describe("createInitialState", () => {
	it("creates state with idle phase and null intent", () => {
		const state = createInitialState();
		expect(state.phase).toBe("idle");
		expect(state.intent).toBeNull();
		expect(state.interviewTurns).toBe(0);
		expect(state.momusCycles).toBe(0);
		expect(state.maxMomusCycles).toBe(3);
		expect(state.todoItems).toEqual([]);
		expect(state.waves).toEqual([]);
	});
});

describe("buildDraftPath", () => {
	it("builds path in .pi/drafts/", () => {
		const path = buildDraftPath("/project", "add user auth");
		expect(path).toContain(".pi/drafts/");
		expect(path).toContain("add-user-auth");
		expect(path).toMatch(/\.md$/);
	});

	it("handles empty prompt", () => {
		const path = buildDraftPath("/project", "");
		expect(path).toContain("draft.md");
	});
});

describe("buildPlanPath", () => {
	it("builds path in .pi/plans/", () => {
		const path = buildPlanPath("/project", "build dashboard");
		expect(path).toContain(".pi/plans/");
		expect(path).toContain("build-dashboard");
		expect(path).toMatch(/\.md$/);
	});

	it("slugifies special characters", () => {
		const path = buildPlanPath("/project", "add React & TypeScript support!");
		expect(path).not.toContain("&");
		expect(path).not.toContain("!");
	});

	it("truncates long slugs", () => {
		const longPrompt = "a".repeat(100);
		const path = buildPlanPath("/project", longPrompt);
		// slug is max 50 chars
		const filename = path.split("/").pop()!;
		expect(filename.length).toBeLessThanOrEqual(53); // 50 slug + .md
	});
});
