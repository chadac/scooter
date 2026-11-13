/** Settings → Appearance: theme cards with live previews, plus mode. */
import type { CSSProperties } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { activeTheme, fixedAppearance, themeStore, useThemeState, type Theme, type ThemeMode, type ThemeVariant } from "./theme.js";

const MODES: { id: ThemeMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

function Swatch({ variant }: { variant: ThemeVariant }) {
  const vars = Object.fromEntries(Object.entries(variant.tokens).map(([k, v]) => [`--${k}`, v])) as CSSProperties;
  // The appearance class reselects globals.css's tokens for unset ones.
  return (
    <div
      data-testid="theme-swatch"
      data-appearance={variant.appearance}
      className={cn(variant.appearance, "flex flex-1 items-center gap-2 rounded border bg-background px-2 py-1.5")}
      style={vars}
    >
      <span className="text-sm font-medium text-foreground">Aa</span>
      <span className="text-xs text-muted-foreground">text</span>
      <span className="ml-auto flex gap-1" aria-hidden>
        {["bg-brand", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"].map((c) => (
          <span key={c} className={cn("size-2.5 rounded-full", c)} />
        ))}
      </span>
    </div>
  );
}

function ThemeCard({ theme, selected, isDefault }: { theme: Theme; selected: boolean; isDefault: boolean }) {
  const fixed = fixedAppearance(theme);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={`theme-option-${theme.id}`}
      onClick={() => themeStore.setTheme(theme.id)}
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3 text-left transition-colors hover:bg-accent/50",
        selected && "border-ring ring-1 ring-ring",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="font-medium">{theme.name}</span>
        <span className="text-xs text-muted-foreground">{fixed ? `${fixed} only` : "light + dark"}</span>
        {isDefault && (
          <span data-testid="theme-default-badge" className="rounded-sm border px-1 text-xs text-muted-foreground">
            Default
          </span>
        )}
        {selected && <Check className="ml-auto size-4 text-brand" aria-hidden />}
      </span>
      <span className="flex flex-col gap-1.5 sm:flex-row">
        {theme.variants.map((v) => (
          <Swatch key={v.appearance} variant={v} />
        ))}
      </span>
    </button>
  );
}

export function AppearanceSection() {
  const state = useThemeState();
  const active = activeTheme(state);
  const fixed = fixedAppearance(active);
  return (
    <section data-testid="appearance-section" className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Theme</h2>
          <p className="text-sm text-muted-foreground">Your choice is saved to your account and follows you to other devices.</p>
        </div>
        <div role="radiogroup" aria-label="Theme" className="grid gap-2 sm:grid-cols-2">
          {state.themes.map((t) => (
            <ThemeCard key={t.id} theme={t} selected={t.id === active.id} isDefault={t.id === state.defaultId} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="font-medium">Mode</h2>
          <p className="text-sm text-muted-foreground">
            {fixed
              ? `${active.name} has only a ${fixed} variant.`
              : "System follows your device. The sun/moon button in the header switches this too."}
          </p>
        </div>
        <div role="radiogroup" aria-label="Mode" className="flex gap-1">
          {MODES.map((m) => (
            <Button
              key={m.id}
              variant={state.mode === m.id ? "default" : "outline"}
              size="sm"
              role="radio"
              aria-checked={state.mode === m.id}
              data-testid={`theme-mode-${m.id}`}
              disabled={fixed !== undefined}
              onClick={() => themeStore.setMode(m.id)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </div>
    </section>
  );
}
