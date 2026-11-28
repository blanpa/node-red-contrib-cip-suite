"use strict";
/**
 * Resolves what a cip-read node should read, for nodes that have been upgraded.
 *
 * An upgraded node has a `mode`: "ui" reads the rows of its tag list, "dynamic" reads the tags
 * a message property carries. Nothing else in a message changes what is read, so a message
 * can never override what the editor shows. A row's tag name can come from a message
 * property or an environment variable, because the row says so.
 *
 * A node that has not been upgraded has no `mode`. buildReadPlan() returns null for it and
 * cip-read keeps its original behaviour, where msg.tags and msg.tagName override the node.
 *
 * Pure on purpose: property lookup is injected so this runs under Jest without Node-RED.
 * @module read-plan
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.entryKey = void 0;
exports.duplicateKeyError = duplicateKeyError;
exports.resolvePoll = resolvePoll;
exports.buildReadPlan = buildReadPlan;
const utils_1 = require("./utils");
const plan_utils_1 = require("./plan-utils");
/** Message properties a node might expect to work that it only reads when set up to. */
const WATCHED_PROPS = ["tags"];
const MODES = ["ui", "dynamic"];
const OUTPUTS = ["value", "keyvalue", "keyresult", "array"];
/** The key a tag has in a keyed result: its alias, else the tag exactly as written. */
const entryKey = (entry) => entry.alias || entry.name;
exports.entryKey = entryKey;
/**
 * An error text when two entries would share a key in a keyed result, else undefined.
 * Keys are literal, so MyArray[0..2] and MyArray[5..7] are different keys.
 */
function duplicateKeyError(entries) {
    const seen = new Set();
    for (const entry of entries) {
        if (entry.error)
            continue;
        const key = (0, exports.entryKey)(entry);
        if (seen.has(key)) {
            return `Two tags have the key "${key}". Give one of them a different alias.`;
        }
        seen.add(key);
    }
    return undefined;
}
/** The poll interval of an upgraded node. A missing type is read as `num`. */
function resolvePoll(config, evalProp) {
    const type = config.pollIntervalType || "num";
    if (type === "none")
        return { interval: 0 };
    let raw = config.pollInterval;
    if (type === "env") {
        try {
            raw = evalProp(String(config.pollInterval ?? ""), "env");
        }
        catch (err) {
            return { interval: 0, error: `Invalid poll interval: ${err?.message || err}` };
        }
        if ((0, plan_utils_1.isBlank)(raw)) {
            return { interval: 0, error: `Invalid poll interval: environment variable "${config.pollInterval}" is not set` };
        }
    }
    else if ((0, plan_utils_1.isBlank)(raw) || Number(raw) === 0) {
        // 0 or empty has always meant trigger only
        return { interval: 0 };
    }
    const checked = (0, plan_utils_1.positiveWhole)(raw, "poll interval");
    return checked.error ? { interval: 0, error: checked.error } : { interval: checked.value };
}
/** The plan for a node, or null for a node that has not been upgraded. */
function buildReadPlan(config, evalProp) {
    if (config.mode === undefined || config.mode === null || config.mode === "")
        return null;
    const mode = config.mode;
    const output = (OUTPUTS.includes(config.output) ? config.output : "keyvalue");
    const rows = Array.isArray(config.tagList) ? config.tagList : [];
    const rowType = (row) => row?.tagNameType || "str";
    const dynamic = mode === "dynamic" || rows.some((row) => rowType(row) === "msg");
    // What cannot work whatever the message says
    let error;
    if (!MODES.includes(mode)) {
        error = `Unknown mode ${JSON.stringify(config.mode)}`;
    }
    else if (output === "value" && (mode !== "ui" || rows.length > 1)) {
        error = "The Value output needs a tag list with exactly one tag";
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
    function resolveRows(msg) {
        if (rows.length === 0)
            return { kind: "none", reason: "No tags configured" };
        const entries = rows.map((row, index) => {
            const invalid = (text) => ({
                name: `row ${index + 1}`,
                error: `Invalid tag entry in row ${index + 1}: ${text}`,
            });
            let name;
            if (rowType(row) === "str") {
                name = (0, plan_utils_1.asText)(row?.tagName);
            }
            else {
                const found = (0, plan_utils_1.evaluateTyped)(evalProp, String(row?.tagName ?? ""), rowType(row), msg);
                if (found.error)
                    return invalid(found.error);
                name = (0, plan_utils_1.asText)(found.value);
            }
            if (!name)
                return invalid("the tag name is empty");
            const entry = { name };
            const alias = (0, plan_utils_1.asText)(row?.alias);
            if (alias)
                entry.alias = alias;
            const dataType = (0, plan_utils_1.asText)(row?.dataType) || "auto";
            if (dataType !== "auto")
                entry.dataType = dataType;
            if (dataType === "ARRAY" && !(0, plan_utils_1.isBlank)(row?.arraySize) && row.arraySize !== "auto") {
                const checked = (0, plan_utils_1.positiveWhole)(row.arraySize, `array size for "${name}"`);
                if (checked.error)
                    return { name, error: checked.error };
                entry.arraySize = checked.value;
            }
            return entry;
        });
        // A list nobody has filled in yet is not an error, just nothing to do
        const blank = (row) => rowType(row) === "str" && !(0, plan_utils_1.asText)(row?.tagName) && !(0, plan_utils_1.asText)(row?.alias);
        if (rows.every(blank))
            return { kind: "none", reason: "No tags configured" };
        if (output === "value") {
            const only = entries[0];
            if (only.error)
                return { kind: "batch", entries, source: "tag list" };
            return { kind: "single", tag: only.name, dataType: only.dataType, arraySize: only.arraySize };
        }
        return finish(entries, "tag list");
    }
    function resolveFromMsg(msg) {
        const prop = (0, plan_utils_1.asText)(config.tagsProp) || "tags";
        const found = (0, plan_utils_1.evaluateTyped)(evalProp, prop, "msg", msg);
        if (found.error)
            return { kind: "error", error: found.error };
        const raw = found.value;
        if ((0, plan_utils_1.isBlank)(raw))
            return { kind: "none", reason: `No tags in msg.${prop}` };
        if (typeof raw !== "string" && !Array.isArray(raw)) {
            return { kind: "error", error: `msg.${prop} must be an array or a comma separated string, got ${typeof raw}` };
        }
        return finish((0, utils_1.parseBatchTags)(raw), `msg.${prop}`);
    }
    /** The request for a list of entries, refusing keys a keyed result could not hold. */
    function finish(entries, source) {
        if ((output === "keyvalue" || output === "keyresult") && !entries.some((e) => e.error)) {
            const clash = duplicateKeyError(entries);
            if (clash)
                return { kind: "error", error: clash };
        }
        return { kind: "batch", entries, source };
    }
    // The message properties this plan reads, as the typed inputs name them
    const read = [];
    if (mode === "dynamic")
        read.push((0, plan_utils_1.asText)(config.tagsProp) || "tags");
    for (const row of rows) {
        if (rowType(row) === "msg")
            read.push((0, plan_utils_1.asText)(row?.tagName));
    }
    return {
        mode,
        output,
        dynamic,
        poll: resolvePoll(config, evalProp),
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
//# sourceMappingURL=read-plan.js.map