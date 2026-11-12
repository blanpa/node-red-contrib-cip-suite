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
const endpoint_dynamic_1 = require("./endpoint-dynamic");
/**
 * The tag types each Data Type option accepts. Logix holds STRING as a structure, so the
 * STRING option takes STRUCT as well as the atomic string types.
 */
const DATA_TYPE_MATCHES = {
    BOOL: ["BOOL"],
    INT: ["INT"],
    DINT: ["DINT"],
    REAL: ["REAL"],
    STRING: ["STRING", "SHORT_STRING", "STRING2", "STRINGN", "STRINGI", "STRUCT"],
};
/**
 * How many bytes of text a Logix string template holds: the length of its DATA member
 * (82 for STRING, whatever was chosen for a user-defined string type). Null when the
 * template does not say.
 */
function stringCapacity(template) {
    const size = template?._members?.[1]?.info;
    return typeof size === "number" && size > 0 ? size : null;
}
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
        /**
         * Every write reads the tag first, so the controller's own type is what goes out.
         * A Data Type other than Auto only checks that type, so a node meant for a REAL
         * fails clearly instead of writing a tag it was not set up for.
         */
        function checkDataType(tag, tagName) {
            const accepted = DATA_TYPE_MATCHES[node.dataType];
            if (!accepted)
                return;
            const actual = typeof tag.type === "number" ? (0, utils_1.cipTypeName)(tag.type) : String(tag.type);
            if (!accepted.includes(actual)) {
                throw new Error(`${tagName} is ${actual}, but the node's Data Type is ${node.dataType}`);
            }
        }
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        // Reflect the endpoint's real state immediately. Without this a node whose endpoint
        // never fires a cip:* event (autoConnect off) shows whatever the editor last saw,
        // which after a restart is the previous run's status.
        (0, endpoint_dynamic_1.applyInitialStatus)(node);
        /** Rebind to a different endpoint, moving our registration with us. */
        function useEndpoint(endpoint) {
            if (endpoint === node.endpoint)
                return;
            // Deregistering is enough to stop the old endpoint's broadcasts reaching us: it
            // fans out by emitting on its registered user nodes.
            if (node.endpoint)
                node.endpoint.deregister(node);
            node.endpoint = endpoint;
            endpoint.register(node, { connect: false });
            if (!endpoint.connected) {
                node.status(endpoint.connecting
                    ? utils_1.STATUS.connecting((0, endpoint_dynamic_1.endpointLabel)(node))
                    : utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
            }
        }
        const DYN = { type: "cip-endpoint", switchTo: useEndpoint };
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
         * The bit width and signedness st-ethernet-ip writes a tag's value back as, so a
         * software read-modify-write can wrap the modified value to fit. `tag.type` is the
         * name string the library's getter returns (e.g. "SINT", "UINT"), not a CIP type code.
         * Types with no bit-level meaning (REAL, STRING, LINT, …) are refused rather than
         * treated as a 32-bit integer, which previously corrupted their value.
         */
        function getTypeWidth(typeName) {
            switch (String(typeName)) {
                case "BOOL":
                case "SINT":
                    return { bits: 8, signed: true };
                case "USINT":
                    return { bits: 8, signed: false };
                case "INT":
                    return { bits: 16, signed: true };
                case "UINT":
                case "WORD":
                    return { bits: 16, signed: false };
                case "DINT":
                    return { bits: 32, signed: true };
                case "UDINT":
                case "DWORD":
                    return { bits: 32, signed: false };
                default:
                    throw new Error(`Bit access is not supported on ${typeName} tags`);
            }
        }
        /**
         * Write a single tag with support for bit access, array elements, array ranges, and UDTs.
         */
        async function writeSingleTag(tagName, value, use) {
            const parsed = (0, utils_1.parseTagName)(tagName);
            const endpoint = use || node.endpoint;
            if (!endpoint)
                throw new Error("No endpoint selected");
            const controller = endpoint.getController();
            if (!controller)
                throw new Error("Controller not available");
            const { Tag, Structure } = require("st-ethernet-ip");
            // Bit-level write: "MyDint.5"
            if (parsed.bitIndex !== null) {
                const bitValue = Boolean(value);
                // Try atomic read-modify-write first (CIP service 0x4E)
                if (node.useAtomicBitWrite &&
                    typeof endpoint.readModifyWriteTag === "function") {
                    try {
                        // Need to read the tag first to determine type/size
                        const tag = new Tag(parsed.baseName);
                        await controller.readTag(tag);
                        const byteSize = getTypeByteSize(tag.type);
                        const { orMask, andMask } = (0, utils_1.buildBitMasks)(byteSize, parsed.bitIndex, bitValue);
                        await endpoint.readModifyWriteTag(parsed.baseName, orMask, andMask);
                        return {
                            success: true,
                            tagName,
                            value: bitValue,
                            timestamp: Date.now(),
                        };
                    }
                    catch (err) {
                        // Fall through to software read-modify-write
                        node.warn(`Atomic bit write failed, falling back to software RMW: ${(0, utils_1.describeCipError)(err)}`);
                    }
                }
                // Software read-modify-write
                const tag = new Tag(parsed.baseName);
                await controller.readTag(tag);
                const currentValue = tag.value;
                let newValue;
                try {
                    const { bits, signed } = getTypeWidth(tag.type);
                    newValue = (0, utils_1.setBit)(currentValue, parsed.bitIndex, bitValue, bits, signed);
                }
                catch (err) {
                    throw new Error(`Bit write on ${tagName}: ${(0, utils_1.describeCipError)(err)}`);
                }
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
                    checkDataType(elemTag, elemTag.name);
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
            // Array element ("MyArray[3]") or whole tag. Read it first: that sets the type the
            // write goes out with, and says whether it is a UDT.
            const fullName = parsed.arrayIndex !== null ? `${parsed.baseName}[${parsed.arrayIndex}]` : parsed.baseName;
            const tag = new Tag(fullName);
            await controller.readTag(tag); // init type
            checkDataType(tag, tagName);
            // Structure write. Tag.type is the type name, so a structure reads as "STRUCT". Logix
            // holds STRING as a structure too (LEN + DATA), so text goes this way as well: the
            // atomic write below cannot encode a structure.
            if (tag.type === "STRUCT" && ((0, utils_1.isPlainObject)(value) || typeof value === "string")) {
                const scope = (0, utils_1.parseProgramScope)(fullName);
                const tagList = controller.state?.tagList;
                // newTag() returns a Structure when the tag list holds the template, which is what
                // turns the value into the controller's byte layout.
                const struct = typeof controller.newTag === "function" && tagList
                    ? controller.newTag(scope.name, scope.program, false)
                    : new Structure(scope.name, tagList, scope.program);
                await controller.readTag(struct);
                if (typeof value === "string") {
                    // A Structure on a LEN + DATA template reads as text; any other UDT as an object.
                    if (typeof struct.value !== "string") {
                        throw new Error((0, utils_1.isPlainObject)(struct.value)
                            ? `${tagName} is a UDT, not a STRING, so it cannot be written as text`
                            : `${tagName} is a structure, but its template is not in the tag list, so it cannot be written as text`);
                    }
                    // Handed over as bytes so LEN counts what goes into DATA: the library takes LEN
                    // from .length, which for text is characters and comes up short on non-ASCII.
                    const bytes = Buffer.from(value, "utf8");
                    const template = tagList.getTemplateByTag(scope.name, scope.program);
                    const capacity = stringCapacity(template);
                    if (capacity !== null && bytes.length > capacity) {
                        throw new Error(`${tagName} holds ${capacity} characters, but the text is ${bytes.length} long`);
                    }
                    struct.value = bytes;
                    // writeTag() encodes again from the decoded value, so that has to be the bytes too.
                    struct._valueObj = bytes;
                }
                else {
                    if (!(0, utils_1.isPlainObject)(struct.value)) {
                        throw new Error(`${tagName} is a UDT, but its template is not in the tag list, so it cannot be written as an object`);
                    }
                    // Members not in msg.payload keep the values just read.
                    struct.value = (0, utils_1.mergeMembers)(struct.value, value);
                }
                await controller.writeTag(struct);
                return {
                    success: true,
                    tagName,
                    value,
                    timestamp: Date.now(),
                };
            }
            // Standard tag write
            tag.value = value;
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
        async function writeBatch(tags, use) {
            const results = [];
            for (const item of tags) {
                try {
                    const r = await writeSingleTag(item.name, item.value, use);
                    results.push(r);
                }
                catch (err) {
                    results.push({
                        success: false,
                        tagName: item.name,
                        value: item.value,
                        ...(0, utils_1.cipErrorFields)(err),
                        timestamp: Date.now(),
                    });
                }
            }
            return results;
        }
        // Connection lifecycle
        node.on("cip:connected", function () {
            node.status(utils_1.STATUS.connected((0, endpoint_dynamic_1.endpointLabel)(node)));
        });
        node.on("cip:connecting", function () {
            node.status(utils_1.STATUS.connecting((0, endpoint_dynamic_1.endpointLabel)(node)));
        });
        node.on("cip:error", function () {
            node.status({ fill: "red", shape: "ring", text: "connection error" });
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
        });
        node.on("input", async function (msg, send, done) {
            // A bare msg.endpoint names the endpoint for this write only and leaves the node
            // bound where it was, so ctx is captured before any await.
            const ctx = { endpoint: node.endpoint };
            if ((0, endpoint_dynamic_1.handleEndpointMsg)(RED, node, msg, send, done, DYN, ctx))
                return;
            const endpoint = ctx.endpoint;
            try {
                await (0, endpoint_dynamic_1.ensureConnected)(node, endpoint);
            }
            catch (err) {
                node.status({ fill: "red", shape: "ring", text: (0, utils_1.describeCipError)(err) });
                done ? done((0, utils_1.toCipError)(err)) : node.error((0, utils_1.describeCipError)(err), msg);
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
                    const { result: batchResults, elapsed } = await (0, utils_1.withTiming)(() => writeBatch(msg.tags, endpoint));
                    const allOk = batchResults.every((r) => r.success);
                    msg.payload = batchResults;
                    node.status({
                        fill: allOk ? "green" : "yellow",
                        shape: "dot",
                        text: `${batchResults.length} tags written (${elapsed}ms)`,
                    });
                    node.send((0, endpoint_dynamic_1.stampEndpoint)(msg, endpoint));
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
                const { result, elapsed } = await (0, utils_1.withTiming)(() => writeSingleTag(tag, value, endpoint));
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: `${tag} written (${elapsed}ms)`,
                });
                msg.payload = result;
                node.send((0, endpoint_dynamic_1.stampEndpoint)(msg, endpoint));
            }
            catch (err) {
                node.status({ fill: "red", shape: "ring", text: (0, utils_1.describeCipError)(err) });
                msg.payload = {
                    success: false,
                    tagName: msg.tagName || node.tagName,
                    ...(0, utils_1.cipErrorFields)(err),
                    timestamp: Date.now(),
                };
                node.error((0, utils_1.toCipError)(err, `Write failed for ${msg.tagName || node.tagName}`), msg);
                node.send((0, endpoint_dynamic_1.stampEndpoint)(msg, endpoint));
            }
            finally {
                node._writing = false;
            }
        });
        if (node.endpoint)
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