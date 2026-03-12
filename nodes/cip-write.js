"use strict";
/**
 * CIP Write node — writes tag values to an Allen-Bradley PLC.
 *
 * Enhancements over JS version:
 * - Bit-level write: "MyDint.5" uses read-modify-write (atomic if available)
 * - Array element write: "MyArray[3]"
 * - Array range write: msg.payload is array of values
 * - UDT/Structure write support
 * - Batch mode: msg.tags is array of {name, value}
 * - read-modify-write config option for atomic bit operations
 * - Backpressure protection, static value, browse button
 * @module cip-write
 */
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("./types");
const utils_1 = require("./utils");
module.exports = function (RED) {
    function CipWriteNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.tagName = config.tagName || "";
        node.dataType = config.dataType || "auto";
        node.staticValue = config.staticValue;
        node.useStaticValue = config.useStaticValue || false;
        node.useAtomicBitWrite = config.useAtomicBitWrite || false;
        node._writing = false;
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        /**
         * Determine the byte size of a CIP data type for bit mask operations.
         */
        function getTypeByteSize(typeCode) {
            const code = typeof typeCode === "object" && typeCode !== null ? typeCode.code : typeCode;
            switch (code) {
                case types_1.CIPDataType.BOOL:
                case types_1.CIPDataType.SINT:
                case types_1.CIPDataType.USINT:
                    return 1;
                case types_1.CIPDataType.INT:
                case types_1.CIPDataType.UINT:
                    return 2;
                case types_1.CIPDataType.DINT:
                case types_1.CIPDataType.UDINT:
                case types_1.CIPDataType.REAL:
                case types_1.CIPDataType.DWORD:
                    return 4;
                case types_1.CIPDataType.LINT:
                case types_1.CIPDataType.LREAL:
                case types_1.CIPDataType.LWORD:
                    return 8;
                default:
                    return 4; // default to DINT size
            }
        }
        /**
         * Write a single tag with support for bit access, array elements, array ranges, and UDTs.
         */
        async function writeSingleTag(tagName, value) {
            const parsed = (0, utils_1.parseTagName)(tagName);
            const controller = node.endpoint.getController();
            if (!controller)
                throw new Error("Controller not available");
            const { Tag } = require("st-ethernet-ip");
            let Structure;
            try {
                Structure = require("st-ethernet-ip").Structure;
            }
            catch {
                // Structure class may not be available
            }
            // Bit-level write: "MyDint.5"
            if (parsed.bitIndex !== null) {
                const bitValue = Boolean(value);
                // Try atomic read-modify-write first (CIP service 0x4E)
                if (node.useAtomicBitWrite &&
                    typeof node.endpoint.readModifyWriteTag === "function") {
                    try {
                        // Need to read the tag first to determine type/size
                        const tag = new Tag(parsed.baseName);
                        await controller.readTag(tag);
                        const byteSize = getTypeByteSize(tag.type);
                        const { orMask, andMask } = (0, utils_1.buildBitMasks)(byteSize, parsed.bitIndex, bitValue);
                        await node.endpoint.readModifyWriteTag(parsed.baseName, orMask, andMask);
                        return {
                            success: true,
                            tagName,
                            value: bitValue,
                            timestamp: Date.now(),
                        };
                    }
                    catch (err) {
                        // Fall through to software read-modify-write
                        node.warn(`Atomic bit write failed, falling back to software RMW: ${err.message}`);
                    }
                }
                // Software read-modify-write
                const tag = new Tag(parsed.baseName);
                await controller.readTag(tag);
                const currentValue = tag.value;
                const newValue = (0, utils_1.setBit)(currentValue, parsed.bitIndex, bitValue);
                tag.value = newValue;
                await controller.writeTag(tag);
                return {
                    success: true,
                    tagName,
                    value: bitValue,
                    timestamp: Date.now(),
                };
            }
            // Array range write: "MyArray[0..9]" with array of values
            if (parsed.isRange && parsed.arrayStart !== null && parsed.arrayEnd !== null) {
                if (!Array.isArray(value)) {
                    throw new Error(`Array range write requires an array of values, got ${typeof value}`);
                }
                const count = parsed.arrayEnd - parsed.arrayStart + 1;
                if (value.length !== count) {
                    throw new Error(`Array range [${parsed.arrayStart}..${parsed.arrayEnd}] expects ${count} values, got ${value.length}`);
                }
                // Write each element individually
                for (let i = 0; i < count; i++) {
                    const idx = parsed.arrayStart + i;
                    const elemTag = new Tag(`${parsed.baseName}[${idx}]`);
                    await controller.readTag(elemTag); // init type
                    elemTag.value = value[i];
                    await controller.writeTag(elemTag);
                }
                return {
                    success: true,
                    tagName,
                    value,
                    timestamp: Date.now(),
                };
            }
            // Array element write: "MyArray[3]"
            if (parsed.arrayIndex !== null) {
                const tag = new Tag(`${parsed.baseName}[${parsed.arrayIndex}]`);
                await controller.readTag(tag); // init type
                tag.value = value;
                await controller.writeTag(tag);
                return {
                    success: true,
                    tagName,
                    value,
                    timestamp: Date.now(),
                };
            }
            // UDT/Structure write
            const tag = new Tag(parsed.baseName);
            await controller.readTag(tag); // init type
            const typeCode = typeof tag.type === "object" && tag.type !== null ? tag.type.code : tag.type;
            if (typeCode === types_1.CIPDataType.STRUCT &&
                Structure &&
                typeof Structure === "function" &&
                typeof value === "object" &&
                value !== null) {
                try {
                    const struct = new Structure(parsed.baseName);
                    await controller.readTag(struct);
                    // Apply new values to the structure
                    if (typeof struct.value === "object" && struct.value !== null) {
                        Object.assign(struct.value, value);
                    }
                    else {
                        struct.value = value;
                    }
                    await controller.writeTag(struct);
                    return {
                        success: true,
                        tagName,
                        value,
                        timestamp: Date.now(),
                    };
                }
                catch {
                    // Fall through to standard write
                }
            }
            // Standard tag write
            tag.value = value;
            if (node.dataType !== "auto") {
                const explicitType = parseInt(node.dataType, 16);
                if (!isNaN(explicitType)) {
                    tag.type = explicitType;
                }
            }
            await controller.writeTag(tag);
            return {
                success: true,
                tagName,
                value,
                timestamp: Date.now(),
            };
        }
        /**
         * Write multiple tags in batch.
         */
        async function writeBatch(tags) {
            const results = [];
            for (const item of tags) {
                try {
                    const r = await writeSingleTag(item.name, item.value);
                    results.push(r);
                }
                catch (err) {
                    results.push({
                        success: false,
                        tagName: item.name,
                        value: item.value,
                        error: err.message,
                        timestamp: Date.now(),
                    });
                }
            }
            return results;
        }
        // Connection lifecycle
        node.on("cip:connected", function () {
            node.status(utils_1.STATUS.connected());
        });
        node.on("cip:connecting", function () {
            node.status(utils_1.STATUS.connecting());
        });
        node.on("cip:error", function () {
            node.status({ fill: "red", shape: "ring", text: "connection error" });
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected());
        });
        node.on("input", async function (msg) {
            if (!node.endpoint.connected) {
                node.status({ fill: "red", shape: "ring", text: "not connected" });
                node.error("Not connected to PLC", msg);
                return;
            }
            if (node._writing) {
                node.warn("Write already in progress, dropping message");
                return;
            }
            node._writing = true;
            try {
                // Batch mode: msg.tags is array of {name, value}
                if (Array.isArray(msg.tags)) {
                    const { result: batchResults, elapsed } = await (0, utils_1.withTiming)(() => writeBatch(msg.tags));
                    const allOk = batchResults.every((r) => r.success);
                    msg.payload = batchResults;
                    node.status({
                        fill: allOk ? "green" : "yellow",
                        shape: "dot",
                        text: `${batchResults.length} tags written (${elapsed}ms)`,
                    });
                    node.send(msg);
                    return;
                }
                // Single tag mode
                const tag = msg.tagName || node.tagName;
                if (!tag) {
                    node.error("No tag name specified", msg);
                    return;
                }
                const value = node.useStaticValue ? node.staticValue : msg.payload;
                if (value === undefined || value === null) {
                    node.error("No value to write", msg);
                    return;
                }
                const { result, elapsed } = await (0, utils_1.withTiming)(() => writeSingleTag(tag, value));
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: `${tag} written (${elapsed}ms)`,
                });
                msg.payload = result;
                node.send(msg);
            }
            catch (err) {
                node.status({ fill: "red", shape: "ring", text: err.message });
                msg.payload = {
                    success: false,
                    tagName: msg.tagName || node.tagName,
                    error: err.message,
                    timestamp: Date.now(),
                };
                node.error(`Write failed for ${msg.tagName || node.tagName}: ${err.message}`, msg);
                node.send(msg);
            }
            finally {
                node._writing = false;
            }
        });
        node.endpoint.register(node);
        node.on("close", function (done) {
            if (node.endpoint) {
                node.endpoint.deregister(node);
            }
            done();
        });
    }
    RED.nodes.registerType("cip-write", CipWriteNode);
};
//# sourceMappingURL=cip-write.js.map