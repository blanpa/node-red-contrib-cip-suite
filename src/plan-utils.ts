/**
 * Helpers the cip-read, cip-write and cip-subscribe plans share.
 *
 * Pure on purpose, like the plans: property lookup is injected so it runs under Jest without
 * Node-RED.
 * @module plan-utils
 */

/** Evaluate a typed input value. In cip-read this is RED.util.evaluateNodeProperty. */
export type EvalProp = (value: string, type: string, msg?: any) => any;

/** True when `path` (such as "tags" or "tags[0]") is, or is under, the top level property `name`. */
export const readsProp = (path: string, name: string): boolean =>
  path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`);

export const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** A string for a tag name, or "" when there is nothing usable. */
export function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** A positive whole number from a typed value, or an error text naming what was given. */
export function positiveWhole(raw: unknown, what: string): { value?: number; error?: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) {
    return { error: `Invalid ${what} ${JSON.stringify(raw)}: expected a positive whole number` };
  }
  return { value: n };
}

/** A thrown error from evaluating a typed input, as text for the caller. */
export function evaluateTyped(
  evalProp: EvalProp,
  value: string,
  type: string,
  msg: any
): { value?: any; error?: string } {
  try {
    return { value: evalProp(value, type, msg) };
  } catch (err: any) {
    return { error: `Could not read ${type} ${JSON.stringify(value)}: ${err?.message || err}` };
  }
}
