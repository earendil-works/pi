import { describe, expect, it } from "vitest";
import { createWaves, extractFullSteps, type FullStep } from "../examples/extensions/plan-mode/utils.js";

describe("extractFullSteps", () => {
	it("extracts steps with full text from a plan", () => {
		const plan = `Here's the plan:

**Plan:**
1. Set up the project structure with Next.js and install dependencies
2. Build the homepage with hero section and navigation
3. Build the inventory page with car listings
4. Add contact form with validation`;

		const steps = extractFullSteps(plan);
		expect(steps).toHaveLength(4);
		expect(steps[0].step).toBe(1);
		expect(steps[0].text).toContain("Set up the project");
		expect(steps[3].step).toBe(4);
		expect(steps[3].text).toContain("contact form");
	});

	it("returns empty array without Plan: header", () => {
		const plan = `Some steps:
1. Do this
2. Do that`;
		expect(extractFullSteps(plan)).toEqual([]);
	});

	it("handles parenthesis-style numbering", () => {
		const plan = `Plan:
1) First step
2) Second step`;

		const steps = extractFullSteps(plan);
		expect(steps).toHaveLength(2);
	});

	describe("dependency detection", () => {
		it("detects explicit step references", () => {
			const plan = `Plan:
1. Create the database schema
2. After step 1, build the API layer
3. Using step 2, create the frontend`;

			const steps = extractFullSteps(plan);
			expect(steps[1].dependencies).toContain(1);
			expect(steps[2].dependencies).toContain(2);
		});

		it("detects foundation step (step 1 is setup)", () => {
			const plan = `Plan:
1. Scaffold the project and install dependencies
2. Build the homepage
3. Build the about page`;

			const steps = extractFullSteps(plan);
			// Steps 2 and 3 should depend on step 1 (foundation)
			expect(steps[1].dependencies).toContain(1);
			expect(steps[2].dependencies).toContain(1);
		});

		it("does not add foundation dependency when step 1 is not setup", () => {
			const plan = `Plan:
1. Build the homepage hero section
2. Build the navigation bar
3. Build the footer`;

			const steps = extractFullSteps(plan);
			expect(steps[1].dependencies).toEqual([]);
			expect(steps[2].dependencies).toEqual([]);
		});

		it("detects finalization steps depend on all non-finalization steps", () => {
			const plan = `Plan:
1. Set up project structure
2. Build the homepage
3. Build the about page
4. Add responsive design and polish
5. Test everything and deploy`;

			const steps = extractFullSteps(plan);
			// Step 4 (polish) depends on 1, 2, 3
			expect(steps[3].dependencies).toEqual(expect.arrayContaining([1, 2, 3]));
			// Step 5 (test/deploy) depends on 1, 2, 3
			expect(steps[4].dependencies).toEqual(expect.arrayContaining([1, 2, 3]));
		});

		it("does not self-reference in dependencies", () => {
			const plan = `Plan:
1. Set up project
2. After step 2, do something`;

			const steps = extractFullSteps(plan);
			expect(steps[1].dependencies).not.toContain(2);
		});
	});
});

describe("createWaves", () => {
	it("returns empty array for empty steps", () => {
		expect(createWaves([])).toEqual([]);
	});

	it("puts all independent steps in wave 1", () => {
		const steps: FullStep[] = [
			{ step: 1, text: "Build homepage", dependencies: [] },
			{ step: 2, text: "Build about page", dependencies: [] },
			{ step: 3, text: "Build contact page", dependencies: [] },
		];

		const waves = createWaves(steps);
		expect(waves).toHaveLength(1);
		expect(waves[0]).toEqual({ wave: 1, steps: [1, 2, 3] });
	});

	it("puts foundation step in wave 1, dependents in wave 2", () => {
		const steps: FullStep[] = [
			{ step: 1, text: "Set up project", dependencies: [] },
			{ step: 2, text: "Build homepage", dependencies: [1] },
			{ step: 3, text: "Build about page", dependencies: [1] },
		];

		const waves = createWaves(steps);
		expect(waves).toHaveLength(2);
		expect(waves[0]).toEqual({ wave: 1, steps: [1] });
		expect(waves[1]).toEqual({ wave: 2, steps: [2, 3] });
	});

	it("creates three waves for setup → build → finalize pattern", () => {
		const steps: FullStep[] = [
			{ step: 1, text: "Set up project", dependencies: [] },
			{ step: 2, text: "Build homepage", dependencies: [1] },
			{ step: 3, text: "Build about page", dependencies: [1] },
			{ step: 4, text: "Test and deploy", dependencies: [1, 2, 3] },
		];

		const waves = createWaves(steps);
		expect(waves).toHaveLength(3);
		expect(waves[0]).toEqual({ wave: 1, steps: [1] });
		expect(waves[1]).toEqual({ wave: 2, steps: [2, 3] });
		expect(waves[2]).toEqual({ wave: 3, steps: [4] });
	});

	it("handles chain dependencies (sequential)", () => {
		const steps: FullStep[] = [
			{ step: 1, text: "Step A", dependencies: [] },
			{ step: 2, text: "Step B", dependencies: [1] },
			{ step: 3, text: "Step C", dependencies: [2] },
		];

		const waves = createWaves(steps);
		expect(waves).toHaveLength(3);
		expect(waves[0].steps).toEqual([1]);
		expect(waves[1].steps).toEqual([2]);
		expect(waves[2].steps).toEqual([3]);
	});

	it("handles mixed parallel and sequential", () => {
		const steps: FullStep[] = [
			{ step: 1, text: "Setup", dependencies: [] },
			{ step: 2, text: "Feature A", dependencies: [1] },
			{ step: 3, text: "Feature B", dependencies: [1] },
			{ step: 4, text: "Feature C", dependencies: [2] }, // depends on A only
			{ step: 5, text: "Finalize", dependencies: [2, 3, 4] },
		];

		const waves = createWaves(steps);
		expect(waves).toHaveLength(4);
		expect(waves[0].steps).toEqual([1]);
		expect(waves[1].steps).toEqual([2, 3]); // A and B parallel
		expect(waves[2].steps).toEqual([4]); // C after A
		expect(waves[3].steps).toEqual([5]); // Finalize after all
	});

	it("handles unresolvable dependencies by dumping to final wave", () => {
		const steps: FullStep[] = [
			{ step: 1, text: "Step A", dependencies: [2] },
			{ step: 2, text: "Step B", dependencies: [1] }, // circular
		];

		const waves = createWaves(steps);
		// Both are unresolvable, should be dumped into a single wave
		expect(waves).toHaveLength(1);
		expect(waves[0].steps).toEqual([1, 2]);
	});

	it("sorts step numbers within each wave", () => {
		const steps: FullStep[] = [
			{ step: 5, text: "E", dependencies: [] },
			{ step: 3, text: "C", dependencies: [] },
			{ step: 1, text: "A", dependencies: [] },
		];

		const waves = createWaves(steps);
		expect(waves[0].steps).toEqual([1, 3, 5]);
	});
});
