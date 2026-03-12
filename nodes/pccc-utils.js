"use strict";
/**
 * PCCC (Programmable Controller Communication Commands) protocol utilities.
 * Used for SLC500, MicroLogix, PLC-5 over EtherNet/IP.
 *
 * PCCC commands are encapsulated in CIP using:
 * - Service: 0x4B (Execute PCCC)
 * - Class: 0x67 (PCCC Object)
 * - Instance: 0x01
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PCCC_FNC = exports.PCCC_CMD = void 0;
exports.parsePCCCAddress = parsePCCCAddress;
exports.buildPCCCReadCommand = buildPCCCReadCommand;
exports.buildPCCCWriteCommand = buildPCCCWriteCommand;
exports.parsePCCCReadResponse = parsePCCCReadResponse;
exports.buildCIPPcccMessage = buildCIPPcccMessage;
exports.pcccTypeName = pcccTypeName;
const types_1 = require("./types");
/**
 * File type letter → PCCCFileType mapping.
 */
const FILE_TYPE_MAP = {
    O: { type: types_1.PCCCFileType.OUTPUT, size: 2 },
    I: { type: types_1.PCCCFileType.INPUT, size: 2 },
    S: { type: types_1.PCCCFileType.STATUS, size: 2 },
    B: { type: types_1.PCCCFileType.BIT, size: 2 },
    T: { type: types_1.PCCCFileType.TIMER, size: 6 }, // 3 words (PRE, ACC, CTL)
    C: { type: types_1.PCCCFileType.COUNTER, size: 6 }, // 3 words
    R: { type: types_1.PCCCFileType.CONTROL, size: 6 }, // 3 words
    N: { type: types_1.PCCCFileType.INTEGER, size: 2 },
    F: { type: types_1.PCCCFileType.FLOAT, size: 4 },
    ST: { type: types_1.PCCCFileType.STRING, size: 84 }, // 82 chars + 2 byte length
    A: { type: types_1.PCCCFileType.ASCII, size: 2 },
    L: { type: types_1.PCCCFileType.LONG, size: 4 },
};
/**
 * Timer/Counter sub-element mapping.
 */
const TIMER_COUNTER_SUB = {
    CTL: 0,
    PRE: 1,
    ACC: 2,
    EN: 0, // bit in CTL word
    TT: 0,
    DN: 0,
    CU: 0,
    CD: 0,
    OV: 0,
    UN: 0,
};
/**
 * Parse a PCCC address string into structured components.
 *
 * Supported formats:
 *   N7:0      → Integer file 7, element 0
 *   F8:0      → Float file 8, element 0
 *   B3:0/5    → Bit file 3, element 0, bit 5
 *   N7:0/3    → Integer file 7, element 0, bit 3
 *   T4:0      → Timer file 4, element 0 (all sub-elements)
 *   T4:0.ACC  → Timer file 4, element 0, accumulator
 *   T4:0.PRE  → Timer file 4, element 0, preset
 *   C5:0.ACC  → Counter file 5, element 0, accumulator
 *   S:1       → Status file, element 1
 *   S:1/5     → Status file, element 1, bit 5
 *   O:0       → Output file, element 0
 *   O:0/0     → Output file, element 0, bit 0
 *   I:1/0     → Input file, element 1, bit 0
 *   ST9:0     → String file 9, element 0
 *   L10:0     → Long file 10, element 0
 */
function parsePCCCAddress(addr) {
    addr = addr.trim().toUpperCase();
    // Match pattern: TYPE[NUM]:ELEM[.SUB][/BIT] or TYPE:ELEM[/BIT]
    // Examples: N7:0, F8:0, B3:0/5, T4:0.ACC, S:1/5, ST9:0, O:0/0
    const regex = /^(ST|[A-Z])(\d*):(\d+)(?:\.(\w+))?(?:\/(\d+))?$/;
    const match = addr.match(regex);
    if (!match) {
        throw new Error(`Invalid PCCC address: "${addr}"`);
    }
    const [, typeLetter, fileNumStr, elemStr, subElem, bitStr] = match;
    const fileInfo = FILE_TYPE_MAP[typeLetter];
    if (!fileInfo) {
        throw new Error(`Unknown PCCC file type: "${typeLetter}"`);
    }
    // File number: for S, O, I it's implicit (S=2, O=0, I=1) if not specified
    let fileNumber;
    if (fileNumStr === "") {
        // Default file numbers for types that don't require explicit number
        const defaults = { O: 0, I: 1, S: 2 };
        fileNumber = defaults[typeLetter] ?? 0;
    }
    else {
        fileNumber = parseInt(fileNumStr, 10);
    }
    const elementNumber = parseInt(elemStr, 10);
    // Sub-element (for Timer/Counter/Control: .PRE, .ACC, .CTL)
    let subElement = 0;
    if (subElem) {
        const subVal = TIMER_COUNTER_SUB[subElem];
        if (subVal !== undefined) {
            subElement = subVal;
        }
        else {
            throw new Error(`Unknown sub-element: "${subElem}" in address "${addr}"`);
        }
    }
    // Bit number
    const bitNumber = bitStr !== undefined ? parseInt(bitStr, 10) : null;
    return {
        fileType: fileInfo.type,
        fileNumber,
        elementNumber,
        subElement,
        bitNumber,
        typeLetter,
        elementSize: fileInfo.size,
        displayAddress: addr,
    };
}
/**
 * Build a PCCC "Protected Typed Logical Read with Three Address Fields" command.
 * CMD=0x0F, FNC=0xA2
 */
function buildPCCCReadCommand(addr, elementCount = 1) {
    const byteCount = addr.elementSize * elementCount;
    // For Timer/Counter/Control with sub-element, read just that word
    const effectiveByteCount = (addr.fileType === types_1.PCCCFileType.TIMER ||
        addr.fileType === types_1.PCCCFileType.COUNTER ||
        addr.fileType === types_1.PCCCFileType.CONTROL) &&
        addr.subElement > 0
        ? 2 * elementCount // single word per element
        : byteCount;
    const data = Buffer.alloc(7);
    data[0] = effectiveByteCount; // byte size to read
    data[1] = addr.fileNumber & 0xff; // file number (low byte)
    data[2] = addr.fileType; // file type
    data[3] = addr.elementNumber & 0xff; // element number (low byte)
    data[4] = (addr.elementNumber >> 8) & 0xff; // element number (high byte)
    data[5] = addr.subElement & 0xff; // sub-element number (low byte)
    data[6] = (addr.subElement >> 8) & 0xff;
    return data;
}
/**
 * Build a PCCC "Protected Typed Logical Write with Three Address Fields" command.
 * CMD=0x0F, FNC=0xAA
 */
function buildPCCCWriteCommand(addr, value) {
    let valueBytes;
    switch (addr.fileType) {
        case types_1.PCCCFileType.BIT:
        case types_1.PCCCFileType.INTEGER:
        case types_1.PCCCFileType.OUTPUT:
        case types_1.PCCCFileType.INPUT:
        case types_1.PCCCFileType.STATUS: {
            valueBytes = Buffer.alloc(2);
            if (typeof value === "boolean") {
                valueBytes.writeInt16LE(value ? 1 : 0, 0);
            }
            else {
                valueBytes.writeInt16LE(Number(value), 0);
            }
            break;
        }
        case types_1.PCCCFileType.FLOAT: {
            valueBytes = Buffer.alloc(4);
            valueBytes.writeFloatLE(Number(value), 0);
            break;
        }
        case types_1.PCCCFileType.LONG: {
            valueBytes = Buffer.alloc(4);
            valueBytes.writeInt32LE(Number(value), 0);
            break;
        }
        case types_1.PCCCFileType.TIMER:
        case types_1.PCCCFileType.COUNTER:
        case types_1.PCCCFileType.CONTROL: {
            // Write to sub-element (single word)
            valueBytes = Buffer.alloc(2);
            valueBytes.writeInt16LE(Number(value), 0);
            break;
        }
        case types_1.PCCCFileType.STRING: {
            const str = String(value);
            valueBytes = Buffer.alloc(84); // 2 bytes length + 82 chars
            valueBytes.writeUInt16LE(Math.min(str.length, 82), 0);
            Buffer.from(str.substring(0, 82), "ascii").copy(valueBytes, 2);
            break;
        }
        default: {
            valueBytes = Buffer.alloc(2);
            valueBytes.writeInt16LE(Number(value), 0);
        }
    }
    const header = Buffer.alloc(7);
    header[0] = valueBytes.length; // byte size
    header[1] = addr.fileNumber & 0xff;
    header[2] = addr.fileType;
    header[3] = addr.elementNumber & 0xff;
    header[4] = (addr.elementNumber >> 8) & 0xff;
    header[5] = addr.subElement & 0xff;
    header[6] = (addr.subElement >> 8) & 0xff;
    return Buffer.concat([header, valueBytes]);
}
/**
 * Parse a PCCC read response into a JavaScript value.
 */
function parsePCCCReadResponse(data, addr) {
    if (data.length < 2)
        return null;
    let value;
    switch (addr.fileType) {
        case types_1.PCCCFileType.INTEGER:
        case types_1.PCCCFileType.BIT:
        case types_1.PCCCFileType.OUTPUT:
        case types_1.PCCCFileType.INPUT:
        case types_1.PCCCFileType.STATUS:
            value = data.readInt16LE(0);
            break;
        case types_1.PCCCFileType.FLOAT:
            value = data.length >= 4 ? data.readFloatLE(0) : null;
            break;
        case types_1.PCCCFileType.LONG:
            value = data.length >= 4 ? data.readInt32LE(0) : null;
            break;
        case types_1.PCCCFileType.TIMER:
        case types_1.PCCCFileType.COUNTER:
        case types_1.PCCCFileType.CONTROL:
            if (addr.subElement > 0) {
                // Single word (PRE or ACC)
                value = data.readInt16LE(0);
            }
            else {
                // Full element: { CTL, PRE, ACC }
                value = {
                    CTL: data.readUInt16LE(0),
                    PRE: data.length >= 4 ? data.readInt16LE(2) : 0,
                    ACC: data.length >= 6 ? data.readInt16LE(4) : 0,
                };
            }
            break;
        case types_1.PCCCFileType.STRING:
            if (data.length >= 2) {
                const len = data.readUInt16LE(0);
                value = data.slice(2, 2 + Math.min(len, data.length - 2)).toString("ascii");
            }
            else {
                value = "";
            }
            break;
        default:
            value = data.readInt16LE(0);
    }
    // Bit extraction
    if (addr.bitNumber !== null && typeof value === "number") {
        value = ((value >>> addr.bitNumber) & 1) === 1;
    }
    return value;
}
/**
 * Build the full CIP message for a PCCC command.
 * Wraps PCCC data inside CIP Execute PCCC service (0x4B) to PCCC Object (class 0x67, instance 1).
 */
function buildCIPPcccMessage(pcccCmd, pcccFnc, pcccData, tns = 0) {
    // PCCC command packet:
    // [CMD(1)] [STS(1)] [TNS(2)] [FNC(1)] [DATA(N)]
    const pcccPacket = Buffer.alloc(5 + pcccData.length);
    pcccPacket[0] = pcccCmd; // Command (0x0F = typed logical)
    pcccPacket[1] = 0x00; // Status (0 for requests)
    pcccPacket.writeUInt16LE(tns, 2); // Transaction number
    pcccPacket[4] = pcccFnc; // Function
    pcccData.copy(pcccPacket, 5);
    // CIP path: Class 0x67, Instance 1
    const cipPath = Buffer.from([0x20, 0x67, 0x24, 0x01]);
    // CIP Message Router request:
    // [Service(1)] [PathSize(1)] [Path(N)] [RequestData(N)]
    // Request data for Execute PCCC includes:
    // [Requester ID Length(1)] [CIP Vendor ID(2)] [CIP Serial(4)] [PCCC Packet]
    const requestData = Buffer.alloc(7 + pcccPacket.length);
    requestData[0] = 7; // Requester ID length
    requestData.writeUInt16LE(0x0001, 1); // Vendor ID (Rockwell)
    requestData.writeUInt32LE(0x12345678, 3); // Serial number (arbitrary)
    pcccPacket.copy(requestData, 7);
    const mr = Buffer.alloc(2 + cipPath.length + requestData.length);
    mr[0] = 0x4b; // Execute PCCC service
    mr[1] = cipPath.length / 2; // Path size in words
    cipPath.copy(mr, 2);
    requestData.copy(mr, 2 + cipPath.length);
    return mr;
}
// PCCC command/function codes
exports.PCCC_CMD = {
    TYPED_LOGICAL: 0x0f,
};
exports.PCCC_FNC = {
    TYPED_READ_3ADDR: 0xa2,
    TYPED_WRITE_3ADDR: 0xaa,
};
/**
 * Type name for display.
 */
function pcccTypeName(addr) {
    const names = {
        O: "Output", I: "Input", S: "Status", B: "Bit", T: "Timer",
        C: "Counter", R: "Control", N: "Integer", F: "Float",
        ST: "String", A: "ASCII", L: "Long",
    };
    return names[addr.typeLetter] || "Unknown";
}
//# sourceMappingURL=pccc-utils.js.map