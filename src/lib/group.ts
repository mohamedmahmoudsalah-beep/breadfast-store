/** Groups order lines by category name (system category "null" last). Unfinished lines first inside each group. */
export function groupByCategory<T extends { category_name: string | null; name: string }>(items: T[], isDone?: (i: T) => boolean): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const key = it.category_name ?? "null";
    map.set(key, [...(map.get(key) ?? []), it]);
  }
  const groups = [...map.entries()].map(([k, v]) => [k, [...v].sort((a, b) => Number(isDone?.(a) ?? false) - Number(isDone?.(b) ?? false) || a.name.localeCompare(b.name))] as [string, T[]]);
  return groups.sort((a, b) => (a[0] === "null" ? 1 : b[0] === "null" ? -1 : a[0].localeCompare(b[0])));
}
