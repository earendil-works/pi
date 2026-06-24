/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MessageParts } from "./MessageParts";
import type { Part } from "../../lib/api";

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

describe("MessageParts", () => {
  describe("S4/S5: Thinking default collapsed + click expand", () => {
    // Test 1: thinking (default closed)
    it("renders thinking header with Brain icon and 思考 label", () => {
      const parts: Part[] = [{ type: "thinking", text: "Let me think..." }];
      const { container } = render(<MessageParts parts={parts} />);
      // Should have "思考" button
      expect(screen.getByText(/思考/)).toBeTruthy();
      // Should NOT contain the thinking text in DOM (collapsed)
      expect(container.textContent).not.toContain("Let me think");
    });

    // Test 2: thinking click expands
    it("clicking thinking button expands content", () => {
      const parts: Part[] = [{ type: "thinking", text: "Let me think..." }];
      const { container } = render(<MessageParts parts={parts} />);
      const button = screen.getByText(/展开/i);
      fireEvent.click(button);
      expect(container.textContent).toContain("Let me think");
    });

    it("clicking hide button collapses thinking again", () => {
      const parts: Part[] = [{ type: "thinking", text: "Hidden content" }];
      render(<MessageParts parts={parts} />);

      // Expand
      const expandButton = screen.getByText(/展开/i);
      fireEvent.click(expandButton);

      // Should now be visible
      expect(screen.getByText("Hidden content")).toBeTruthy();

      // Collapse
      const collapseButton = screen.getByText(/收起/i);
      fireEvent.click(collapseButton);

      // Should no longer be visible
      expect(screen.queryByText("Hidden content")).toBeNull();
    });
  });

  describe("S6: Tool call name + summary", () => {
    // Test 3: tool call shows icon + name + summary, no raw JSON by default
    it("tool call shows name and friendly summary, no raw JSON by default", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo/bar.txt" } },
      ];
      render(<MessageParts parts={parts} />);
      // Should show the tool name
      expect(screen.getByText("read")).toBeTruthy();
      // Should show the path as summary
      expect(screen.getByText("/foo/bar.txt")).toBeTruthy();
      // Should NOT show raw JSON visible
      expect(screen.queryByText(/"path":/)).toBeNull();
    });

    // Test 4: tool call click expands to show full args
    it("clicking tool call chevron expands full args JSON", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "bash", args: { command: "ls -la" } },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      expect(container.textContent).not.toContain('"command"');
      // Find the button containing the tool name
      const button = screen.getByText("bash").closest("button")!;
      fireEvent.click(button);
      expect(container.textContent).toContain('"command"');
    });
  });

  describe("S7: Tool result collapsed with size badge", () => {
    // Test 5: tool result shows first line + size badge, not full content
    it("tool result shows first line and size badge, full content collapsed", () => {
      const longContent = "Line 1: important info\n" + "x".repeat(5000);
      const parts: Part[] = [
        { type: "toolResult", toolCallId: "tc1", content: longContent },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      // Should show first line
      expect(container.textContent).toContain("Line 1: important info");
      // Should show size badge
      expect(screen.getByText(/KB/)).toBeTruthy();
      // Should NOT show all 5000 x's in default view
      expect(container.textContent?.length).toBeLessThan(6000);
    });

    it("tool result expands on click to show full content", () => {
      const longContent = "First line\nSecond line content";
      const parts: Part[] = [
        { type: "toolResult", toolCallId: "tc1", content: longContent },
      ];
      const { container } = render(<MessageParts parts={parts} />);

      // Initially collapsed - second line not visible
      expect(container.textContent).not.toContain("Second line content");

      // Click to expand
      const button = screen.getByText("First line").closest("button")!;
      fireEvent.click(button);

      // Now visible
      expect(container.textContent).toContain("Second line content");
    });

    it("short tool result shows content without size badge exceeding small threshold", () => {
      const shortContent = "Short result";
      const parts: Part[] = [
        { type: "toolResult", toolCallId: "tc1", content: shortContent },
      ];
      render(<MessageParts parts={parts} />);

      // Should show content
      expect(screen.getByText("Short result")).toBeTruthy();
    });
  });

  describe("S8: Tool call + result grouped into ToolGroup", () => {
    // Test 6: tool call + result grouped into one container
    it("groups tool calls and results into single ToolGroup container", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo" } },
        { type: "toolResult", toolCallId: "tc1", content: "file content here" },
        { type: "toolCall", id: "tc2", name: "bash", args: { command: "ls" } },
        { type: "toolResult", toolCallId: "tc2", content: "total 0" },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      // Both tool names should be in DOM
      expect(screen.getByText("read")).toBeTruthy();
      expect(screen.getByText("bash")).toBeTruthy();
      // Both results should be visible (first lines visible, full content may be collapsed)
      expect(container.textContent).toContain("file content here");
      expect(container.textContent).toContain("total 0");
    });
  });

  describe("S8b: Large tool group is collapsed by default", () => {
    // 5+ tool-related items in a single turn should default to a summary
    // line ("14 tool calls: bash ×6, todowrite ×6, ...") so the bubble
    // doesn't flood vertically. The user can click to expand.
    it("collapses a 14-tool group behind a summary and shows it on click", async () => {
      const user = userEvent.setup();
      const parts: Part[] = [];
      for (let i = 0; i < 6; i++) {
        parts.push({ type: "toolCall", id: `tcb${i}`, name: "bash", args: { command: `echo ${i}` } });
        parts.push({ type: "toolResult", toolCallId: `tcb${i}`, content: `out ${i}` });
      }
      parts.push({ type: "toolCall", id: "tcw1", name: "todowrite", args: {} });
      parts.push({ type: "toolCall", id: "tcr1", name: "read", args: { path: "/x" } });
      parts.push({ type: "toolCall", id: "tce1", name: "edit", args: { path: "/y" } });
      const { container } = render(<MessageParts parts={parts} />);

      // Summary header present, individual tool rows hidden
      expect(screen.getByText(/9 tool calls/)).toBeTruthy();
      expect(screen.getByText(/bash ×6/)).toBeTruthy();
      expect(screen.getByText(/todowrite ×1/)).toBeTruthy();
      // Individual tool name rows are NOT in DOM yet
      expect(container.textContent).not.toContain("echo 0");

      // Click to expand
      await user.click(screen.getByText(/9 tool calls/));
      expect(container.textContent).toContain("echo 0");
    });

    it("does not collapse a small (≤4) tool group", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo" } },
        { type: "toolResult", toolCallId: "tc1", content: "file content here" },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      // No summary header
      expect(container.textContent).not.toMatch(/\d+ tool calls/);
      expect(screen.getByText("read")).toBeTruthy();
      expect(container.textContent).toContain("file content here");
    });
  });

  describe("S9: Empty assistant renders", () => {
    it("shows (empty turn) placeholder when parts is empty", () => {
      render(<MessageParts parts={[]} />);
      expect(screen.getByText("(empty turn)")).toBeTruthy();
    });

    it("renders thinking + tool card for assistant with no text, NOT empty bubble", () => {
      const parts: Part[] = [
        { type: "thinking", text: "Let me think about this..." },
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo" } },
      ];
      render(<MessageParts parts={parts} />);

      // Should show thinking header with Chinese label
      expect(screen.getByText(/思考/)).toBeTruthy();
      // Should show tool call name
      expect(screen.getByText("read")).toBeTruthy();
      // Should NOT show "(empty turn)" placeholder
      expect(screen.queryByText("(empty turn)")).toBeNull();
    });
  });

  describe("S16: Image renders inline", () => {
    // Test 8: image renders inline
    it("image renders with data URL and max-h-96", () => {
      const parts: Part[] = [
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      expect(img?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
      expect(img?.className).toMatch(/max-h-96/);
    });
  });

  describe("StepHeader (via MessageParts)", () => {
    // These tests cover the StepHeader wrapper around assistant turns.
    // Case 1 is a regression guard — it asserts that pure-text turns do
    // NOT gain a step header. Cases 2-5 cover the streaming / collapsed
    // / user-toggle / auto-collapse contract.

    it("renders no step header for a pure-text turn", () => {
      const parts: Part[] = [{ type: "text", text: "hi" }];
      render(<MessageParts parts={parts} isStreaming={false} />);
      // Regression guard: no "Executing" / "Completed" text → no step header.
      expect(screen.queryByText(/Execut|Completed/i)).toBeNull();
    });

    it("shows Executing header and expands the body when streaming a thinking+text turn", () => {
      const parts: Part[] = [
        { type: "thinking", text: "x" },
        { type: "text", text: "y" },
      ];
      render(<MessageParts parts={parts} isStreaming={true} />);
      // Step header shows "● Executing (Xs) ▼"
      expect(screen.getByText(/Executing/i)).toBeTruthy();
      // Body is expanded by default when isStreaming=true → text "y" visible
      expect(screen.getByText("y")).toBeTruthy();
    });

    it("shows Completed header with the body collapsed when not streaming a tool call turn", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "t1", name: "read", args: { path: "/x" } },
      ];
      render(<MessageParts parts={parts} isStreaming={false} />);
      // Step header shows "✓ Completed (Xs) ▲"
      expect(screen.getByText(/Completed/i)).toBeTruthy();
      // Body is collapsed by default when isStreaming=false → "/x" not in DOM
      expect(screen.queryByText("/x")).toBeNull();
    });

    it("expands the body when the user clicks the Completed step header", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "t1", name: "read", args: { path: "/x" } },
      ];
      const { container } = render(
        <MessageParts parts={parts} isStreaming={false} />,
      );
      // Pre-click: body collapsed
      expect(screen.queryByText("/x")).toBeNull();
      // Find the step header button via its "Completed" label
      const headerButton = screen.getByText(/Completed/i).closest("button");
      expect(headerButton).toBeTruthy();
      fireEvent.click(headerButton!);
      // Post-click: body expanded → "/x" appears in the DOM
      expect(screen.queryByText("/x")).not.toBeNull();
      // sanity: still has the read tool name rendered
      expect(container.textContent).toContain("read");
    });

    it("auto-collapses the body when isStreaming transitions from true to false", () => {
      const parts: Part[] = [
        { type: "thinking", text: "x" },
        { type: "text", text: "y" },
      ];
      const { rerender } = render(
        <MessageParts parts={parts} isStreaming={true} />,
      );
      // While streaming, body is expanded → text "y" visible
      expect(screen.getByText("y")).toBeTruthy();
      // Transition to not streaming (same instance, same parts)
      rerender(
        <MessageParts parts={parts} isStreaming={false} />,
      );
      // Body auto-collapses → "y" no longer in the DOM
      expect(screen.queryByText("y")).toBeNull();
    });
  });
});
