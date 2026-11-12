import { useState } from "react";

import { parseLifetime, splitLifetime, type LifetimeUnit } from "./retention.js";
import { Button } from "@/components/ui/button";

/** A number plus a unit, for a lifetime outside the presets. */
export function CustomLifetimeForm({
  initialHours,
  onSave,
  onCancel,
}: {
  /** Prefills the form; absent or 0 (forever) starts at 3 days. */
  initialHours?: number;
  onSave: (hours: number) => void;
  onCancel: () => void;
}) {
  const start = initialHours ? splitLifetime(initialHours) : { amount: 3, unit: "days" as const };
  const [amount, setAmount] = useState(String(start.amount));
  const [unit, setUnit] = useState<LifetimeUnit>(start.unit);
  const parsed = parseLifetime(amount, unit);
  const error = "error" in parsed ? parsed.error : undefined;
  return (
    <form
      data-testid="custom-lifetime"
      onSubmit={(e) => {
        e.preventDefault();
        if ("hours" in parsed) onSave(parsed.hours);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      className="flex w-56 flex-col gap-2 text-sm"
    >
      <label className="text-xs text-muted-foreground" htmlFor="custom-lifetime-amount">
        Delete conversations idle for
      </label>
      <div className="flex gap-1.5">
        <input
          id="custom-lifetime-amount"
          autoFocus
          inputMode="numeric"
          value={amount}
          aria-invalid={!!error}
          aria-describedby={error ? "custom-lifetime-error" : undefined}
          onChange={(e) => setAmount(e.currentTarget.value)}
          className="h-7 w-16 min-w-0 rounded border border-input bg-background px-1.5 text-foreground aria-[invalid=true]:border-destructive"
        />
        <select
          aria-label="Unit"
          value={unit}
          onChange={(e) => setUnit(e.currentTarget.value as LifetimeUnit)}
          className="h-7 flex-1 rounded border border-input bg-background px-1 text-foreground"
        >
          <option value="hours">hours</option>
          <option value="days">days</option>
          <option value="weeks">weeks</option>
        </select>
      </div>
      {error && (
        <p id="custom-lifetime-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!!error}>
          Save
        </Button>
      </div>
    </form>
  );
}
