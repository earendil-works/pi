import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const kebabCase = (str: string): string =>
  str.replace(/([A-Z])/g, "-$1").toLowerCase();

interface ThemeColors {
  bg: string;
  bgSidebar: string;
  bgBubble: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentText: string;
}

interface Theme {
  name: string;
  colors: ThemeColors;
}

interface Settings {
  webui?: {
    theme?: string;
  };
}

// Async theme injection - does not block React render
const injectTheme = async (): Promise<void> => {
  try {
    // Fetch settings
    const settingsRes = await fetch("/api/settings");
    const settings: Settings = settingsRes.ok ? await settingsRes.json() : {};
    const themeName = settings?.webui?.theme ?? "hermes";

    // Fetch theme
    const themeRes = await fetch(`/themes/${themeName}.json`);
    if (!themeRes.ok) {
      // 404 fallback - silent
      return;
    }

    const theme: Theme = await themeRes.json();

    // Inject CSS vars
    Object.entries(theme.colors).forEach(([k, v]) => {
      document.documentElement.style.setProperty(`--${kebabCase(k)}`, v);
    });
  } catch {
    // Fail silently - theme injection errors should not break the app
  }
};

// Start theme injection asynchronously (non-blocking)
injectTheme();

const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
