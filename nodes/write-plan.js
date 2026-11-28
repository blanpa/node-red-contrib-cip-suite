"use strict";
/**
 * Resolves what a cip-write node should write, for nodes that have been upgraded.
 *
 * An upgraded node has a `mode`: "ui" writes the rows of its tag list, "dynamic" writes the
 * tags a message property carries. Nothing else in a message changes what is written, so a
 * message can never override what the editor shows.
 *
 * In UI mode the values come from the **Value** field (`msg.payload` by default):
 *  - one row: the value is written to that tag as it is, so an array goes to an array tag and
 *    an object to a UDT.
 *  - several rows: an array of values (by position), an object keyed by alias or tag, or an
 *    array of `{ name | tagName, value }` entries, the shape cip-read and cip-subscribe send.
 *
 * Everything is checked before anything is written, so a bad message never writes half a set.
 *
 * A node saved before it was upgraded has no `mode`. buildWritePlan() returns null for it and
 * cip-write keeps its original behaviour, where msg.tags and msg.tagName override the node.
 *
 * Pure on purpose: property lookup is injected so this runs under Jest without Node-RED.
 * @module write-plan
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildWritePlan = buildWritePlan;
const plan_utils_1 = require("./plan-utils");
const read_plan_1 = require("./read-plan");
const WATCHED_PROPS = ["tags"];
const MODES = ["ui", "dynamic"];
const OUTPUTS = ["result", "array", "keyresult"];
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);
/**
 * A result as cip-read (Key Result pairs) or cip-write sends it: `{ tagName, value, ... }`. It goes
 * by the tagName, never by a `value` key alone, since a UDT can have a member called value.
 */
const isResultLike = (v) => isRecord(v) && typeof v.tagName === "string" && "value" in v;
/** The tag an entry names, by `name` or `tagName`, or "" when it names none. */
const entryName = (entry) => {
    const raw = typeof entry?.name === "string" ? entry.name : entry?.tagName;
    return typeof raw === "string" ? raw.trim() : "";
};
/**
 * True for an array of `{ name | tagName, value }` entries. It goes by the name, never by a
 * `value` key, since a UDT can have a member called value.
 */
const looksLikeEntries = (list) => Array.isArray(list) &&
    list.length > 0 &&
    list.every((e) => isRecord(e) && (typeof e.name === "string" || typeof e.tagName === "string"));
/** The plan for a node, or null for a node that has not been upgraded. */
function buildWritePlan(config, evalProp) {
    if (config.mode === undefined || config.mode === null || config.mode === "")
        return null;
    const mode = config.mode;
    const output = (OUTPUTS.includes(config.output) ? config.output : "array");
    const rows = Array.isArray(config.tagList) ? config.tagList : [];
    const rowType = (row) => row?.tagNameType || "str";
    const valueType = config.valueType || "msg";
    let error;
    if (!MODES.includes(mode)) {
        error = `Unknown mode ${JSON.stringify(config.mode)}`;
    }
    else if (output === "result" && (mode !== "ui" || rows.length > 1)) {
        error = "The Result output needs a tag list with exactly one tag";
    }
    else if (mode === "ui" && rows.length > 1 && ["str", "num", "bool"].includes(valueType)) {
        error = "Several tags need their values from a message property, json or an environment variable, not a fixed string, number or boolean";
    }
    else {
        const aliases = new Set();
        for (const row of rows) {
            const alias = (0, plan_utils_1.asText)(row?.alias);
            if (!alias)
                continue;
            if (aliases.has(alias)) {
                error = `Two tags have the alias "${alias}". An alias can only be used once.`;
                break;
            }
            aliases.add(alias);
        }
    }
    /** The value the Value field names. */
    function valueFor(msg) {
        if (valueType === "str")
            return { value: config.value === undefined ? "" : String(config.value) };
        return (0, plan_utils_1.evaluateTyped)(evalProp, String(config.value ?? ""), valueType, msg);
    }
    function resolveRows(msg) {
        if (rows.length === 0)
            return { kind: "none", reason: "No tags configured" };
        const blank = (row) => rowType(row) === "str" && !(0, plan_utils_1.asText)(row?.tagName) && !(0, plan_utils_1.asText)(row?.alias);
        if (rows.every(blank))
            return { kind: "none", reason: "No tags configured" };
        // The tags first, so every bad row is named
        const problems = [];
        const targets = rows.map((row, index) => {
            let name;
            if (rowType(row) === "str") {
                name = (0, plan_utils_1.asText)(row?.tagName);
            }
            else {
                const found = (0, plan_utils_1.evaluateTyped)(evalProp, String(row?.tagName ?? ""), rowType(row), msg);
                if (found.error) {
                    problems.push(`row ${index + 1}: ${found.error}`);
                    return { name: "" };
                }
                name = (0, plan_utils_1.asText)(found.value);
            }
            if (!name)
                problems.push(`row ${index + 1}: the tag name is empty`);
            const alias = (0, plan_utils_1.asText)(row?.alias);
            const dataType = (0, plan_utils_1.asText)(row?.dataType) || "auto";
            return { name, alias: alias || undefined, dataType: dataType === "auto" ? undefined : dataType };
        });
        if (problems.length > 0) {
            return { kind: "error", error: `Invalid tag list, nothing was written. ${problems.join("; ")}` };
        }
        const found = valueFor(msg);
        if (found.error)
            return { kind: "error", error: found.error };
        const value = found.value;
        const item = (i, v) => {
            const t = targets[i];
            const out = { name: t.name, value: v };
            if (t.alias)
                out.alias = t.alias;
            if (t.dataType)
                out.dataType = t.dataType;
            return out;
        };
        // One row: the value goes to that tag as it is
        if (rows.length === 1) {
            if (value === undefined || value === null)
                return { kind: "error", error: "No value to write" };
            return { kind: "write", items: [item(0, value)], source: "tag list" };
        }
        if (value === undefined || value === null) {
            return { kind: "error", error: "No values to write. Expected an array or an object with a value for each tag." };
        }
        // Several results may not share a key
        const keyed = (items) => {
            if (output === "keyresult") {
                const clash = (0, read_plan_1.duplicateKeyError)(items);
                if (clash)
                    return { kind: "error", error: clash };
            }
            return { kind: "write", items, source: "tag list" };
        };
        const where = (i) => (targets[i].alias ? `"${targets[i].alias}" (${targets[i].name})` : `"${targets[i].name}"`);
        const missing = [];
        const values = new Array(rows.length).fill(undefined);
        /** The row a key (an alias, or a tag as written) is for. */
        const rowFor = (key) => {
            const byAlias = targets.map((t, i) => (t.alias === key ? i : -1)).filter((i) => i >= 0);
            const hits = byAlias.length > 0 ? byAlias : targets.map((t, i) => (t.name === key ? i : -1)).filter((i) => i >= 0);
            if (hits.length === 0)
                return { error: `"${key}" is not one of the tags` };
            if (hits.length > 1)
                return { error: `"${key}" is more than one of the tags, so the values cannot be matched by name` };
            return { index: hits[0] };
        };
        if (looksLikeEntries(value) || (isRecord(value) && !Array.isArray(value))) {
            const pairs = Array.isArray(value)
                ? value.map((e) => [entryName(e), e.value])
                : Object.entries(value).map(([k, v]) => [k, isResultLike(v) ? v.value : v]);
            const bad = [];
            pairs.forEach(([key, v], position) => {
                if (!key) {
                    bad.push(`entry ${position} has no name`);
                    return;
                }
                const hit = rowFor(key);
                if (hit.error) {
                    bad.push(hit.error);
                    return;
                }
                if (values[hit.index] !== undefined) {
                    bad.push(`"${key}" is given twice`);
                    return;
                }
                values[hit.index] = v === null ? undefined : v;
            });
            if (bad.length > 0)
                return { kind: "error", error: `Invalid values, nothing was written. ${bad.join("; ")}` };
        }
        else if (Array.isArray(value)) {
            if (value.length !== rows.length) {
                return {
                    kind: "error",
                    error: `Invalid values, nothing was written. The list has ${rows.length} tags but there ${value.length === 1 ? "is 1 value" : `are ${value.length} values`}`,
                };
            }
            value.forEach((v, i) => {
                values[i] = v === null ? undefined : v;
            });
        }
        else {
            return {
                kind: "error",
                error: `Invalid values, nothing was written. Expected an array or an object with a value for each tag, got ${typeof value}`,
            };
        }
        values.forEach((v, i) => {
            if (v === undefined)
                missing.push(where(i));
        });
        if (missing.length > 0) {
            return { kind: "error", error: `No value for ${missing.join(", ")}, nothing was written` };
        }
        return keyed(values.map((v, i) => item(i, v)));
    }
    function resolveFromMsg(msg) {
        const prop = (0, plan_utils_1.asText)(config.tagsProp) || "tags";
        const found = (0, plan_utils_1.evaluateTyped)(evalProp, prop, "msg", msg);
        if (found.error)
            return { kind: "error", error: found.error };
        const raw = found.value;
        const source = `msg.${prop}`;
        if ((0, plan_utils_1.isBlank)(raw) || (Array.isArray(raw) && raw.length === 0))
            return { kind: "none", reason: `No tags in ${source}` };
        const bad = [];
        const items = [];
        if (Array.isArray(raw)) {
            raw.forEach((e, index) => {
                if (!isRecord(e)) {
                    bad.push(`${source}[${index}]: expected an object with a name and a value, got ${e === null ? "null" : typeof e}`);
                    return;
                }
                const name = entryName(e);
                if (!name) {
                    bad.push(`${source}[${index}]: an object needs a "name" or "tagName" string`);
                    return;
                }
                if (e.value === undefined || e.value === null) {
                    bad.push(`${source}[${index}]: no value for "${name}"`);
                    return;
                }
                const item = { name, value: e.value };
                if (typeof e.alias === "string" && e.alias.trim())
                    item.alias = e.alias.trim();
                if (e.dataType != null && String(e.dataType) !== "auto")
                    item.dataType = String(e.dataType);
                items.push(item);
            });
        }
        else if (isRecord(raw)) {
            for (const [key, v] of Object.entries(raw)) {
                // A result (the Key Result pairs of cip-read) names its tag, and the key is its alias
                const name = (isResultLike(v) ? v.tagName : key).trim();
                const value = isResultLike(v) ? v.value : v;
                if (!name) {
                    bad.push(`${source} has an empty tag name`);
                }
                else if (value === undefined || value === null) {
                    bad.push(`${source}: no value for "${key}"`);
                }
                else {
                    const item = { name, value };
                    if (isResultLike(v) && key !== name)
                        item.alias = key;
                    items.push(item);
                }
            }
            if (items.length === 0 && bad.length === 0)
                return { kind: "none", reason: `No tags in ${source}` };
        }
        else {
            return { kind: "error", error: `${source} must be an array of { name, value } or an object of values by tag name, got ${typeof raw}` };
        }
        if (bad.length > 0)
            return { kind: "error", error: `Invalid ${source}, nothing was written. ${bad.join("; ")}` };
        if (output === "keyresult") {
            const clash = (0, read_plan_1.duplicateKeyError)(items);
            if (clash)
                return { kind: "error", error: `Invalid ${source}, nothing was written. ${clash}` };
        }
        return { kind: "write", items, source };
    }
    // The message properties this plan reads, as the typed inputs name them
    const read = [];
    if (mode === "dynamic")
        read.push((0, plan_utils_1.asText)(config.tagsProp) || "tags");
    if (valueType === "msg")
        read.push((0, plan_utils_1.asText)(config.value) || "payload");
    for (const row of rows) {
        if (rowType(row) === "msg")
            read.push((0, plan_utils_1.asText)(row?.tagName));
    }
    return {
        mode,
        output,
        error,
        resolve: error
            ? () => ({ kind: "error", error: error })
            : mode === "dynamic"
                ? resolveFromMsg
                : resolveRows,
        unusedProps: (msg) => msg && typeof msg === "object"
            ? WATCHED_PROPS.filter((name) => msg[name] !== undefined && !read.some((path) => (0, plan_utils_1.readsProp)(path, name)))
            : [],
    };
}
//# sourceMappingURL=write-plan.js.map