"use strict";
/**
 * CIP Read node — reads tag values from an Allen-Bradley PLC.
 * Supports poll-interval and trigger-based modes.
 *
 * Enhancements over JS version:
 * - Bit-level access: "MyDint.5" reads integer then extracts bit 5
 * - Array element: "MyArray[3]" reads element 3
 * - Array range: "MyArray[0..9]" reads elements 0-9 via fragmented read
 * - UDT/Structure support using Structure class from st-ethernet-ip
 * - Batch mode: msg.tags array reads multiple tags via TagGroup
 * - Backpressure protection, browse button support, polling
 * @module cip-read
 */
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("./types");
const utils_1 = require("./utils");
module.exports = function (RED) {
    function CipReadNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.tagName = config.tagName || "";
        node.dataType = config.dataType || "auto";
        node.pollInterval = parseInt(config.pollInterval, 10) || 0;
        node._pollTimer = null;
        node._reading = false;
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        function isStructureTag(tag) {
            return tag != null && tag._template != null;
        }
        function isStructType(type) {
            if (type === types_1.CIPDataType.STRUCT || type === "STRUCT")
                return true;
            if (typeof type === "object" && type !== null && type.code === types_1.CIPDataType.STRUCT) {
                return true;
            }
            return false;
        }
        function createTag(controller, tagName, program, readSize = 1) {
            const { Tag } = require("st-ethernet-ip");
            if (typeof controller.newTag === "function" && controller.state?.tagList) {
                return controller.newTag(tagName, program, false, 0, readSize);
            }
            return new Tag(tagName, program, null, 0, 0, readSize);
        }
        function formatResultType(type) {
            if (typeof type === "string")
                return type;
            if (typeof type === "number")
                return (0, utils_1.cipTypeName)(type);
            return String(type ?? "");
        }
        /**
         * Read a single tag with support for bit access, array elements, array ranges, and UDTs.
         */
        async function readSingleTag(tagName, options = {}) {
            const parsed = (0, utils_1.parseTagName)(tagName);
            const controller = node.endpoint.getController();
            if (!controller)
                throw new Error("Controller not available");
            const effectiveDataType = options.dataType ?? node.dataType;
            const scope = (0, utils_1.parseProgramScope)(parsed.baseName);
            const tagList = controller.state?.tagList;
            const memberInfo = (0, utils_1.resolveMemberInfo)(scope.name, tagList, scope.program);
            // Array range read: "MyArray[0..9]" or "Struct.Member[0..101]"
            if (parsed.isRange && parsed.arrayStart !== null && parsed.arrayEnd !== null) {
                const count = parsed.arrayEnd - parsed.arrayStart + 1;
                const indexedName = `${parsed.baseName}[${parsed.arrayStart}]`;
                const tag = createTag(controller, indexedName, scope.program, count);
                await controller.readTag(tag);
                return {
                    value: tag.value,
                    type: formatResultType(tag.type),
                };
            }
            // Array element read: "MyArray[3]"
            if (parsed.arrayIndex !== null) {
                const indexedName = `${parsed.baseName}[${parsed.arrayIndex}]`;
                const tag = createTag(controller, indexedName, scope.program);
                await controller.readTag(tag);
                return {
                    value: tag.value,
                    type: formatResultType(tag.type),
                    arrayIndex: parsed.arrayIndex,
                };
            }
            // Bit-level access: "MyDint.5"
            if (parsed.bitIndex !== null) {
                const tag = createTag(controller, parsed.baseName, scope.program);
                await controller.readTag(tag);
                const bitValue = (0, utils_1.getBit)(tag.value, parsed.bitIndex);
                return {
                    value: bitValue,
                    type: formatResultType(tag.type),
                    bitIndex: parsed.bitIndex,
                };
            }
            // Explicit STRUCT read (or auto when tag list marks the path as a
            // non-array UDT; arrays of structs fall through to the array branch)
            if (effectiveDataType === "STRUCT" ||
                (effectiveDataType === "auto" && memberInfo.isStruct && !memberInfo.isArray)) {
                const tag = createTag(controller, parsed.baseName, scope.program);
                await controller.readTag(tag);
                if (isStructureTag(tag)) {
                    return {
                        value: tag.value,
                        type: "STRUCT",
                    };
                }
                if (effectiveDataType === "STRUCT") {
                    throw new Error(`Tag "${parsed.baseName}" is not a UDT/STRUCT (tag list template missing?)`);
                }
            }
            // Full array read when ARRAY is selected, a size is provided, or
            // auto-detect resolved the path to an array via the tag list
            if (effectiveDataType === "ARRAY" ||
                options.arraySize != null ||
                (effectiveDataType === "auto" && memberInfo.isArray)) {
                const tag = createTag(controller, parsed.baseName, scope.program, 1);
                let size = options.arraySize ?? memberInfo.arraySize ?? null;
                if (size != null && size > 1) {
                    tag.read_size = size;
                    await controller.readTag(tag);
                }
                else if (typeof controller.getTagArraySize === "function") {
                    size = await controller.getTagArraySize(tag);
                    await controller.readTag(tag);
                }
                else {
                    await controller.readTag(tag);
                }
                return {
                    value: tag.value,
                    type: formatResultType(tag.type),
                };
            }
            // Standard scalar read
            const tag = createTag(controller, parsed.baseName, scope.program);
            await controller.readTag(tag);
            // Auto-detect STRUCT from response type or raw buffer payload
            if (effectiveDataType === "auto" &&
                (isStructType(tag.type) || tag.state?.tag?.type === types_1.CIPDataType.STRUCT)) {
                const structTag = createTag(controller, parsed.baseName, scope.program);
                await controller.readTag(structTag);
                if (isStructureTag(structTag) && !Buffer.isBuffer(structTag.value)) {
                    return {
                        value: structTag.value,
                        type: "STRUCT",
                    };
                }
                if (Buffer.isBuffer(tag.value)) {
                    node.warn(`Structure read for "${parsed.baseName}" returned raw buffer; tag list templates may be incomplete`);
                }
            }
            return {
                value: tag.value,
                type: formatResultType(tag.type),
            };
        }
        /**
         * Read multiple tags using TagGroup for batch efficiency.
         */
        async function readBatch(tags) {
            const controller = node.endpoint.getController();
            if (!controller)
                throw new Error("Controller not available");
            const { Tag, TagGroup } = require("st-ethernet-ip");
            const group = new TagGroup();
            const tagObjects = [];
            for (const tagName of tags) {
                const parsed = (0, utils_1.parseTagName)(tagName);
                const scope = (0, utils_1.parseProgramScope)(parsed.baseName);
                const memberInfo = (0, utils_1.resolveMemberInfo)(scope.name, controller.state?.tagList, scope.program);
                const needsSpecialRead = parsed.bitIndex !== null ||
                    parsed.isRange ||
                    node.dataType === "ARRAY" ||
                    node.dataType === "STRUCT" ||
                    memberInfo.isStruct ||
                    memberInfo.isArray;
                if (needsSpecialRead) {
                    tagObjects.push({ name: tagName, tag: null, individual: true });
                }
                else {
                    const fullName = parsed.arrayIndex !== null
                        ? `${parsed.baseName}[${parsed.arrayIndex}]`
                        : parsed.baseName;
                    const tag = createTag(controller, fullName, scope.program);
                    group.add(tag);
                    tagObjects.push({ name: tagName, tag, individual: false });
                }
            }
            if (group.size > 0) {
                await controller.readTagGroup(group);
            }
            const results = [];
            for (const item of tagObjects) {
                if (item.individual) {
                    try {
                        const r = await readSingleTag(item.name);
                        results.push({
                            tagName: item.name,
                            value: r.value,
                            type: r.type,
                        });
                    }
                    catch (err) {
                        results.push({
                            tagName: item.name,
                            value: null,
                            type: "",
                            error: err.message,
                        });
                    }
                }
                else {
                    results.push({
                        tagName: item.name,
                        value: item.tag.value,
                        type: formatResultType(item.tag.type),
                    });
                }
            }
            return results;
        }
        /**
         * Read the configured tag and send the result.
         */
        async function doRead(triggerMsg) {
            if (node._reading)
                return;
            node._reading = true;
            try {
                if (triggerMsg && Array.isArray(triggerMsg.tags)) {
                    const { result: batchResult, elapsed } = await (0, utils_1.withTiming)(() => readBatch(triggerMsg.tags));
                    const msg = {
                        payload: batchResult,
                        timestamp: Date.now(),
                        _msgid: triggerMsg._msgid,
                        topic: triggerMsg.topic,
                    };
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: `${batchResult.length} tags read (${elapsed}ms)`,
                    });
                    node.send(msg);
                    return;
                }
                const tag = (triggerMsg && triggerMsg.tagName) || node.tagName;
                if (!tag) {
                    node.warn("No tag name specified");
                    return;
                }
                const readOptions = {
                    dataType: triggerMsg?.dataType,
                    arraySize: triggerMsg?.arraySize != null
                        ? parseInt(String(triggerMsg.arraySize), 10)
                        : undefined,
                };
                const { result, elapsed } = await (0, utils_1.withTiming)(() => readSingleTag(tag, readOptions));
                const msg = {
                    payload: result.value,
                    tagName: tag,
                    dataType: result.type,
                    timestamp: Date.now(),
                };
                if (result.bitIndex !== undefined) {
                    msg.bitIndex = result.bitIndex;
                }
                if (result.arrayIndex !== undefined) {
                    msg.arrayIndex = result.arrayIndex;
                }
                if (triggerMsg) {
                    msg._msgid = triggerMsg._msgid;
                    msg.topic = triggerMsg.topic;
                }
                const displayValue = typeof result.value === "boolean"
                    ? result.value
                        ? "true"
                        : "false"
                    : Array.isArray(result.value)
                        ? `array[${result.value.length}]`
                        : typeof result.value === "object" && result.value !== null
                            ? "object"
                            : String(result.value);
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: `${tag} = ${displayValue} (${elapsed}ms)`,
                });
                node.send(msg);
            }
            catch (err) {
                node.status({ fill: "red", shape: "ring", text: err.message });
                node.error(`Read failed: ${err.message}`, triggerMsg || {});
            }
            finally {
                node._reading = false;
            }
        }
        function startPolling() {
            stopPolling();
            if (node.pollInterval > 0) {
                node._pollTimer = setInterval(() => doRead(), node.pollInterval);
            }
        }
        function stopPolling() {
            if (node._pollTimer) {
                clearInterval(node._pollTimer);
                node._pollTimer = null;
            }
        }
        node.on("cip:connected", function () {
            node.status(utils_1.STATUS.connected());
            startPolling();
        });
        node.on("cip:connecting", function () {
            node.status(utils_1.STATUS.connecting());
            stopPolling();
        });
        node.on("cip:error", function () {
            node.status({ fill: "red", shape: "ring", text: "connection error" });
            stopPolling();
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected());
            stopPolling();
        });
        node.on("input", function (msg) {
            if (!node.endpoint.connected) {
                node.status({ fill: "red", shape: "ring", text: "not connected" });
                node.error("Not connected to PLC", msg);
                return;
            }
            doRead(msg);
        });
        node.endpoint.register(node);
        node.on("close", function (done) {
            stopPolling();
            if (node.endpoint) {
                node.endpoint.deregister(node);
            }
            done();
        });
    }
    RED.nodes.registerType("cip-read", CipReadNode);
};
//# sourceMappingURL=cip-read.js.map