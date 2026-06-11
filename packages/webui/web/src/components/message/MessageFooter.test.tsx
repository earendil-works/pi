import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MessageFooter } from "./MessageFooter";

describe("MessageFooter", () => {
  it("returns null when usage is undefined", () => {
    const { container } = render(<MessageFooter />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null when usage is explicitly undefined", () => {
    const { container } = render(<MessageFooter usage={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders usage text with small numbers", () => {
    const { container } = render(<MessageFooter usage={{ input: 5, output: 10 }} />);
    const div = container.firstChild as HTMLElement;
    expect(div).not.toBeNull();
    expect(div.textContent).toBe("5 in · 10 out");
    expect(div.className).toBe("mt-1 text-right text-[10px] text-stone-400");
  });

  it("renders usage text with large numbers (thousands)", () => {
    const { container } = render(<MessageFooter usage={{ input: 1500, output: 2300 }} />);
    const div = container.firstChild as HTMLElement;
    expect(div).not.toBeNull();
    expect(div.textContent).toBe("1.5K in · 2.3K out");
  });

  it("renders usage text with large numbers (millions)", () => {
    const { container } = render(<MessageFooter usage={{ input: 1500000, output: 2300000 }} />);
    const div = container.firstChild as HTMLElement;
    expect(div).not.toBeNull();
    expect(div.textContent).toBe("1.5M in · 2.3M out");
  });

  it("renders usage text with large numbers (billions)", () => {
    const { container } = render(<MessageFooter usage={{ input: 1500000000, output: 2300000000 }} />);
    const div = container.firstChild as HTMLElement;
    expect(div).not.toBeNull();
    expect(div.textContent).toBe("1.5B in · 2.3B out");
  });

  it("applies correct CSS classes", () => {
    const { container } = render(<MessageFooter usage={{ input: 100, output: 200 }} />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain("mt-1");
    expect(div.className).toContain("text-right");
    expect(div.className).toContain("text-[10px]");
    expect(div.className).toContain("text-stone-400");
  });
});
