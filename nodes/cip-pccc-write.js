"use strict";
/**
 * CIP PCCC Write node - writes data to SLC500/MicroLogix/PLC-5 using PCCC addresses.
 *
 * Supports addresses like N7:0, F8:0, B3:0/5, T4:0.ACC, etc.
 * For bit addresses (B3:0/5, N7:0/3), performs a read-modify-write to preserve other bits.
 *
 * @module cip-pccc-write
 */
Object.defineProperty(exports, "__esModule", { value: true });
const pccc_utils_1 = require("./pccc-utils");
const types_1 = require("./types");
const utils_1 = require("./utils");
module.exports = function (RED) {
    function CipPcccWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node._endpoint = RED.nodes.getNode(config.endpoint);
        node._address = config.address || "";
        node._staticValue = config.staticValue || "";
        node._useStaticValue = config.useStaticValue || false;
        node._writing = false; // backpressure flag
        if (!node._endpoint) {
            node.status(utils_1.STATUS.error("no endpoint configured"));
            return;
        }
        // ── Connection events ──
        node.on("pccc:connected", () => {
            node.status(utils_1.STATUS.connected());
        });
        node.on("pccc:connecting", () => {
            node.status(utils_1.STATUS.connecting());
        });
        node.on("pccc:disconnected", () => {
            node.status(utils_1.STATUS.disconnected());
        });
        node.on("pccc:error", (err) => {
            node.status(utils_1.STATUS.error(err.message));
        });
        // ── Write logic ──
        async function doWrite(addressStr, value, msg) {
            if (node._writing)
                return; // backpressure
            node._writing = true;
            let parsedAddr;
            try {
                parsedAddr = (0, pccc_utils_1.parsePCCCAddress)(addressStr);
            }
            catch (err) {
                node.error(`Invalid PCCC address "${addressStr}": ${err.message}`, msg);
                node._writing = false;
                sendResult(msg, addressStr, value, false, err.message);
                return;
            }
            try {
                // Bit write: read-modify-write pattern
                if (parsedAddr.bitNumber !== null) {
                    await doBitWrite(parsedAddr, value, msg);
                }
                else {
                    // Direct write
                    const writeData = (0, pccc_utils_1.buildPCCCWriteCommand)(parsedAddr, value);
                    await node._endpoint.sendPCCC(pccc_utils_1.PCCC_CMD.TYPED_LOGICAL, pccc_utils_1.PCCC_FNC.TYPED_WRITE_3ADDR, writeData);
                }
                sendResult(msg, parsedAddr.displayAddress, value, true);
                node.status(utils_1.STATUS.connected());
            }
            catch (err) {
                node.error(`PCCC write "${addressStr}" failed: ${err.message}`, msg);
                node.status(utils_1.STATUS.error(err.message));
                sendResult(msg, parsedAddr.displayAddress, value, false, err.message);
            }
            finally {
                node._writing = false;
            }
        }
        async function doBitWrite(addr, bitValue, msg) {
            // Read the current word
            const readAddr = {
                ...addr,
                bitNumber: null, // read the whole word
            };
            const readData = (0, pccc_utils_1.buildPCCCReadCommand)(readAddr, 1);
            const responseData = await node._endpoint.sendPCCC(pccc_utils_1.PCCC_CMD.TYPED_LOGICAL, pccc_utils_1.PCCC_FNC.TYPED_READ_3ADDR, readData);
            // Parse current word value
            const currentValue = (0, pccc_utils_1.parsePCCCReadResponse)(responseData, readAddr);
            if (typeof currentValue !== "number") {
                throw new Error(`Cannot perform bit write on non-numeric value at ${addr.displayAddress}`);
            }
            // Modify the bit
            const boolVal = bitValue === true || bitValue === 1 || bitValue === "1" || bitValue === "true";
            const newValue = (0, utils_1.setBit)(currentValue, addr.bitNumber, boolVal);
            // Write modified word back
            const writeData = (0, pccc_utils_1.buildPCCCWriteCommand)(readAddr, newValue);
            await node._endpoint.sendPCCC(pccc_utils_1.PCCC_CMD.TYPED_LOGICAL, pccc_utils_1.PCCC_FNC.TYPED_WRITE_3ADDR, writeData);
        }
        function sendResult(msg, address, value, success, error) {
            const outMsg = {
                ...msg,
                payload: {
                    success,
                    address,
                    value,
                    ...(error ? { error } : {}),
                    timestamp: Date.now(),
                },
            };
            delete outMsg._msgid;
            node.send(outMsg);
        }
        // ── Coerce value from static string to appropriate type ──
        function coerceValue(value, addr) {
            switch (addr.fileType) {
                case types_1.PCCCFileType.FLOAT:
                    return parseFloat(value);
                case types_1.PCCCFileType.INTEGER:
                case types_1.PCCCFileType.LONG:
                case types_1.PCCCFileType.OUTPUT:
                case types_1.PCCCFileType.INPUT:
                case types_1.PCCCFileType.STATUS:
                case types_1.PCCCFileType.COUNTER:
                case types_1.PCCCFileType.TIMER:
                case types_1.PCCCFileType.CONTROL:
                    return parseInt(value, 10);
                case types_1.PCCCFileType.BIT:
                    if (value === "true" || value === "1")
                        return true;
                    if (value === "false" || value === "0")
                        return false;
                    return parseInt(value, 10);
                case types_1.PCCCFileType.STRING:
                case types_1.PCCCFileType.ASCII:
                    return value;
                default:
                    return parseInt(value, 10);
            }
        }
        // ── Input handler ──
        node.on("input", function (msg) {
            if (!node._endpoint.connected) {
                node.status(utils_1.STATUS.disconnected());
                node.error("Not connected to PLC", msg);
                return;
            }
            const address = msg.address || node._address;
            if (!address) {
                node.error("No PCCC address specified", msg);
                return;
            }
            let value;
            if (node._useStaticValue) {
                // Coerce static value based on address type
                try {
                    const parsed = (0, pccc_utils_1.parsePCCCAddress)(address);
                    value = coerceValue(node._staticValue, parsed);
                }
                catch {
                    value = node._staticValue;
                }
            }
            else {
                value = msg.payload;
            }
            if (value === undefined || value === null) {
                node.error("No value to write (msg.payload is empty)", msg);
                return;
            }
            doWrite(address, value, msg);
        });
        // ── Lifecycle ──
        node._endpoint.register(node);
        node.on("close", function (done) {
            if (node._endpoint) {
                node._endpoint.deregister(node);
            }
            done();
        });
    }
    RED.nodes.registerType("cip-pccc-write", CipPcccWriteNode);
};
//# sourceMappingURL=cip-pccc-write.js.map