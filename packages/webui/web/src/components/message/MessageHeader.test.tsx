import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageHeader } from "./MessageHeader";

describe("MessageHeader", () => {
  const baseProps = {
    name: "John Doe",
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
  };

  it("renders avatar with first letter of name, name, and formatted time", () => {
    render(<MessageHeader {...baseProps} />);

    const avatar = screen.getByText("J");
    expect(avatar).toBeTruthy();

    const name = screen.getByText("John Doe");
    expect(name).toBeTruthy();

    const time = screen.getByText(/\d+m? ago/);
    expect(time).toBeTruthy();
  });

  it("uses custom avatarLetter when provided", () => {
    render(<MessageHeader {...baseProps} avatarLetter="X" />);

    const avatar = screen.getByText("X");
    expect(avatar).toBeTruthy();
  });

  it("renders model badge when model prop is provided", () => {
    render(<MessageHeader {...baseProps} model="gpt-4-turbo" />);

    const badge = screen.getByText("gpt-4-turbo");
    expect(badge).toBeTruthy();
  });

  it("does not render model badge when model prop is omitted", () => {
    render(<MessageHeader {...baseProps} />);

    const badges = document.querySelectorAll(".bg-stone-100");
    expect(badges.length).toBe(0);
  });

  it("truncates model name to 16 characters", () => {
    const longModelName = "very-long-model-name-that-exceeds-16-chars";
    render(<MessageHeader {...baseProps} model={longModelName} />);

    const badge = screen.getByText("very-long-model-");
    expect(badge).toBeTruthy();
  });
});
