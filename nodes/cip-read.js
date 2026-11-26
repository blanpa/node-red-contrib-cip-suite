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
require("./st-type-patch");
const types_1 = require("./types");
const utils_1 = require("./utils");
const tag_array_1 = require("./tag-array");
const read_plan_1 = require("./read-plan");
const endpoint_dynamic_1 = require("./endpoint-dynamic");
module.exports = function (RED) {
    function CipReadNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint) || null;
        node.tagName = config.tagName || "";
        node.dataType = config.dataType || "auto";
        node.pollInterval = parseInt(config.pollInterval, 10) || 0;
        // A node with a mode takes every value from the source its typed input names. One saved
        // before modes existed has no plan and behaves as it always did.
        const plan = (0, read_plan_1.buildReadPlan)(config, (value, type, msg) => RED.util.evaluateNodeProperty(value, type, node, msg));
        if (plan) {
            // These fields mean something else (or nothing) once a mode is set, so a stray value
            // must not leak into a read.
            node.tagName = "";
            node.dataType = "auto";
            node.pollInterval = 0;
            if (plan.poll.error) {
                node.error(plan.poll.error);
            }
            else if (plan.poll.interval > 0) {
                if (plan.dynamic) {
                    node.warn("Poll interval ignored: a message supplies a value, so there is nothing to read on a timer");
                }
                else {
                    node.pollInterval = plan.poll.interval;
                }
            }
        }
        node._pollTimer = null;
        /** The last failure a poll reported, so a tag that stays unreadable is reported once. */
        node._lastPollError = null;
        node._reading = false;
        // Array lengths are a property of the running controller program, so the
        // memo is dropped whenever the connection is re-established.
        node._arraySizes = new tag_array_1.ArraySizeCache();
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
            if (endpoint === node.endpoint) {
                return;
            }
            stopPolling();
            // Deregistering is enough to stop the old endpoint's broadcasts reaching us: it
            // fans out by emitting on its registered user nodes, so our cip:* listeners never
            // need rewiring.
            if (node.endpoint)
                node.endpoint.deregister(node);
            node.endpoint = endpoint;
            endpoint.register(node, { connect: false });
            // register() only emits an event when the new endpoint is already connected, so
            // without this the status would still name the endpoint we just left.
            if (!endpoint.connected) {
                node.status(endpoint.connecting
                    ? utils_1.STATUS.connecting((0, endpoint_dynamic_1.endpointLabel)(node))
                    : utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
            }
        }
        const DYN = { type: "cip-endpoint", switchTo: useEndpoint };
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
        /**
         * Build a tag object for a path. Goes through `Controller.newTag()` when a
         * tag list is available so UDT paths come back as a `Structure` (which
         * decodes into an object) rather than a plain `Tag` (which yields raw bytes).
         *
         * `arrayDims` must be > 0 when reading several elements of a UDT array, or
         * `Structure` decodes the whole buffer as one element.
         */
        function createTag(controller, tagName, program, readSize = 1, arrayDims = 0) {
            const { Tag } = require("st-ethernet-ip");
            if (typeof controller.newTag === "function" && controller.state?.tagList) {
                return controller.newTag(tagName, program, false, arrayDims, readSize);
            }
            return new Tag(tagName, program, null, 0, arrayDims, readSize);
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
        async function readSingleTag(tagName, options = {}, use) {
            const parsed = (0, utils_1.parseTagName)(tagName);
            const endpoint = use || node.endpoint;
            if (!endpoint)
                throw new Error("No endpoint selected");
            const controller = endpoint.getController();
            if (!controller)
                throw new Error("Controller not available");
            const effectiveDataType = options.dataType ?? node.dataType;
            const rawScope = (0, utils_1.parseProgramScope)(parsed.baseName);
            const tagList = controller.state?.tagList;
            // Match the controller's own casing before any tag object is built:
            // st-ethernet-ip resolves UDT members case-sensitively, so "fis_stn[0].local"
            // would otherwise read back as raw struct bytes instead of an object.
            const scope = {
                program: rawScope.program,
                name: (0, utils_1.canonicalizeTagName)(rawScope.name, tagList, rawScope.program),
            };
            // The program name travels as a separate argument to the tag constructor,
            // so the path itself must not keep its "Program:<name>." prefix.
            parsed.baseName = scope.name;
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
            if (!memberInfo.isArray &&
                (effectiveDataType === "STRUCT" ||
                    (effectiveDataType === "auto" && memberInfo.isStruct))) {
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
            // Full array read when ARRAY is selected, a size is provided, or the tag
            // list resolved the path to an array
            if (effectiveDataType === "ARRAY" ||
                options.arraySize != null ||
                ((effectiveDataType === "auto" || effectiveDataType === "STRUCT") && memberInfo.isArray)) {
                // UDT members carry their length in the template; array tags do not, so
                // those are resolved from the controller and memoised per connection.
                let size = options.arraySize ?? (memberInfo.isArray ? memberInfo.arraySize : null) ?? null;
                if (size == null || size < 1) {
                    const resolved = await (0, tag_array_1.resolveArrayLength)(controller, parsed.baseName, scope.program, (indexedName) => createTag(controller, indexedName, scope.program), node._arraySizes);
                    size = resolved?.size ?? 1;
                }
                // A UDT array needs arrayDims > 0 or Structure decodes the whole
                // response as a single element.
                const tag = createTag(controller, parsed.baseName, scope.program, size, size > 1 ? 1 : 0);
                await controller.readTag(tag);
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
        async function readBatch(entries, use) {
            const endpoint = use || node.endpoint;
            if (!endpoint)
                throw new Error("No endpoint selected");
            const controller = endpoint.getController();
            if (!controller)
                throw new Error("Controller not available");
            const { TagGroup } = require("st-ethernet-ip");
            const group = new TagGroup();
            const tagObjects = [];
            for (const entry of entries) {
                const tagName = entry.name;
                try {
                    const parsed = (0, utils_1.parseTagName)(tagName);
                    const rawScope = (0, utils_1.parseProgramScope)(parsed.baseName);
                    const tagList = controller.state?.tagList;
                    const scope = {
                        program: rawScope.program,
                        name: (0, utils_1.canonicalizeTagName)(rawScope.name, tagList, rawScope.program),
                    };
                    parsed.baseName = scope.name;
                    const memberInfo = (0, utils_1.resolveMemberInfo)(scope.name, tagList, scope.program);
                    const dataType = entry.dataType ?? node.dataType;
                    const needsSpecialRead = parsed.bitIndex !== null ||
                        parsed.isRange ||
                        dataType === "ARRAY" ||
                        dataType === "STRUCT" ||
                        entry.arraySize != null ||
                        memberInfo.isStruct ||
                        memberInfo.isArray;
                    if (needsSpecialRead) {
                        tagObjects.push({ name: tagName, tag: null, individual: true, entry });
                    }
                    else {
                        const fullName = parsed.arrayIndex !== null ? `${parsed.baseName}[${parsed.arrayIndex}]` : scope.name;
                        const tag = createTag(controller, fullName, scope.program);
                        group.add(tag);
                        tagObjects.push({ name: tagName, tag, individual: false });
                    }
                }
                catch (err) {
                    tagObjects.push({ name: tagName, tag: null, individual: false, error: (0, utils_1.describeCipError)(err) });
                }
            }
            // TagGroup counts its members through `length`; `size` is undefined, which
            // used to skip the group read entirely and return null for every tag in it.
            // One tag the controller rejects (such as a name that does not exist) fails the whole
            // group reply and leaves every tag in it null. When the controller did answer, read
            // the plain tags one at a time so each gets its own value or error. Anything without
            // a CIP status is a connection problem and fails the batch as before.
            let groupFailed = false;
            if (group.length > 0) {
                try {
                    await controller.readTagGroup(group);
                }
                catch (err) {
                    if (typeof err?.generalStatusCode !== "number")
                        throw err;
                    groupFailed = true;
                }
            }
            const results = [];
            for (const item of tagObjects) {
                if (item.error) {
                    results.push({ tagName: item.name, value: null, type: "", error: item.error });
                }
                else if (item.individual) {
                    try {
                        const r = await readSingleTag(item.name, { dataType: item.entry?.dataType, arraySize: item.entry?.arraySize }, endpoint);
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
                            ...(0, utils_1.cipErrorFields)(err),
                        });
                    }
                }
                else if (groupFailed) {
                    try {
                        await controller.readTag(item.tag);
                        results.push({
                            tagName: item.name,
                            value: item.tag.value,
                            type: formatResultType(item.tag.type),
                        });
                    }
                    catch (err) {
                        results.push({ tagName: item.name, value: null, type: "", ...(0, utils_1.cipErrorFields)(err) });
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
        /** What to do about each message property the node ignores. */
        const UNUSED_PROP_ADVICE = {
            tags: 'Ignoring msg.tags. Set Mode to "Multiple from msg" and the property to msg.tags to read the tags from the message.',
            arraySize: 'Ignoring msg.arraySize. Set Array size to "msg" to read it from the message.',
        };
        const warnedUnused = new Set();
        /**
         * Tell the user, once per deploy, that a message carries a property this node does not
         * read. A node with a mode only reads what its typed inputs name, so a flow that used to
         * rely on msg.tags or msg.arraySize overriding the node would otherwise just change.
         */
        function warnUnusedProps(triggerMsg) {
            if (!plan)
                return;
            for (const name of plan.unusedProps(triggerMsg)) {
                if (warnedUnused.has(name))
                    continue;
                warnedUnused.add(name);
                node.warn(UNUSED_PROP_ADVICE[name]);
            }
        }
        /**
         * What to read for a node saved before modes existed: the message can override the
         * node, as it always could. Left exactly as it was so deployed flows do not change.
         */
        function legacyRequest(triggerMsg) {
            // msg.tags (an array, or a comma separated string) wins over the configured Tag Name.
            const batchTags = triggerMsg?.tags;
            if (Array.isArray(batchTags) || (typeof batchTags === "string" && batchTags.trim() !== "")) {
                return { kind: "batch", entries: (0, utils_1.parseBatchTags)(batchTags), source: "msg.tags" };
            }
            const tag = (triggerMsg && triggerMsg.tagName) || node.tagName;
            if (!tag)
                return { kind: "none", reason: "No tag name specified" };
            return {
                kind: "single",
                tag,
                dataType: triggerMsg?.dataType,
                arraySize: triggerMsg?.arraySize != null ? parseInt(String(triggerMsg.arraySize), 10) : undefined,
            };
        }
        /**
         * Read the configured tag and send the result.
         */
        async function doRead(triggerMsg, done, use) {
            // The endpoint for this read alone. Polling passes none and uses the node's own.
            const endpoint = use || node.endpoint;
            // Errors reach done() so a Catch node can see them. Polling passes no done, so its
            // failures still surface through node.error as before.
            const settle = (err) => {
                if (typeof done === "function") {
                    err ? done(err) : done();
                }
                else if (err) {
                    node.error(err.message, triggerMsg || {});
                }
            };
            /** Which PLC answered. Only stamped when the endpoint opts in, so static output is unchanged. */
            const stamp = (msg) => (0, endpoint_dynamic_1.stampEndpoint)(msg, endpoint);
            /**
             * A poll has no message, so what it reads is fixed by the node's configuration. If that is
             * invalid, every later poll would fail the same way, so report it once and stop polling.
             * Polling starts again the next time the endpoint connects.
             */
            const invalidConfig = (message) => {
                if (!triggerMsg && typeof done !== "function") {
                    stopPolling();
                    message += " Polling stopped.";
                }
                settle(new Error(message));
            };
            if (node._reading) {
                settle();
                return;
            }
            node._reading = true;
            try {
                if (triggerMsg)
                    warnUnusedProps(triggerMsg);
                const request = plan ? plan.resolve(triggerMsg) : legacyRequest(triggerMsg);
                if (request.kind === "none") {
                    node.warn(request.reason);
                    settle();
                    return;
                }
                if (request.kind === "error") {
                    node.status({ fill: "red", shape: "ring", text: "invalid input" });
                    invalidConfig(request.error);
                    return;
                }
                if (request.kind === "batch") {
                    // A malformed entry is a flow bug, so nothing is read until every entry is valid.
                    const entries = request.entries;
                    const invalid = entries.filter((e) => e.error);
                    if (invalid.length > 0) {
                        node.status({ fill: "red", shape: "ring", text: `invalid ${request.source}` });
                        invalidConfig(`Invalid ${request.source}, nothing was read. ${invalid.map((e) => e.error).join("; ")}`);
                        return;
                    }
                    const { result: batchResult, elapsed } = await (0, utils_1.withTiming)(() => readBatch(entries, endpoint));
                    const msg = {
                        payload: batchResult,
                        timestamp: Date.now(),
                        _msgid: triggerMsg?._msgid,
                        topic: triggerMsg?.topic,
                    };
                    const failed = batchResult.filter((r) => r.error).length;
                    node.status({
                        fill: failed > 0 ? "yellow" : "green",
                        shape: "dot",
                        text: failed > 0
                            ? `${batchResult.length - failed} of ${batchResult.length} tags read (${elapsed}ms)`
                            : `${batchResult.length} tags read (${elapsed}ms)`,
                    });
                    node.send(stamp(msg));
                    node._lastPollError = null;
                    settle();
                    return;
                }
                const tag = request.tag;
                const readOptions = { dataType: request.dataType, arraySize: request.arraySize };
                const { result, elapsed } = await (0, utils_1.withTiming)(() => readSingleTag(tag, readOptions, endpoint));
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
                node.send(stamp(msg));
                node._lastPollError = null;
                settle();
            }
            catch (err) {
                node.status({ fill: "red", shape: "ring", text: (0, utils_1.describeCipError)(err) });
                const failure = (0, utils_1.toCipError)(err, "Read failed");
                // Polling goes on, since the tag may be created or the PLC may recover, but the same
                // failure is only reported the first time. The status line keeps showing it.
                if (!triggerMsg && typeof done !== "function") {
                    if (node._lastPollError === failure.message) {
                        return;
                    }
                    node._lastPollError = failure.message;
                }
                settle(failure);
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
            node.status(utils_1.STATUS.connected((0, endpoint_dynamic_1.endpointLabel)(node)));
            node._arraySizes.clear();
            node._lastPollError = null;
            startPolling();
        });
        node.on("cip:connecting", function () {
            node.status(utils_1.STATUS.connecting((0, endpoint_dynamic_1.endpointLabel)(node)));
            stopPolling();
        });
        node.on("cip:error", function () {
            node.status({ fill: "red", shape: "ring", text: "connection error" });
            stopPolling();
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
            stopPolling();
        });
        node.on("input", function (msg, send, done) {
            // A bare msg.endpoint names the endpoint for this read only and leaves the node
            // bound where it was, so ctx is captured before any await.
            const ctx = { endpoint: node.endpoint };
            if ((0, endpoint_dynamic_1.handleEndpointMsg)(RED, node, msg, send, done, DYN, ctx))
                return;
            const endpoint = ctx.endpoint;
            if (!endpoint) {
                node.status({ fill: "red", shape: "ring", text: "no endpoint" });
                const err = new Error("No endpoint selected");
                done ? done((0, utils_1.toCipError)(err)) : node.error((0, utils_1.describeCipError)(err), msg);
                return;
            }
            (0, endpoint_dynamic_1.ensureConnected)(node, endpoint)
                .then(() => doRead(msg, done, endpoint))
                .catch((err) => {
                node.status({ fill: "red", shape: "ring", text: (0, utils_1.describeCipError)(err) });
                done ? done((0, utils_1.toCipError)(err)) : node.error((0, utils_1.describeCipError)(err), msg);
            });
        });
        if (node.endpoint)
            node.endpoint.register(node);
        node.on("close", function (removed, done) {
            stopPolling();
            if (node.endpoint) {
                node.endpoint.deregister(node, done, removed);
                return;
            }
            done();
        });
    }
    RED.nodes.registerType("cip-read", CipReadNode);
};
//# sourceMappingURL=cip-read.js.map