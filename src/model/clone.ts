/**
 * Deep copy of JSON-like report data (report definitions contain no Dates or functions).
 * Unlike structuredClone this reads through Vue reactive proxies, which can end up nested
 * inside the raw report after operations like `r.elements = r.elements.filter(...)`.
 */
export function deepClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
