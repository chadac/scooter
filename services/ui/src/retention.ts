/** Conversation retention policy: idle lifetimes in hours, 0 meaning forever. */

/** The router's upper bound: ten years. */
const MAX_LIFETIME_HOURS = 87600;

/** Presets offered before "Custom…". */
export const LIFETIMES: Array<[number, string]> = [
  [0, "Never"],
  [24, "1 day"],
  [168, "1 week"],
  [720, "30 days"],
];

/** The presets plus a custom value, shortest first after "Never". */
export function lifetimeChoices(custom?: number): Array<[number, string]> {
  if (custom === undefined || LIFETIMES.some(([h]) => h === custom)) return LIFETIMES;
  return [...LIFETIMES, [custom, lifetimeLabel(custom)] as [number, string]].sort(([a], [b]) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
}

export type LifetimeUnit = "hours" | "days" | "weeks";

const UNIT_HOURS: Record<LifetimeUnit, number> = { hours: 1, days: 24, weeks: 168 };

/** "1 day", "2 weeks", "12 hours" or "never". */
export function lifetimeLabel(hours: number): string {
  if (hours === 0) return "never";
  const unit = hours % 168 === 0 ? "week" : hours % 24 === 0 ? "day" : "hour";
  const n = hours / UNIT_HOURS[`${unit}s`];
  return n === 1 ? `1 ${unit}` : `${n} ${unit}s`;
}

/** The largest unit that divides `hours` evenly, for prefilling the form. */
export function splitLifetime(hours: number): { amount: number; unit: LifetimeUnit } {
  const unit: LifetimeUnit = hours > 0 && hours % 168 === 0 ? "weeks" : hours > 0 && hours % 24 === 0 ? "days" : "hours";
  return { amount: hours / UNIT_HOURS[unit], unit };
}

/** Hours for `amount` `unit`, or why it can't be a lifetime. */
export function parseLifetime(amount: string, unit: LifetimeUnit): { hours: number } | { error: string } {
  const n = Number(amount.trim());
  if (!amount.trim() || !Number.isInteger(n) || n < 1) return { error: "Enter a whole number, 1 or more" };
  const hours = n * UNIT_HOURS[unit];
  if (hours > MAX_LIFETIME_HOURS) return { error: "At most 10 years" };
  return { hours };
}
