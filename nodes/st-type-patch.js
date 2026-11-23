"use strict";
/**
 * Numeric types st-ethernet-ip 2.7.5 cannot encode or decode (#42).
 *
 * The library's Tag class handles BOOL, SINT, INT, DINT, LINT, REAL and (partly) USINT and
 * UINT. For the types below it throws "Unrecognized Type ..." on a read, a write or a
 * fragmented write, or its own "can only be used on" error for bit access:
 *
 * Type   Code  Read   Write  Fragmented write  Bit access
 * USINT  0xc6  lib    lib    added             added
 * UINT   0xc7  lib    added  added             write added
 * UDINT  0xc8  added  added  added             added
 * ULINT  0xc9  added  added  added             n/a
 * LREAL  0xcb  added  added  added             n/a
 * BYTE   0xd1  added  added  added             added
 * WORD   0xd2  added  added  added             added
 * LWORD  0xd4  added  added  added             n/a
 *
 * Each `Tag.prototype` method is wrapped. The wrapper calls the library first and only takes
 * over when the library throws its "unrecognised type" error, so a type the library handles
 * never reaches this code, and a library that adds a type later simply stops using the patch
 * for it. ULINT is added to the library's `Types` table, which has no entry for it.
 *
 * The library's names for 0xd1 and 0xd2 are shifted by one against the CIP spec (Vol 1,
 * Appendix C): it calls them WORD and DWORD, the spec has BYTE (0xd1, 8 bit), WORD (0xd2,
 * 16 bit), DWORD (0xd3, 32 bit) and LWORD (0xd4, 64 bit). The table is corrected here. The
 * library reads 0xd3 as BIT_STRING, an array of 32 booleans, which is right for a Logix BOOL
 * array and is left alone, so a raw DWORD tag is not a number. A Micro800 does not use any of
 * these codes: it reports its BYTE, WORD, DWORD and LWORD variables as USINT, UINT, UDINT
 * and ULINT.
 *
 * Encodings copy the library's own cases: scalars and arrays are told apart by reply length
 * as UINT is, UDINT, BYTE and WORD are numbers, LREAL a double, and ULINT/LWORD a BigInt as
 * LINT is. Out of range values are refused by the Buffer write, as the library's own are.
 *
 * Known limit: the Controller decides when a write needs fragmenting from a size table that
 * only covers type codes 0xc1 to 0xca. ULINT is added to the table here; LREAL, BYTE, WORD
 * and LWORD arrays that do not fit one packet (about 60 LREAL or LWORD elements) are not
 * fragmented and fail in the controller.
 * @module st-type-patch
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.installTypePatch = installTypePatch;
const toBigInt = (v) => (typeof v === "bigint" ? v : BigInt(v));
const u16 = {
    size: 2,
    read: (b, o) => b.readUInt16LE(o),
    write: (b, v, o) => void b.writeUInt16LE(v, o),
    bitAccess: true,
};
const u32 = {
    size: 4,
    read: (b, o) => b.readUInt32LE(o),
    write: (b, v, o) => void b.writeUInt32LE(v, o),
    bitAccess: true,
};
const u64 = {
    size: 8,
    read: (b, o) => b.readBigUInt64LE(o),
    write: (b, v, o) => void b.writeBigUInt64LE(toBigInt(v), o),
    bitAccess: false,
};
/** The types handled here, keyed by CIP type code. */
const CODECS = {};
function define(name, code, base) {
    CODECS[code] = { name, code, ...base };
}
const u8 = {
    size: 1,
    read: (b, o) => b.readUInt8(o),
    write: (b, v, o) => void b.writeUInt8(v, o),
    bitAccess: true,
};
define("USINT", 0xc6, u8);
define("UINT", 0xc7, u16);
define("UDINT", 0xc8, u32);
define("ULINT", 0xc9, u64);
define("LREAL", 0xcb, {
    size: 8,
    read: (b, o) => b.readDoubleLE(o),
    write: (b, v, o) => void b.writeDoubleLE(v, o),
    bitAccess: false,
});
define("BYTE", 0xd1, u8);
define("WORD", 0xd2, u16);
define("LWORD", 0xd4, u64);
/** The errors the library throws for a type it has no case for. */
const UNRECOGNISED = /^(Unrecognized Type|Data Type other than|Bit Indexes can only be used)/;
/** Bytes of the Read Modify Write masks and the value of a bit access, per element size. */
function bitMasks(codec, bitIndex, value) {
    const buf = Buffer.alloc(2 + codec.size * 2);
    buf.writeUInt16LE(codec.size, 0); // mask length
    const bit = 2 ** bitIndex;
    const all = 2 ** (codec.size * 8) - 1;
    const orMask = value ? bit : 0;
    const andMask = value ? all : all - bit;
    const writeMask = (v, at) => {
        if (codec.size === 1)
            buf.writeUInt8(v, at);
        else if (codec.size === 2)
            buf.writeUInt16LE(v, at);
        else
            buf.writeUInt32LE(v, at);
    };
    writeMask(orMask, 2);
    writeMask(andMask, 2 + codec.size);
    return buf;
}
/** Elements of `data` after the 2 byte type header: a single value, or an array. */
function decodeValue(codec, data) {
    if (data.length > 2 + codec.size) {
        const array = [];
        for (let i = 0; i < (data.length - 2) / codec.size; i++) {
            array.push(codec.read(data, i * codec.size + 2));
        }
        return array;
    }
    return codec.read(data, 2);
}
function encodeValue(codec, value) {
    const values = Array.isArray(value) ? value : [value];
    const buf = Buffer.alloc(codec.size * values.length);
    values.forEach((v, i) => codec.write(buf, v, i * codec.size));
    return buf;
}
let installed = null;
/**
 * Wrap the Tag methods and extend the library's tables. Safe to call repeatedly; returns
 * false, and changes nothing, if the library does not look as expected.
 */
function installTypePatch() {
    if (installed !== null)
        return installed;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Tag, EthernetIP } = require("st-ethernet-ip");
        const { MessageRouter, DataTypes: dataTypes } = EthernetIP.CIP;
        const proto = Tag.prototype;
        const methods = [
            "parseReadMessageResponseValueForAtomic",
            "parseReadMessageResponseValueForBitIndex",
            "generateWriteMessageRequestForAtomic",
            "generateWriteMessageRequestForBitIndex",
            "generateWriteMessageRequestFrag",
        ];
        const { WRITE_TAG, WRITE_TAG_FRAGMENTED, READ_MODIFY_WRITE_TAG } = MessageRouter.services;
        if (!dataTypes?.Types ||
            !dataTypes?.TypeSizes ||
            !WRITE_TAG ||
            methods.some((m) => typeof proto[m] !== "function")) {
            installed = false;
            return installed;
        }
        // ULINT has no entry in the library's table, so its name does not resolve.
        if (dataTypes.Types.ULINT === undefined)
            dataTypes.Types.ULINT = 0xc9;
        // The library's WORD and DWORD are the spec's BYTE and WORD (see the header). DWORD is
        // moved to the end so that 0xd3 keeps resolving to BIT_STRING, the name the library gives
        // a Logix BOOL array.
        if (dataTypes.Types.WORD === 0xd1 && dataTypes.Types.DWORD === 0xd2) {
            dataTypes.Types.WORD = 0xd2;
            delete dataTypes.Types.DWORD;
            dataTypes.Types.DWORD = 0xd3;
            dataTypes.Types.BYTE = 0xd1;
        }
        // The Controller reads this table to size a write, but only for codes up to 0xca.
        for (const codec of Object.values(CODECS)) {
            if (dataTypes.TypeSizes[codec.code] === undefined)
                dataTypes.TypeSizes[codec.code] = codec.size;
        }
        /** Call the library; take over for one of our types if it has no case for it. */
        const wrap = (method, handle) => {
            const original = proto[method];
            proto[method] = function (...args) {
                const codec = CODECS[this.state?.tag?.type];
                if (!codec)
                    return original.apply(this, args);
                try {
                    return original.apply(this, args);
                }
                catch (err) {
                    if (!UNRECOGNISED.test(String(err?.message)))
                        throw err;
                    return handle(this, codec, args);
                }
            };
        };
        wrap("parseReadMessageResponseValueForAtomic", (self, codec, [data]) => {
            self.controller_value = decodeValue(codec, data);
        });
        wrap("parseReadMessageResponseValueForBitIndex", (self, codec, [data]) => {
            if (!codec.bitAccess)
                throw new Error(`Bit access is not supported on ${codec.name} tags`);
            const word = codec.size === 4 ? data.readUInt32LE(2) : codec.size === 2 ? data.readUInt16LE(2) : data.readUInt8(2);
            self.controller_value = (word & (1 << self.state.tag.bitIndex)) !== 0;
        });
        wrap("generateWriteMessageRequestForAtomic", (self, codec, [value, size]) => {
            const { tag } = self.state;
            const header = Buffer.alloc(4);
            header.writeUInt16LE(tag.type, 0);
            header.writeUInt16LE(Array.isArray(value) ? value.length : size, 2);
            return MessageRouter.build(WRITE_TAG, tag.path, Buffer.concat([header, encodeValue(codec, value)]));
        });
        wrap("generateWriteMessageRequestForBitIndex", (self, codec, [value]) => {
            if (!codec.bitAccess)
                throw new Error(`Bit access is not supported on ${codec.name} tags`);
            const { tag } = self.state;
            return MessageRouter.build(READ_MODIFY_WRITE_TAG, tag.path, bitMasks(codec, tag.bitIndex, !!value));
        });
        wrap("generateWriteMessageRequestFrag", (self, codec, [offset = 0, value]) => {
            const { tag } = self.state;
            const header = Buffer.alloc(8);
            header.writeUInt16LE(tag.type, 0);
            header.writeUInt16LE(self.value.length, 2);
            header.writeUInt32LE(offset, 4);
            return MessageRouter.build(WRITE_TAG_FRAGMENTED, tag.path, Buffer.concat([header, encodeValue(codec, value)]));
        });
        installed = true;
    }
    catch {
        installed = false;
    }
    return installed;
}
installTypePatch();
//# sourceMappingURL=st-type-patch.js.map