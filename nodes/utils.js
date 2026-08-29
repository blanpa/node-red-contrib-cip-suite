"use strict";
/**
 * Shared utilities for cip-suite nodes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATUS = void 0;
exports.parseTagName = parseTagName;
exports.parseProgramScope = parseProgramScope;
exports.findTagListEntry = findTagListEntry;
exports.canonicalizeTagName = canonicalizeTagName;
exports.resolveMemberInfo = resolveMemberInfo;
exports.getBit = getBit;
exports.setBit = setBit;
exports.buildBitMasks = buildBitMasks;
exports.cipStatusText = cipStatusText;
exports.cipTypeName = cipTypeName;
exports.describeCipError = describeCipError;
exports.toCipError = toCipError;
exports.debounce = debounce;
exports.parseTagList = parseTagList;
exports.withTiming = withTiming;
const types_1 = require("./types");
function parseTagName(tagName) {
    const result = {
        baseName: tagName,
        bitIndex: null,
        arrayIndex: null,
        arrayStart: null,
        arrayEnd: null,
        isRange: false,
    };
    // Array range: MyArray[0..9]
    const rangeMatch = tagName.match(/^(.+)\[(\d+)\.\.(\d+)\]$/);
    if (rangeMatch) {
        result.baseName = rangeMatch[1];
        result.arrayStart = parseInt(rangeMatch[2], 10);
        result.arrayEnd = parseInt(rangeMatch[3], 10);
        result.isRange = true;
        return result;
    }
    // Array element: MyArray[3]
    const arrayMatch = tagName.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
        result.baseName = arrayMatch[1];
        result.arrayIndex = parseInt(arrayMatch[2], 10);
        return result;
    }
    // Bit access: MyDint.5 (but NOT Program:MainProgram.MyTag)
    // Bit index is a single digit after the last dot, and the part before is not "Program:..."
    const bitMatch = tagName.match(/^(.+)\.(\d+)$/);
    if (bitMatch && !bitMatch[1].includes(":")) {
        result.baseName = bitMatch[1];
        result.bitIndex = parseInt(bitMatch[2], 10);
        return result;
    }
    return result;
}
/**
 * Split a program-scoped tag into program name and tag path.
 * "Program:MainProgram.MyTag" → { program: "MainProgram", name: "MyTag" }
 */
function parseProgramScope(tagName) {
    const match = tagName.match(/^Program:([^.\[]+)[.](.+)$/);
    if (match) {
        return { program: match[1], name: match[2] };
    }
    return { program: null, name: tagName };
}
/** Strip a trailing array subscript ("FBACTUAL[3]" -> "FBACTUAL"). */
function stripSubscript(segment) {
    return segment.replace(/\[[^\]]*\]/g, "");
}
/** Case-insensitive comparison, the way Logix treats tag and member names. */
function sameName(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}
/**
 * Find the tag-list entry for the root of a tag path.
 * Logix tag and member names are case-insensitive, so the lookup is too.
 */
function findTagListEntry(tagList, rootName, program = null) {
    if (!tagList?.tags?.length)
        return null;
    const wanted = stripSubscript(rootName);
    return (tagList.tags.find((entry) => sameName(stripSubscript(String(entry.name)), wanted) &&
        sameName(String(entry.program ?? ""), String(program ?? ""))) ?? null);
}
/**
 * Rewrite a tag path so every segment uses the exact casing the controller
 * reports in its tag list and UDT templates.
 *
 * st-ethernet-ip matches UDT member names case-sensitively when it decides
 * whether to build a `Structure` (which decodes into an object) or a plain
 * `Tag` (which hands back the raw struct bytes). A path typed as
 * `fis_stn[0].local` therefore reads back as a `Buffer` instead of an object,
 * even though the same path works fine in Studio 5000. Canonicalising the path
 * first makes the match succeed. Segments that cannot be resolved are passed
 * through untouched.
 */
function canonicalizeTagName(tagName, tagList, program = null) {
    if (!tagList?.tags?.length)
        return tagName;
    const segments = tagName.split(".");
    const rootEntry = findTagListEntry(tagList, segments[0], program);
    if (!rootEntry)
        return tagName;
    const out = [
        stripSubscript(String(rootEntry.name)) + subscriptOf(segments[0]),
    ];
    let template = tagList.templates?.[rootEntry.type?.code];
    for (let i = 1; i < segments.length; i++) {
        const bare = stripSubscript(segments[i]);
        const member = template?._members?.find((entry) => sameName(String(entry.name), bare));
        if (!member) {
            // Unknown member (or a bit index such as ".5") — keep the rest verbatim.
            return [...out, ...segments.slice(i)].join(".");
        }
        out.push(String(member.name) + subscriptOf(segments[i]));
        template = tagList.templates?.[member.type?.code];
    }
    return out.join(".");
}
/** Return the subscript part of a segment ("Foo[3]" -> "[3]", "Foo" -> ""). */
function subscriptOf(segment) {
    const at = segment.indexOf("[");
    return at === -1 ? "" : segment.slice(at);
}
/**
 * Resolve UDT member metadata (array length, nested struct) from the PLC tag list.
 * `isArray` is true when the resolved path is an array; `arraySize` holds the
 * element count when known, or null when it is not carried by the tag list and
 * has to be resolved from the controller (see `resolveArrayLength`) — the
 * Symbol Object list request only asks for name and type, so controller- and
 * program-scoped array tags never carry their length here.
 */
function resolveMemberInfo(tagName, tagList, program = null) {
    const empty = { arraySize: null, isStruct: false, isArray: false };
    if (!tagList?.tags?.length || !tagList.templates)
        return empty;
    const rawSegments = tagName.split(".");
    const segments = rawSegments.map(stripSubscript);
    const tag = findTagListEntry(tagList, segments[0], program);
    if (!tag)
        return empty;
    if (segments.length === 1) {
        // A subscripted root ("MyArray[3]") addresses a single element, not the array.
        const isArray = tag.type.arrayDims > 0 && !subscriptOf(rawSegments[0]);
        return {
            arraySize: isArray ? null : 1,
            isStruct: !!tag.type.structure,
            isArray,
        };
    }
    let template = tagList.templates[tag.type.code];
    for (let i = 1; i < segments.length; i++) {
        const member = template?._members?.find((entry) => sameName(String(entry.name), segments[i]));
        if (!member)
            return empty;
        if (i === segments.length - 1) {
            const isArray = member.type.arrayDims > 0 && !subscriptOf(rawSegments[i]);
            return {
                arraySize: isArray ? member.info : 1,
                isStruct: !!member.type.structure,
                isArray,
            };
        }
        template = tagList.templates[member.type.code];
        if (!template)
            return empty;
    }
    return empty;
}
/**
 * Extract a bit from an integer value.
 */
function getBit(value, bitIndex) {
    return ((value >>> bitIndex) & 1) === 1;
}
/**
 * Set a specific bit in an integer value.
 */
function setBit(value, bitIndex, bitValue) {
    if (bitValue) {
        return value | (1 << bitIndex);
    }
    else {
        return value & ~(1 << bitIndex);
    }
}
/**
 * Build OR/AND masks for Read-Modify-Write service (0x4E).
 * OR mask sets bits, AND mask clears bits.
 */
function buildBitMasks(byteSize, bitIndex, bitValue) {
    const orMask = Buffer.alloc(byteSize, 0x00);
    const andMask = Buffer.alloc(byteSize, 0xff);
    const byteOffset = Math.floor(bitIndex / 8);
    const bitOffset = bitIndex % 8;
    if (bitValue) {
        // Set bit: OR mask has the bit set
        orMask[byteOffset] = 1 << bitOffset;
    }
    else {
        // Clear bit: AND mask has the bit cleared
        andMask[byteOffset] = ~(1 << bitOffset) & 0xff;
    }
    return { orMask, andMask };
}
/**
 * Human-readable CIP status text.
 */
function cipStatusText(code) {
    return types_1.CIP_STATUS[code] || `Unknown (0x${code.toString(16)})`;
}
/**
 * Human-readable CIP data type name.
 */
function cipTypeName(code) {
    return types_1.CIP_TYPE_NAMES[code] || `0x${code.toString(16)}`;
}
/**
 * Render whatever st-ethernet-ip threw as readable text.
 *
 * The library rejects a failed connect with a bare object such as
 * `{ generalStatusCode: 1, extendedStatus: [273] }`, so reading `.message` off it yields
 * "undefined" and the real cause is lost.
 */
function describeCipError(err) {
    if (err === null || err === undefined)
        return "unknown error";
    if (typeof err === "string")
        return err;
    if (err instanceof Error && err.message)
        return err.message;
    if (typeof err.message === "string" && err.message)
        return err.message;
    if (typeof err.generalStatusCode === "number") {
        const hex = (n, w) => "0x" + n.toString(16).padStart(w, "0");
        const ext = Array.isArray(err.extendedStatus) && err.extendedStatus.length > 0
            ? `, extended ${err.extendedStatus.map((e) => hex(e, 4)).join(", ")}`
            : "";
        return `${cipStatusText(err.generalStatusCode)} (CIP ${hex(err.generalStatusCode, 2)}${ext})`;
    }
    try {
        const json = JSON.stringify(err);
        if (json && json !== "{}")
            return json;
    }
    catch {
        // fall through
    }
    return String(err);
}
/**
 * Turn any thrown value into a real Error, so callers can pass it to done() and Catch
 * nodes see a usable message.
 */
function toCipError(err, prefix) {
    const text = describeCipError(err);
    const wrapped = new Error(prefix ? `${prefix}: ${text}` : text);
    if (err && typeof err === "object") {
        if (typeof err.generalStatusCode === "number") {
            wrapped.generalStatusCode = err.generalStatusCode;
        }
        if (err.extendedStatus !== undefined)
            wrapped.extendedStatus = err.extendedStatus;
    }
    return wrapped;
}
/**
 * Standard Node-RED status objects.
 */
exports.STATUS = {
    connected() {
        return { fill: "green", shape: "dot", text: "connected" };
    },
    connecting() {
        return { fill: "yellow", shape: "ring", text: "connecting..." };
    },
    disconnected() {
        return { fill: "red", shape: "ring", text: "disconnected" };
    },
    error(msg) {
        return { fill: "red", shape: "dot", text: msg };
    },
    reading() {
        return { fill: "blue", shape: "dot", text: "reading..." };
    },
    writing() {
        return { fill: "blue", shape: "dot", text: "writing..." };
    },
    scanning() {
        return { fill: "green", shape: "ring", text: "scanning" };
    },
    idle() {
        return { fill: "grey", shape: "ring", text: "idle" };
    },
};
/**
 * Debounce: ensures a function isn't called more often than `wait` ms.
 */
function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}
/**
 * Parse a comma-separated or JSON array string of tag names.
 */
function parseTagList(input) {
    const trimmed = input.trim();
    if (trimmed.startsWith("[")) {
        try {
            const arr = JSON.parse(trimmed);
            return Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : [];
        }
        catch {
            // fall through to comma split
        }
    }
    return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
/**
 * Measure execution time of an async function.
 */
async function withTiming(fn) {
    const start = Date.now();
    const result = await fn();
    return { result, elapsed: Date.now() - start };
}
//# sourceMappingURL=utils.js.map