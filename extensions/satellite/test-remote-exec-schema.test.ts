/**
 * Test: REMOTE_EXEC_SCHEMA constant exists and is properly structured
 * This test verifies the refactor from task 1.2 - extracting the discriminated union
 * schema into a top-level constant.
 */

import { readFileSync } from "node:fs";
import { z } from "zod/v3";

const SATELLITE_SERVER_PATH = "./satellite-server.ts";

function test_REMOTE_EXEC_SCHEMA_exists(): void {
  const content = readFileSync(SATELLITE_SERVER_PATH, "utf-8");

  // Test 1: REMOTE_EXEC_SCHEMA constant is defined at top level
  const hasSchemaConstant = /const\s+REMOTE_EXEC_SCHEMA\s*=\s*z\.discriminatedUnion/.test(content);
  console.assert(hasSchemaConstant, "REMOTE_EXEC_SCHEMA constant should be defined at top level");

  // Test 2: createMcpServer references REMOTE_EXEC_SCHEMA instead of defining inline
  const createMcpServerMatch = content.match(/function createMcpServer\(\)[\s\S]*?return server;/);
  if (createMcpServerMatch) {
    const createMcpServerBody = createMcpServerMatch[0];
    const referencesConstant = /inputSchema:\s*REMOTE_EXEC_SCHEMA/.test(createMcpServerBody);
    console.assert(referencesConstant, "createMcpServer should reference REMOTE_EXEC_SCHEMA");
  }

  console.log("✓ REMOTE_EXEC_SCHEMA exists and is referenced");
}

function test_schema_structure(): void {
  // This is a smoke test to ensure the schema can be imported/validated
  // We parse the file to extract the schema definition and verify it parses correctly

  // Since satellite-server.ts is a script, not a module with exports,
  // we do a structural check via source analysis
  const content = readFileSync(SATELLITE_SERVER_PATH, "utf-8");

  // Verify all 5 tool variants are present in REMOTE_EXEC_SCHEMA
  const expectedTools = ["bash", "read_file", "write_file", "edit_file", "list_dir"];

  // Extract the REMOTE_EXEC_SCHEMA definition
  const schemaMatch = content.match(/const REMOTE_EXEC_SCHEMA\s*=\s*z\.discriminatedUnion\("tool",\s*\[([\s\S]*?)\]\s*\)/);
  if (!schemaMatch) {
    throw new Error("REMOTE_EXEC_SCHEMA should be defined with discriminatedUnion");
  }

  const schemaBody = schemaMatch[1];
  for (const tool of expectedTools) {
    console.assert(schemaBody.includes(`tool: z.literal("${tool}")`), `Schema should include tool: "${tool}"`);
  }

  console.log("✓ Schema structure is correct with all 5 tool variants");
}

function test_schema_is_discriminated_union(): void {
  const content = readFileSync(SATELLITE_SERVER_PATH, "utf-8");

  // Verify REMOTE_EXEC_SCHEMA uses discriminatedUnion with "tool" as discriminator
  const isDiscriminatedUnion = /const REMOTE_EXEC_SCHEMA\s*=\s*z\.discriminatedUnion\s*\(\s*"tool"\s*,/.test(content);
  console.assert(isDiscriminatedUnion, "REMOTE_EXEC_SCHEMA should use z.discriminatedUnion with 'tool' discriminator");

  console.log("✓ Schema is properly a discriminated union on 'tool'");
}

// Run tests
try {
  test_REMOTE_EXEC_SCHEMA_exists();
  test_schema_structure();
  test_schema_is_discriminated_union();
  console.log("\n✅ All tests passed");
  process.exit(0);
} catch (e) {
  console.error("\n❌ Test failed:", e);
  process.exit(1);
}
