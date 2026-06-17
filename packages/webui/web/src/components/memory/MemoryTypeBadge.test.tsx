import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryTypeBadge } from "./MemoryTypeBadge";
import type { MemoryAtomType } from "../../lib/api";

const CASES: Array<{ type: MemoryAtomType; bgClass: string; textClass: string }> = [
  { type: "constraint", bgClass: "bg-red-100", textClass: "text-red-800" },
  { type: "preference", bgClass: "bg-blue-100", textClass: "text-blue-800" },
  { type: "workflow",   bgClass: "bg-purple-100", textClass: "text-purple-800" },
  { type: "knowledge",  bgClass: "bg-green-100", textClass: "text-green-800" },
  { type: "event",      bgClass: "bg-amber-100", textClass: "text-amber-800" },
  { type: "solution",   bgClass: "bg-indigo-100", textClass: "text-indigo-800" },
  { type: "insight",    bgClass: "bg-pink-100", textClass: "text-pink-800" },
];

describe("MemoryTypeBadge", () => {
  for (const { type, bgClass, textClass } of CASES) {
    it(`renders ${type} with ${bgClass} ${textClass}`, () => {
      const { container } = render(<MemoryTypeBadge type={type} />);
      const span = container.querySelector("span");
      expect(span).not.toBeNull();
      expect(span!.className).toContain(bgClass);
      expect(span!.className).toContain(textClass);
      expect(span!.className).toContain("rounded");
      expect(span!.textContent).toBe(type);
    });
  }
});
