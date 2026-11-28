"use strict";
/**
 * Helpers the cip-read, cip-write and cip-subscribe plans share.
 *
 * Pure on purpose, like the plans: property lookup is injected so it runs under Jest without
 * Node-RED.
 * @module plan-utils
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBlank = exports.readsProp = void 0;
exports.asText = asText;
exports.positiveWhole = positiveWhole;
exports.evaluateTyped = evaluateTyped;
/** True when `path` (such as "tags" or "tags[0]") is, or is under, the top level property `name`. */
const readsProp = (path, name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`);
exports.readsProp = readsProp;
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
exports.isBlank = isBlank;
/** A string for a tag name, or "" when there is nothing usable. */
function asText(v) {
    if (v === undefined || v === null)
        return "";
    return String(v).trim();
}
/** A positive whole number from a typed value, or an error text naming what was given. */
function positiveWhole(raw, what) {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isInteger(n) || n < 1) {
        return { error: `Invalid ${what} ${JSON.stringify(raw)}: expected a positive whole number` };
    }
    return { value: n };
}
/** A thrown error from evaluating a typed input, as text for the caller. */
function evaluateTyped(evalProp, value, type, msg) {
    try {
        return { value: evalProp(value, type, msg) };
    }
    catch (err) {
        return { error: `Could not read ${type} ${JSON.stringify(value)}: ${err?.message || err}` };
    }
}
//# sourceMappingURL=plan-utils.js.map