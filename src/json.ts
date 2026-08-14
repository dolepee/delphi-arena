export function stringifyJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry,
    space,
  );
}
