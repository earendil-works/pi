// A preload (`node --import`) that makes the process see itself as Node `P3_TEST_NODE`, for the test that p3 refuses
// a Node older than it supports (`commands.ts`).

Object.defineProperty(process.versions, "node", { value: process.env.P3_TEST_NODE });
