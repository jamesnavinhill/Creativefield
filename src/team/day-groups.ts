/** Feeds and the Library in day sections: Today, Yesterday, a weekday within the last week, then the date. */
const DAY_MS = 86_400_000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/* One formatter each, and one label per calendar day: a feed asks for the label of every item on every draw, and
   building a date formatter per item cost hundreds of milliseconds. */
const WEEKDAY = new Intl.DateTimeFormat("en-GB", {weekday: "long"});
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {day: "numeric", month: "long"});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {day: "numeric", month: "long", year: "numeric"});
const labels = new Map<string, string>();

export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = startOfDay(now), day = startOfDay(date), key = `${today}:${day}`;
  const known = labels.get(key);
  if (known) return known;
  const days = Math.round((today - day) / DAY_MS);
  const label = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? WEEKDAY.format(date)
    : (date.getFullYear() === now.getFullYear() ? DAY_MONTH : DAY_MONTH_YEAR).format(date);
  if (labels.size > 2000) labels.clear();
  labels.set(key, label);
  return label;
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
