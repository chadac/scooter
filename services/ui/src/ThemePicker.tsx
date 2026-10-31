/**
 * Header theme toggle: one ghost icon button that cycles light -> dark -> system,
 * with the icon showing the current mode. Persists via themeStore; "system" follows
 * the OS live (see theme.ts).
 */
import { Sun, Moon, Monitor } from "@/icons";

import { Button } from "@/components/ui/button";
import { themeStore, useTheme, type ThemeMode } from "./theme.js";

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
  const mode = useTheme();
  const Icon = ICON[mode];
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Theme: ${LABEL[mode]} (click to switch)`}
      title={`Theme: ${LABEL[mode]}`}
      onClick={() => themeStore.set(NEXT[mode])}
    >
      <Icon />
    </Button>
  );
}
