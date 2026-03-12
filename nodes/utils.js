"use strict";
/**
 * Shared utilities for cip-suite nodes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATUS = void 0;
exports.parseTagName = parseTagName;
exports.getBit = getBit;
exports.setBit = setBit;
exports.buildBitMasks = buildBitMasks;
exports.cipStatusText = cipStatusText;
exports.cipTypeName = cipTypeName;
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