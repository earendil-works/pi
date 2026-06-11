import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "../../lib/api";

describe("MessageBubble", () => {
  const baseUserMessage: Message = {
    id: "1",
    sessionId: "s1",
    role: "user",
    parts: [],
    timestamp: "2024-01-01T00:00:00.000Z",
  };

  const baseAssistantMessage: Message = {
    id: "2",
    sessionId: "s1",
    role: "assistant",
    parts: [],
    timestamp: "2024-01-01T00:00:01.000Z",
  };

  // Test 1: user message renders text parts
  it("user message renders text part", () => {
    const message: Message = {
      ...baseUserMessage,
      parts: [{ type: "text", text: "Hello world" }],
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  // Test 2: user message with image shows 40x40 thumbnail
  it("user message with image shows 40x40 thumbnail", () => {
    const message: Message = {
      ...baseUserMessage,
      parts: [
        { type: "text", text: "Check this" },
        { type: "image", mediaType: "image/png", data: "abc123" },
      ],
    };
    render(<MessageBubble message={message} />);
    const img = screen.getByRole("img");
    expect(img).toBeTruthy();
    expect(img.className).toContain("w-10");
    expect(img.className).toContain("h-10");
  });

  // Test 3: assistant message renders header + parts + footer
  it("assistant message renders header + parts + footer", () => {
    const message: Message = {
      ...baseAssistantMessage,
      model: "gpt-4",
      parts: [{ type: "text", text: "I am an assistant" }],
      usage: { input: 100, output: 200 },
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("pi")).toBeTruthy();
    expect(screen.getByText("gpt-4")).toBeTruthy();
    expect(screen.getByText("I am an assistant")).toBeTruthy();
  });

  // Test 4: assistant message without usage does not render footer
  it("assistant message without usage does not render footer", () => {
    const message: Message = {
      ...baseAssistantMessage,
      parts: [{ type: "text", text: "No usage info" }],
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.querySelector(".text-right")).toBeNull();
  });

  // Test 5: assistant message without model does not render model badge
  it("assistant message without model does not render model badge", () => {
    const message: Message = {
      ...baseAssistantMessage,
      parts: [{ type: "text", text: "No model" }],
    };
    render(<MessageBubble message={message} />);
    // Model badge has bg-stone-100 class - should not be present without model
    const modelBadges = document.querySelectorAll('[class*="bg-stone-100"]');
    expect(modelBadges.length).toBe(0);
  });

  // Test 6: toolResult message does not throw (returns null or placeholder)
  it("toolResult message does not throw and returns placeholder", () => {
    const message: Message = {
      id: "3",
      sessionId: "s1",
      role: "toolResult",
      parts: [{ type: "toolResult", toolCallId: "tc1", content: "result content" }],
      timestamp: "2024-01-01T00:00:02.000Z",
    };
    expect(() => render(<MessageBubble message={message} />)).not.toThrow();
    const text = screen.getByText(/tc1.*result/);
    expect(text).toBeTruthy();
  });
});
