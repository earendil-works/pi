import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryTypeBadge } from "./MemoryTypeBadge";
import type { MemoryAtomType } from "../../lib/api";

const CASES: Array<{ type: MemoryAtomType; bgClass: string; textClass: string }> = [
  { type: "rule",    bgClass: "bg-blue-100", textClass: "text-blue-800" },
  { type: "fact",    bgClass: "bg-green-100", textClass: "text-green-800" },
  { type: "process", bgClass: "bg-amber-100", textClass: "text-amber-800" },
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
