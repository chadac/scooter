/** Header toggle: cycles light, dark, system; names single-variant themes. */
import { Sun, Moon, Monitor } from "lucide-react";

import { Button } from "@/components/ui/button";
import { activeTheme, fixedAppearance, themeStore, useThemeState, type ThemeMode } from "./theme.js";

const NEXT: Record<ThemeMode, ThemeMode> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const LABEL: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const ICON: Record<ThemeMode, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function ThemePicker() {
  const state = useThemeState();
  const theme = activeTheme(state);
  const fixed = fixedAppearance(theme);
  if (fixed) {
    const Icon = ICON[fixed];
    return (
      <Button variant="ghost" size="icon-sm" disabled aria-label={`Theme: ${theme.name}`} title={`Theme: ${theme.name}`}>
        <Icon />
      </Button>
    );
  }
  const Icon = ICON[state.mode];
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Theme: ${LABEL[state.mode]} (click to switch)`}
      title={`Theme: ${LABEL[state.mode]}`}
      onClick={() => themeStore.setMode(NEXT[state.mode])}
    >
      <Icon />
    </Button>
  );
}
