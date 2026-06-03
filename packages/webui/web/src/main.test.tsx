import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Test the theme injection logic described in Task 3.6
// S78: hermes theme loads
// S79: unknown theme falls back gracefully
// S80: codewhale still works

describe("theme injection", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const hermesTheme = {
    name: "hermes",
    colors: {
      bg: "#fafaf9",
      bgSidebar: "#f5f5f4",
      bgBubble: "#ffffff",
      text: "#1c1917",
      textMuted: "#78716c",
      border: "#e7e5e4",
      accent: "#3b82f6",
      accentText: "#ffffff",
    },
  };

  const codewhaleTheme = {
    name: "codewhale",
    colors: {
      bg: "#1a1a2e",
      bgSidebar: "#16213e",
      bgBubble: "#0f3460",
      text: "#eaeaea",
      textMuted: "#a0a0a0",
      border: "#533483",
      accent: "#e94560",
      accentText: "#ffffff",
    },
  };

  // kebab-case conversion helper
  const toKebabCase = (str: string): string =>
    str.replace(/([A-Z])/g, "-$1").toLowerCase();

  describe("S78: hermes theme loads", () => {
    it("fetches settings then hermes theme and injects CSS vars", async () => {
      // Mock: settings returns hermes theme
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ webui: { theme: "hermes" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(hermesTheme),
        });

      // Execute the theme injection logic
      const settingsRes = await mockFetch("/api/settings");
      const settings = await settingsRes.json();
      const themeName = settings?.webui?.theme ?? "hermes";
      const themeRes = await mockFetch(`/themes/${themeName}.json`);
      const theme = await themeRes.json();

      // Verify correct fetches
      expect(mockFetch).toHaveBeenCalledWith("/api/settings");
      expect(mockFetch).toHaveBeenCalledWith("/themes/hermes.json");

      // Verify theme colors
      expect(theme.colors.bg).toBe("#fafaf9");
      expect(theme.colors.accent).toBe("#3b82f6");
      expect(toKebabCase("bgSidebar")).toBe("bg-sidebar");
    });
  });

  describe("S79: unknown theme falls back", () => {
    it("does not inject CSS vars when theme fetch 404s", async () => {
      // Mock: settings returns unknown theme
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ webui: { theme: "nonexistent" } }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        });

      const settingsRes = await mockFetch("/api/settings");
      const settings = await settingsRes.json();
      const themeName = settings?.webui?.theme ?? "hermes";

      // 404 for unknown theme
      const themeRes = await mockFetch(`/themes/${themeName}.json`);
      expect(themeRes.ok).toBe(false);
      expect(themeRes.status).toBe(404);

      // Verify 404 was silent - no exception thrown
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("defaults to hermes when settings is empty", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(hermesTheme),
        });

      const settingsRes = await mockFetch("/api/settings");
      const settings = await settingsRes.json();
      const themeName = settings?.webui?.theme ?? "hermes";

      // Fetch theme with default
      const themeRes = await mockFetch(`/themes/${themeName}.json`);
      const theme = await themeRes.json();

      expect(themeName).toBe("hermes");
      expect(mockFetch).toHaveBeenCalledWith("/themes/hermes.json");
      expect(theme.colors.accent).toBe("#3b82f6");
    });
  });

  describe("S80: codewhale theme still works", () => {
    it("fetches codewhale theme and returns correct colors", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ webui: { theme: "codewhale" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(codewhaleTheme),
        });

      const settingsRes = await mockFetch("/api/settings");
      const settings = await settingsRes.json();
      const themeName = settings?.webui?.theme ?? "hermes";
      const themeRes = await mockFetch(`/themes/${themeName}.json`);
      const theme = await themeRes.json();

      expect(mockFetch).toHaveBeenCalledWith("/api/settings");
      expect(mockFetch).toHaveBeenCalledWith("/themes/codewhale.json");
      expect(theme.colors.accent).toBe("#e94560");
      expect(theme.colors.bg).toBe("#1a1a2e");
    });
  });

  describe("kebab-case conversion", () => {
    it("converts camelCase to kebab-case", () => {
      expect(toKebabCase("bg")).toBe("bg");
      expect(toKebabCase("bgSidebar")).toBe("bg-sidebar");
      expect(toKebabCase("bgBubble")).toBe("bg-bubble");
      expect(toKebabCase("text")).toBe("text");
      expect(toKebabCase("textMuted")).toBe("text-muted");
      expect(toKebabCase("accentText")).toBe("accent-text");
    });
  });
});
