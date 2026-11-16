/** Feeds and the Library in day sections: Today, Yesterday, a weekday within the last week, then the date. */
const DAY_MS = 86_400_000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-GB", {weekday: "long"});
  return date.toLocaleDateString("en-GB", {day: "numeric", month: "long", ...(date.getFullYear() === now.getFullYear() ? {} : {year: "numeric"})});
}

/** Consecutive items of the same day, in the order given (callers pass newest first). */
export function groupByDay<T>(items: readonly T[], at: (item: T) => string, now = new Date()): {label: string; items: T[]}[] {
  const groups: {label: string; items: T[]}[] = [];
  for (const item of items) {
    const label = dayLabel(at(item), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({label, items: [item]});
  }
  return groups;
}
