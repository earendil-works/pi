import { describe, expect, it } from "vitest";
import { isPlanComplex, isRequestComplex } from "../examples/extensions/plan-mode/utils.js";

describe("isRequestComplex", () => {
	describe("triggers auto-plan (complex requests)", () => {
		it("detects build verb + scope + single tech (core trigger)", () => {
			expect(isRequestComplex("make website for car sales with stripe pay")).toBe(true);
			expect(isRequestComplex("create a website for selling cars with payment integration")).toBe(true);
			expect(isRequestComplex("build a dashboard app with react for analytics")).toBe(true);
			expect(isRequestComplex("set up a landing page with tailwind for the company")).toBe(true);
		});

		it("detects scope + multiple technologies", () => {
			expect(isRequestComplex("create a car sales website in nextjs with payment")).toBe(true);
			expect(isRequestComplex("build a dashboard app with react and tailwind and supabase")).toBe(true);
			expect(isRequestComplex("create a web app using vue with firebase authentication")).toBe(true);
		});

		it("detects scope + multiple deliverables + tech", () => {
			expect(isRequestComplex("build a website with login, dashboard, and stripe checkout")).toBe(true);
			expect(isRequestComplex("create an app with user profiles, notifications, and payment processing")).toBe(true);
		});

		it("detects 3+ technology mentions without scope", () => {
			expect(isRequestComplex("set up nextjs with tailwind and prisma and stripe integration")).toBe(true);
			expect(isRequestComplex("configure react with postgres database and jwt auth tokens")).toBe(true);
		});

		it("detects scope + long prompt + tech", () => {
			const longPrompt =
				"I need you to create a platform that handles inventory management for a retail store chain with multiple locations across the country using react for the frontend";
			expect(isRequestComplex(longPrompt)).toBe(true);
		});

		it("detects full-stack build requests", () => {
			expect(isRequestComplex("create a saas platform with stripe billing, user auth, and postgres database")).toBe(
				true,
			);
			expect(isRequestComplex("build me a full stack web app using next.js with prisma and stripe checkout")).toBe(
				true,
			);
			expect(isRequestComplex("build an ecommerce clone with react, tailwind, supabase auth, and stripe")).toBe(
				true,
			);
		});

		it("detects deployment-heavy requests", () => {
			expect(isRequestComplex("create a service with express api, postgres database, and docker deployment")).toBe(
				true,
			);
		});

		it("detects MVP/prototype requests", () => {
			expect(isRequestComplex("build an mvp for a social media app with react and firebase auth")).toBe(true);
			expect(isRequestComplex("create a prototype dashboard with nextjs and supabase backend")).toBe(true);
		});

		it("detects ecommerce/store/shop scope keywords", () => {
			expect(isRequestComplex("build an ecommerce store with stripe payment processing")).toBe(true);
			expect(isRequestComplex("create a marketplace for selling handmade goods with payments")).toBe(true);
			expect(isRequestComplex("make an online shop with checkout and product listings")).toBe(true);
		});

		it("detects short-form tech words like 'pay'", () => {
			expect(isRequestComplex("make a website for booking services with stripe pay")).toBe(true);
			expect(isRequestComplex("build a platform for car dealers with pay integration")).toBe(true);
		});
	});

	describe("skips simple requests", () => {
		it("skips short prompts", () => {
			expect(isRequestComplex("add a button")).toBe(false);
			expect(isRequestComplex("fix the bug")).toBe(false);
			expect(isRequestComplex("update styles")).toBe(false);
			expect(isRequestComplex("hello")).toBe(false);
			expect(isRequestComplex("")).toBe(false);
		});

		it("skips questions (info-seeking, not building)", () => {
			expect(isRequestComplex("how does nextjs routing work in the app directory")).toBe(false);
			expect(isRequestComplex("what is the best way to handle errors in this codebase")).toBe(false);
			expect(isRequestComplex("why is the react component re-rendering so often")).toBe(false);
			expect(isRequestComplex("can you explain how prisma migrations work")).toBe(false);
			expect(isRequestComplex("tell me about the stripe webhook integration")).toBe(false);
		});

		it("skips fix/debug requests", () => {
			expect(isRequestComplex("fix the login bug in the auth module")).toBe(false);
			expect(isRequestComplex("debug the payment webhook not firing correctly")).toBe(false);
			expect(isRequestComplex("resolve the merge conflict in the api routes")).toBe(false);
			expect(isRequestComplex("investigate why the database connection is timing out")).toBe(false);
			expect(isRequestComplex("review the authentication middleware for security issues")).toBe(false);
		});

		it("skips single-task code changes", () => {
			expect(isRequestComplex("update the README with the new API docs")).toBe(false);
			expect(isRequestComplex("rename the UserCard component to ProfileCard")).toBe(false);
			expect(isRequestComplex("delete the unused helper functions from utils")).toBe(false);
			expect(isRequestComplex("change the primary color from blue to green")).toBe(false);
			expect(isRequestComplex("move the config file to the root directory")).toBe(false);
		});

		it("skips single-technology mentions without scope or build verb", () => {
			expect(isRequestComplex("add tailwind classes to the existing button component")).toBe(false);
			expect(isRequestComplex("install and configure eslint for the project setup")).toBe(false);
		});

		it("skips scope keyword alone without tech signals", () => {
			expect(isRequestComplex("improve the website performance and load times")).toBe(false);
			expect(isRequestComplex("clean up the dashboard layout and spacing")).toBe(false);
		});

		it("skips build verb without scope or tech", () => {
			expect(isRequestComplex("make the header component look better on mobile")).toBe(false);
			expect(isRequestComplex("create a new utility function for date formatting")).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("handles long questions that cross 20-word boundary", () => {
			// Long enough question that it bypasses the question filter but lacks enough tech signals
			const longQuestion =
				"how does the nextjs app router handle server components and client components together in a production deployment environment";
			// This has scope(no) + tech(nextjs=1) — not enough to trigger
			expect(isRequestComplex(longQuestion)).toBe(false);
		});

		it("handles long fix requests that cross 20-word boundary", () => {
			// 19 words — still under the 20-word threshold, so fix filter catches it
			const shortFix =
				"fix the entire authentication system using nextjs middleware with jwt tokens and stripe webhook verification and postgres session storage";
			expect(isRequestComplex(shortFix)).toBe(false);

			// 21 words — past the threshold, fix filter no longer applies. Tech: nextjs, jwt/auth, stripe, postgres = 4 → triggers
			const longFix =
				"fix the entire authentication system and rebuild it completely from scratch using nextjs middleware with jwt tokens and stripe webhook verification and postgres session storage";
			expect(isRequestComplex(longFix)).toBe(true);
		});

		it("is case insensitive for technologies", () => {
			expect(isRequestComplex("create a Website using NextJS with Stripe payment integration")).toBe(true);
			expect(isRequestComplex("build a DASHBOARD with REACT and TAILWIND styling setup")).toBe(true);
		});

		it("handles Next.js with dot notation", () => {
			expect(isRequestComplex("create a website using next.js with stripe payment integration")).toBe(true);
		});

		it("does not false-positive on the word 'app' without build verb", () => {
			// "app" is in scope keywords + "react" is 1 tech, but no build verb → false
			expect(isRequestComplex("open the app and check the react component")).toBe(false);
		});
	});
});

describe("isPlanComplex", () => {
	describe("complex plans", () => {
		it("is complex when step count meets threshold", () => {
			expect(isPlanComplex("simple plan text", 4)).toBe(true);
			expect(isPlanComplex("simple plan text", 5)).toBe(true);
			expect(isPlanComplex("simple plan text", 10)).toBe(true);
		});

		it("is complex when plan spans frontend and backend", () => {
			const plan = `
1. Create the React component for user registration
2. Set up the API endpoint for user creation
3. Add database migration for users table`;
			expect(isPlanComplex(plan, 3)).toBe(true);
		});

		it("detects frontend + backend via various keywords", () => {
			expect(isPlanComplex("Build the UI layout and create the server route", 2)).toBe(true);
			expect(isPlanComplex("Style the tsx component and add middleware", 2)).toBe(true);
			expect(isPlanComplex("Add CSS for the form and set up the database", 2)).toBe(true);
		});

		it("is complex when steps reference other steps", () => {
			const plan = `
1. Set up the project structure
2. Create the database schema
3. After step 2, build the API layer`;
			expect(isPlanComplex(plan, 3)).toBe(true);
		});

		it("detects various dependency patterns", () => {
			expect(isPlanComplex("This depends on step 1 being complete", 2)).toBe(true);
			expect(isPlanComplex("Requires step 3 to be done first", 2)).toBe(true);
			expect(isPlanComplex("Before step 2, we need to finish this", 2)).toBe(true);
			expect(isPlanComplex("This is blocked by the database migration", 2)).toBe(true);
		});

		it("is complex when many unique files are referenced", () => {
			const plan = `
1. Edit src/auth.ts for login logic
2. Update src/api/routes.ts for endpoints
3. Modify src/db/schema.ts for tables
4. Fix src/utils/helpers.js for validation`;
			expect(isPlanComplex(plan, 3)).toBe(true); // 4 unique file refs
		});
	});

	describe("simple plans", () => {
		it("is simple with few steps and no signals", () => {
			expect(isPlanComplex("Add a new button to the header", 1)).toBe(false);
			expect(isPlanComplex("Update the configuration file", 2)).toBe(false);
			expect(isPlanComplex("Fix the styling and add tests", 3)).toBe(false);
		});

		it("is simple when only frontend or only backend", () => {
			expect(isPlanComplex("Create the React component and add CSS styling", 2)).toBe(false);
			expect(isPlanComplex("Set up the API endpoint and database migration", 2)).toBe(false);
		});

		it("is simple with few file references", () => {
			const plan = `
1. Edit src/config.ts
2. Update src/utils.ts
3. Fix src/app.ts`;
			expect(isPlanComplex(plan, 3)).toBe(false); // exactly 3 unique files, threshold is >3
		});

		it("does not false-positive on the word 'then' in normal prose", () => {
			expect(isPlanComplex("Then we update the component to use the new hook", 2)).toBe(false);
			expect(isPlanComplex("First do this, then do that", 2)).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("handles empty plan text", () => {
			expect(isPlanComplex("", 0)).toBe(false);
			expect(isPlanComplex("", 4)).toBe(true); // step count still triggers
		});

		it("counts unique file references, not duplicates", () => {
			const plan = `
1. Read src/config.ts and update src/config.ts
2. Check src/config.ts again
3. Also check src/utils.ts`;
			// Only 2 unique files: config.ts and utils.ts
			expect(isPlanComplex(plan, 2)).toBe(false);
		});

		it("recognizes various file extensions", () => {
			const plan = `
1. Edit main.py
2. Update handler.go
3. Fix lib.rs
4. Check README.md`;
			expect(isPlanComplex(plan, 3)).toBe(true); // 4 unique files
		});
	});
});
