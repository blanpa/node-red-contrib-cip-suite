"use strict";
/**
 * Shared utilities for cip-suite nodes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATUS = exports.LIB_REPLY_HANDLERS = void 0;
exports.parseTagName = parseTagName;
exports.parseProgramScope = parseProgramScope;
exports.isPlainObject = isPlainObject;
exports.mergeMembers = mergeMembers;
exports.findTagListEntry = findTagListEntry;
exports.canonicalizeTagName = canonicalizeTagName;
exports.resolveMemberInfo = resolveMemberInfo;
exports.getBit = getBit;
exports.wrapToWidth = wrapToWidth;
exports.setBit = setBit;
exports.buildBitMasks = buildBitMasks;
exports.cipStatusText = cipStatusText;
exports.cipTypeName = cipTypeName;
exports.describeCipError = describeCipError;
exports.toCipError = toCipError;
exports.cipErrorFields = cipErrorFields;
exports.guardReplyHandlers = guardReplyHandlers;
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
/** A plain `{ ... }` object, not an array, Buffer, Date or null. */
function isPlainObject(v) {
    return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}
/**
 * Lay `patch` over a UDT value read from the controller, so a payload naming only some
 * members leaves the rest as they are. Nested UDTs merge the same way; an array in the
 * patch replaces elements by index and keeps the array's length. A key the UDT does not
 * have is an error, since the library would otherwise drop it without a word.
 */
function mergeMembers(current, patch, path = "") {
    if (Array.isArray(current) && Array.isArray(patch)) {
        if (patch.length > current.length) {
            throw new Error(`${path || "value"} has ${current.length} elements, got ${patch.length}`);
        }
        const out = current.slice();
        patch.forEach((v, i) => {
            out[i] = mergeMembers(current[i], v, `${path}[${i}]`);
        });
        return out;
    }
    if (isPlainObject(current) && isPlainObject(patch)) {
        const out = { ...current };
        for (const key of Object.keys(patch)) {
            // Logix member names are case-insensitive.
            const match = Object.keys(current).find((k) => k.toLowerCase() === key.toLowerCase());
            if (match === undefined) {
                throw new Error(`${path ? path + "." : ""}${key} is not a member of the UDT`);
            }
            out[match] = mergeMembers(current[match], patch[key], path ? `${path}.${match}` : match);
        }
        return out;
    }
    return patch;
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
 * Wrap a JS integer to how it would read back as an N-bit signed or unsigned value.
 * JS bitwise ops always produce a signed 32-bit result, so setting bit 15 of an INT
 * (bits = 16) yields e.g. 33344, which is correct as a 32-bit number but out of range
 * for the 16-bit field it has to be written into.
 */
function wrapToWidth(value, bits, signed = true) {
    if (bits >= 32)
        return signed ? value | 0 : value >>> 0;
    const mask = (1 << bits) - 1;
    const v = value & mask;
    return signed && (v & (1 << (bits - 1))) !== 0 ? v - (1 << bits) : v;
}
/**
 * Set a specific bit in an integer value, wrapped to the tag's actual width so the
 * result is valid for the signed/unsigned N-bit field it will be written back into.
 */
function setBit(value, bitIndex, bitValue, bits = 32, signed = true) {
    if (!Number.isInteger(bitIndex) || bitIndex < 0 || bitIndex >= bits) {
        throw new RangeError(`Bit ${bitIndex} is out of range for a ${bits}-bit value (0-${bits - 1})`);
    }
    const result = bitValue ? value | (1 << bitIndex) : value & ~(1 << bitIndex);
    return wrapToWidth(result, bits, signed);
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
 * The error fields of a failed result: readable text plus, for a CIP refusal, the raw
 * status codes so a flow can branch on them instead of parsing text.
 */
function cipErrorFields(err) {
    const fields = {
        error: describeCipError(err),
    };
    if (err && typeof err === "object" && typeof err.generalStatusCode === "number") {
        fields.generalStatusCode = err.generalStatusCode;
        fields.extendedStatus = Array.isArray(err.extendedStatus) ? err.extendedStatus : [];
    }
    return fields;
}
/**
 * The st-ethernet-ip reply handlers that run inside the socket 'data' event. Anything
 * they throw is uncaught and takes down the whole Node-RED process.
 */
exports.LIB_REPLY_HANDLERS = ["_handleSendRRDataReceived", "_handleSendUnitDataReceived"];
/**
 * Wrap the library's reply handlers so a reply it cannot parse is logged instead of
 * crashing Node-RED (SerafinTech/ST-node-ethernet-ip#84: a Multiple Service Packet reply
 * with outer status 0 and a failed embedded reply dereferences null).
 *
 * Must run before connect(), which is where the library registers these handlers.
 * When the failed reply was a Multiple Service Packet, its waiter is failed straight away
 * with 0x1E (embedded service error) rather than left to time out.
 */
function guardReplyHandlers(plc, warn) {
    for (const name of exports.LIB_REPLY_HANDLERS) {
        const original = plc[name];
        if (typeof original !== "function")
            continue;
        // SendUnitData carries a 2-byte connection sequence count ahead of the CIP reply.
        const serviceOffset = name === "_handleSendUnitDataReceived" ? 2 : 0;
        plc[name] = function (...args) {
            try {
                return original.apply(this, args);
            }
            catch (e) {
                warn(`Ignored a CIP reply the library could not handle: ${describeCipError(e)}`);
                let service;
                try {
                    service = args[0][1].data.readUInt8(serviceOffset);
                }
                catch {
                    // reply too short to name its service
                }
                if (service === 0x8a) {
                    this.emit("Multiple Service Packet", { generalStatusCode: 0x1e, extendedStatus: [] }, []);
                }
            }
        };
    }
}
/**
 * Standard Node-RED status objects.
 */
exports.STATUS = {
    // `via` names the endpoint in use. Worth showing whenever a node can be re-pointed at
    // runtime, since "connected" alone does not say what it is connected to.
    connected(via) {
        return { fill: "green", shape: "dot", text: via ? `connected: ${via}` : "connected" };
    },
    connecting(via) {
        return { fill: "yellow", shape: "ring", text: via ? `connecting: ${via}` : "connecting..." };
    },
    disconnected(via) {
        return { fill: "red", shape: "ring", text: via ? `disconnected: ${via}` : "disconnected" };
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