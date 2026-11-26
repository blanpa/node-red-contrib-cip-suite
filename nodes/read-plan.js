"use strict";
/**
 * Resolves what a cip-read node should read, for nodes that have a `mode`.
 *
 * Every value comes from the source its typed input names (str, num, msg, env, auto). A
 * message property is never consulted unless a field is set to `msg`, so nothing in the
 * message can override what the editor shows.
 *
 * A node saved before modes existed has no `mode`. buildReadPlan() returns null for it and
 * cip-read keeps its original behaviour.
 *
 * Pure on purpose: property lookup is injected so this runs under Jest without Node-RED.
 * @module read-plan
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePoll = resolvePoll;
exports.buildReadPlan = buildReadPlan;
const utils_1 = require("./utils");
/** Message properties a node might expect to work that it only reads when configured to. */
const WATCHED_PROPS = ["tags", "arraySize"];
/** True when `path` (such as "tags" or "tags[0]") is, or is under, the top level property `name`. */
const readsProp = (path, name) => path === name || path.startsWith(`${name}.`) || path.startsWith(`${name}[`);
const MODES = ["single", "multiple", "multiple-msg"];
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
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
/** The poll interval for a node with a mode. A missing type is read as `num`. */
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
        if (isBlank(raw)) {
            return { interval: 0, error: `Invalid poll interval: environment variable "${config.pollInterval}" is not set` };
        }
    }
    else if (isBlank(raw) || Number(raw) === 0) {
        // 0 or empty has always meant trigger only
        return { interval: 0 };
    }
    const checked = positiveWhole(raw, "poll interval");
    return checked.error ? { interval: 0, error: checked.error } : { interval: checked.value };
}
/** The plan for a node, or null for a node saved before modes existed. */
function buildReadPlan(config, evalProp) {
    const mode = MODES.includes(config.mode) ? config.mode : undefined;
    if (!mode)
        return null;
    const tagNameType = config.tagNameType || "str";
    const dataTypeType = config.dataTypeType || "dt";
    const arraySizeType = config.arraySizeType || "auto";
    const dynamic = mode === "multiple-msg" ||
        (mode === "single" && [tagNameType, dataTypeType, arraySizeType].includes("msg"));
    /** Evaluate a typed input, turning a thrown error into text for the caller. */
    const evaluate = (value, type, msg) => {
        try {
            return { value: evalProp(value, type, msg) };
        }
        catch (err) {
            return { error: `Could not read ${type} ${JSON.stringify(value)}: ${err?.message || err}` };
        }
    };
    function resolveSingle(msg) {
        const tagSource = tagNameType === "str" ? { value: config.tagName } : evaluate(String(config.tagName ?? ""), tagNameType, msg);
        if (tagSource.error)
            return { kind: "error", error: tagSource.error };
        const tag = asText(tagSource.value);
        if (!tag)
            return { kind: "none", reason: "No tag name specified" };
        // Any value other than ARRAY or STRUCT is passed through as it always was. A
        // cip-subscribe wired in sends the type it read (such as "DINT"), which is not an error.
        let dataType = "auto";
        if (dataTypeType === "dt") {
            dataType = asText(config.dataType) || "auto";
        }
        else {
            const found = evaluate(String(config.dataType ?? ""), dataTypeType, msg);
            if (found.error)
                return { kind: "error", error: found.error };
            dataType = asText(found.value) || "auto";
        }
        // Array size only means something for ARRAY.
        let arraySize;
        if (dataType === "ARRAY" && arraySizeType !== "auto") {
            let raw = config.arraySize;
            if (arraySizeType !== "num") {
                const found = evaluate(String(config.arraySize ?? ""), arraySizeType, msg);
                if (found.error)
                    return { kind: "error", error: found.error };
                raw = found.value;
            }
            // Nothing there means auto, as for a message without the property
            if (!isBlank(raw)) {
                const checked = positiveWhole(raw, `array size for "${tag}"`);
                if (checked.error)
                    return { kind: "error", error: checked.error };
                arraySize = checked.value;
            }
        }
        return { kind: "single", tag, dataType, arraySize };
    }
    function resolveMultiple(msg) {
        const rows = Array.isArray(config.tagList) ? config.tagList : [];
        if (rows.length === 0)
            return { kind: "none", reason: "No tags configured" };
        const entries = rows.map((row, index) => {
            const invalid = (error) => ({ name: `tags[${index}]`, error: `Invalid tag entry at tags[${index}]: ${error}` });
            let name;
            if ((row?.tagNameType || "str") === "str") {
                name = asText(row?.tagName);
            }
            else {
                const found = evaluate(String(row.tagName ?? ""), row.tagNameType, msg);
                if (found.error)
                    return invalid(found.error);
                name = asText(found.value);
            }
            if (!name)
                return invalid("the tag name is empty");
            const entry = { name };
            const dataType = asText(row?.dataType) || "auto";
            if (dataType !== "auto")
                entry.dataType = dataType;
            if (dataType === "ARRAY" && !isBlank(row?.arraySize) && row.arraySize !== "auto") {
                const checked = positiveWhole(row.arraySize, `arraySize for "${name}"`);
                if (checked.error)
                    return { name, error: checked.error };
                entry.arraySize = checked.value;
            }
            return entry;
        });
        return { kind: "batch", entries, source: "tag list" };
    }
    function resolveFromMsg(msg) {
        const prop = asText(config.tagsProp) || "tags";
        const found = evaluate(prop, "msg", msg);
        if (found.error)
            return { kind: "error", error: found.error };
        const raw = found.value;
        if (isBlank(raw))
            return { kind: "none", reason: `No tags in msg.${prop}` };
        if (typeof raw !== "string" && !Array.isArray(raw)) {
            return { kind: "error", error: `msg.${prop} must be an array or a comma separated string, got ${typeof raw}` };
        }
        return { kind: "batch", entries: (0, utils_1.parseBatchTags)(raw), source: `msg.${prop}` };
    }
    // The message properties this plan reads, as the typed inputs name them
    const read = [];
    if (mode === "single") {
        if (tagNameType === "msg")
            read.push(asText(config.tagName));
        if (dataTypeType === "msg")
            read.push(asText(config.dataType));
        if (arraySizeType === "msg")
            read.push(asText(config.arraySize));
    }
    else if (mode === "multiple-msg") {
        read.push(asText(config.tagsProp) || "tags");
    }
    return {
        mode,
        dynamic,
        poll: resolvePoll(config, evalProp),
        resolve: mode === "single" ? resolveSingle : mode === "multiple" ? resolveMultiple : resolveFromMsg,
        unusedProps: (msg) => msg && typeof msg === "object"
            ? WATCHED_PROPS.filter((name) => msg[name] !== undefined && !read.some((path) => readsProp(path, name)))
            : [],
    };
}
//# sourceMappingURL=read-plan.js.map