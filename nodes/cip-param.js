"use strict";
/**
 * CIP Parameter Object node — device parameterization (ODVA Volume 1, Chapter 7-16).
 *
 * Provides:
 * - Parameter Object (class 0x0F) attribute access
 * - Read/write individual parameters
 * - Parameter list discovery with metadata
 * - Support for scaling (multiplier, divisor, offset)
 * - Parameter descriptor: name, units, min, max, default
 *
 * @module cip-param
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("./utils");
const PARAMETER_CLASS = 0x0f;
// Parameter Object instance attributes
const PARAM_ATTR = {
    VALUE: 1,
    LINK_PATH_SIZE: 2,
    LINK_PATH: 3,
    DESCRIPTOR: 4,
    DATA_TYPE: 5,
    DATA_SIZE: 6,
    PARAMETER_NAME: 7,
    UNITS_STRING: 8,
    HELP_STRING: 9,
    MIN_VALUE: 10,
    MAX_VALUE: 11,
    DEFAULT_VALUE: 12,
    SCALING_MULTIPLIER: 13,
    SCALING_DIVISOR: 14,
    SCALING_OFFSET: 15,
    SCALING_BASE: 16,
    SCALING_LINKS: 17,
};
// Parameter descriptor bit field
const PARAM_DESC_FLAGS = {
    SUPPORTS_SCALING: 0x01,
    READ_ONLY: 0x02,
    ALL_INSTANCES_SAME: 0x04,
    SUPPORTS_FULL_PRECISION: 0x08,
    MONITORING_VALUE: 0x10,
};
// CIP data type code → size mapping
const DATA_TYPE_SIZE = {
    0xc1: 1, // BOOL
    0xc2: 1, // SINT
    0xc3: 2, // INT
    0xc4: 4, // DINT
    0xc5: 8, // LINT
    0xc6: 1, // USINT
    0xc7: 2, // UINT
    0xc8: 4, // UDINT
    0xca: 4, // REAL
    0xcb: 8, // LREAL
};
module.exports = function (RED) {
    function CipParamNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node._paramInstance = parseInt(config.paramInstance, 10) || 0;
        node._busy = false;
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        function buildPath(classId, instance, attribute) {
            const segments = [];
            // Class segment
            if (classId <= 0xFF) {
                segments.push(Buffer.from([0x20, classId]));
            }
            else {
                const seg = Buffer.alloc(4);
                seg.writeUInt8(0x21, 0);
                seg.writeUInt8(0x00, 1);
                seg.writeUInt16LE(classId, 2);
                segments.push(seg);
            }
            // Instance segment
            if (instance <= 0xFF) {
                segments.push(Buffer.from([0x24, instance]));
            }
            else {
                const seg = Buffer.alloc(4);
                seg.writeUInt8(0x25, 0);
                seg.writeUInt8(0x00, 1);
                seg.writeUInt16LE(instance, 2);
                segments.push(seg);
            }
            // Attribute segment
            if (attribute !== undefined) {
                if (attribute <= 0xFF) {
                    segments.push(Buffer.from([0x30, attribute]));
                }
                else {
                    const seg = Buffer.alloc(4);
                    seg.writeUInt8(0x31, 0);
                    seg.writeUInt8(0x00, 1);
                    seg.writeUInt16LE(attribute, 2);
                    segments.push(seg);
                }
            }
            return Buffer.concat(segments);
        }
        function buildReq(service, path, data) {
            const d = data || Buffer.alloc(0);
            const req = Buffer.alloc(2 + path.length + d.length);
            req.writeUInt8(service, 0);
            req.writeUInt8(path.length / 2, 1);
            path.copy(req, 2);
            if (d.length > 0)
                d.copy(req, 2 + path.length);
            return req;
        }
        async function sendReq(req) {
            const controller = node.endpoint.getController();
            if (!controller)
                throw new Error("Controller not available");
            const raw = await new Promise((resolve, reject) => {
                controller.write_cip(req, false, 10, (err, data) => {
                    if (err)
                        reject(err);
                    else
                        resolve(data);
                });
            });
            if (!raw || raw.length < 4)
                throw new Error("Empty response");
            const status = raw.readUInt8(2);
            const extSize = raw.readUInt8(3);
            return { status, data: raw.slice(4 + extSize * 2) };
        }
        /**
         * Parse a parameter value based on data type.
         */
        function parseValue(data, dataType) {
            if (!data || data.length === 0)
                return null;
            switch (dataType) {
                case 0xc1: return data.readUInt8(0) !== 0; // BOOL
                case 0xc2: return data.readInt8(0); // SINT
                case 0xc3: return data.readInt16LE(0); // INT
                case 0xc4: return data.readInt32LE(0); // DINT
                case 0xc6: return data.readUInt8(0); // USINT
                case 0xc7: return data.readUInt16LE(0); // UINT
                case 0xc8: return data.readUInt32LE(0); // UDINT
                case 0xca: return data.readFloatLE(0); // REAL
                case 0xcb: return data.readDoubleLE(0); // LREAL
                default:
                    if (data.length >= 4)
                        return data.readInt32LE(0);
                    if (data.length >= 2)
                        return data.readInt16LE(0);
                    return data.readUInt8(0);
            }
        }
        /**
         * Encode a value to Buffer based on data type.
         */
        function encodeValue(value, dataType) {
            const size = DATA_TYPE_SIZE[dataType] || 4;
            const buf = Buffer.alloc(size);
            switch (dataType) {
                case 0xc1:
                    buf.writeUInt8(value ? 1 : 0, 0);
                    break;
                case 0xc2:
                    buf.writeInt8(Number(value), 0);
                    break;
                case 0xc3:
                    buf.writeInt16LE(Number(value), 0);
                    break;
                case 0xc4:
                    buf.writeInt32LE(Number(value), 0);
                    break;
                case 0xc6:
                    buf.writeUInt8(Number(value), 0);
                    break;
                case 0xc7:
                    buf.writeUInt16LE(Number(value), 0);
                    break;
                case 0xc8:
                    buf.writeUInt32LE(Number(value), 0);
                    break;
                case 0xca:
                    buf.writeFloatLE(Number(value), 0);
                    break;
                case 0xcb:
                    buf.writeDoubleLE(Number(value), 0);
                    break;
                default: buf.writeInt32LE(Number(value), 0);
            }
            return buf;
        }
        /**
         * Parse a SHORT_STRING from buffer (1-byte length prefix).
         */
        function parseShortString(data, offset) {
            if (offset >= data.length)
                return { str: "", bytesConsumed: 0 };
            const len = data.readUInt8(offset);
            const str = data.slice(offset + 1, offset + 1 + len).toString("utf8");
            return { str, bytesConsumed: 1 + len };
        }
        /**
         * Read full parameter descriptor for an instance.
         */
        async function readParameter(instance) {
            const param = { instance, timestamp: Date.now() };
            // Try GetAttributeAll first for efficiency
            try {
                const path = buildPath(PARAMETER_CLASS, instance);
                const req = buildReq(0x01, path);
                const { status, data } = await sendReq(req);
                if (status === 0 && data.length >= 4) {
                    // Parse GetAttributeAll response
                    // Format varies, but typically: value + descriptor + dataType + dataSize + name + ...
                    param.rawAll = data;
                    param.success = true;
                }
            }
            catch (_) { }
            // Read individual attributes for reliable parsing
            // Value
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.VALUE);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0)
                    param.valueRaw = data;
            }
            catch (_) { }
            // Data Type
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.DATA_TYPE);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && data.length >= 2) {
                    param.dataType = data.readUInt16LE(0);
                    const typeNames = {
                        0xc1: "BOOL", 0xc2: "SINT", 0xc3: "INT", 0xc4: "DINT",
                        0xc6: "USINT", 0xc7: "UINT", 0xc8: "UDINT",
                        0xca: "REAL", 0xcb: "LREAL",
                    };
                    param.dataTypeName = typeNames[param.dataType] || `0x${param.dataType.toString(16)}`;
                }
            }
            catch (_) { }
            // Parse value with type info
            if (param.valueRaw && param.dataType) {
                param.value = parseValue(param.valueRaw, param.dataType);
            }
            else if (param.valueRaw) {
                // Best guess
                if (param.valueRaw.length >= 4)
                    param.value = param.valueRaw.readFloatLE(0);
                else if (param.valueRaw.length >= 2)
                    param.value = param.valueRaw.readInt16LE(0);
                else
                    param.value = param.valueRaw.readUInt8(0);
            }
            // Data Size
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.DATA_SIZE);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && data.length >= 1)
                    param.dataSize = data.readUInt8(0);
            }
            catch (_) { }
            // Descriptor flags
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.DESCRIPTOR);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && data.length >= 2) {
                    const desc = data.readUInt16LE(0);
                    param.descriptor = desc;
                    param.readOnly = (desc & PARAM_DESC_FLAGS.READ_ONLY) !== 0;
                    param.supportsScaling = (desc & PARAM_DESC_FLAGS.SUPPORTS_SCALING) !== 0;
                    param.isMonitoring = (desc & PARAM_DESC_FLAGS.MONITORING_VALUE) !== 0;
                }
            }
            catch (_) { }
            // Name
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.PARAMETER_NAME);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && data.length >= 1) {
                    const { str } = parseShortString(data, 0);
                    param.name = str;
                }
            }
            catch (_) { }
            // Units
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.UNITS_STRING);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && data.length >= 1) {
                    const { str } = parseShortString(data, 0);
                    param.units = str;
                }
            }
            catch (_) { }
            // Min value
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.MIN_VALUE);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && param.dataType) {
                    param.minValue = parseValue(data, param.dataType);
                }
            }
            catch (_) { }
            // Max value
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.MAX_VALUE);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && param.dataType) {
                    param.maxValue = parseValue(data, param.dataType);
                }
            }
            catch (_) { }
            // Default value
            try {
                const p = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.DEFAULT_VALUE);
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && param.dataType) {
                    param.defaultValue = parseValue(data, param.dataType);
                }
            }
            catch (_) { }
            // Scaling
            if (param.supportsScaling) {
                try {
                    const mp = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.SCALING_MULTIPLIER);
                    const { status: ms, data: md } = await sendReq(buildReq(0x0e, mp));
                    if (ms === 0 && md.length >= 2)
                        param.scalingMultiplier = md.readUInt16LE(0);
                    const dp = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.SCALING_DIVISOR);
                    const { status: ds, data: dd } = await sendReq(buildReq(0x0e, dp));
                    if (ds === 0 && dd.length >= 2)
                        param.scalingDivisor = dd.readUInt16LE(0);
                    const op = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.SCALING_OFFSET);
                    const { status: os, data: od } = await sendReq(buildReq(0x0e, op));
                    if (os === 0 && od.length >= 2)
                        param.scalingOffset = od.readInt16LE(0);
                    // Apply scaling to value
                    if (param.value !== undefined && param.scalingMultiplier && param.scalingDivisor) {
                        param.scaledValue =
                            (param.value * param.scalingMultiplier) / param.scalingDivisor +
                                (param.scalingOffset || 0);
                    }
                }
                catch (_) { }
            }
            // Clean up raw buffers from output
            delete param.valueRaw;
            delete param.rawAll;
            param.success = true;
            return param;
        }
        /**
         * Write a parameter value.
         */
        async function writeParameter(instance, value, dataType) {
            // If we don't know the type, read it first
            if (!dataType) {
                try {
                    const tp = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.DATA_TYPE);
                    const { status, data } = await sendReq(buildReq(0x0e, tp));
                    if (status === 0 && data.length >= 2) {
                        dataType = data.readUInt16LE(0);
                    }
                }
                catch (_) { }
            }
            if (!dataType)
                dataType = 0xc4; // default DINT
            const valBuf = encodeValue(value, dataType);
            const path = buildPath(PARAMETER_CLASS, instance, PARAM_ATTR.VALUE);
            const req = buildReq(0x10, path, valBuf); // SetAttributeSingle
            const resp = await sendReq(req);
            return {
                success: resp.status === 0,
                instance,
                value,
                status: resp.status,
                statusText: (0, utils_1.cipStatusText)(resp.status),
                timestamp: Date.now(),
            };
        }
        /**
         * Discover all available parameters.
         */
        async function discoverParameters() {
            const params = [];
            // Read class attribute: max instance (class level, instance 0, attribute 2)
            let maxInstance = 50; // default scan range
            try {
                const p = buildPath(PARAMETER_CLASS, 0, 2); // Max Instance attribute
                const { status, data } = await sendReq(buildReq(0x0e, p));
                if (status === 0 && data.length >= 2) {
                    maxInstance = data.readUInt16LE(0);
                }
            }
            catch (_) { }
            for (let i = 1; i <= maxInstance && i <= 200; i++) {
                try {
                    // Quick check: try reading value attribute
                    const p = buildPath(PARAMETER_CLASS, i, PARAM_ATTR.VALUE);
                    const { status } = await sendReq(buildReq(0x0e, p));
                    if (status === 0) {
                        const param = await readParameter(i);
                        params.push(param);
                    }
                    else if (status === 0x05 || status === 0x16) {
                        // Path/object doesn't exist - stop scanning
                        continue;
                    }
                }
                catch (_) {
                    continue;
                }
                // Progress update
                if (i % 10 === 0) {
                    node.status({ fill: "blue", shape: "dot", text: `scanning ${i}/${maxInstance}` });
                }
            }
            return params;
        }
        // Connection lifecycle
        node.on("cip:connected", function () { node.status(utils_1.STATUS.connected()); });
        node.on("cip:connecting", function () { node.status(utils_1.STATUS.connecting()); });
        node.on("cip:error", function () {
            node.status({ fill: "red", shape: "ring", text: "connection error" });
        });
        node.on("cip:disconnected", function () { node.status(utils_1.STATUS.disconnected()); });
        node.on("input", async function (msg) {
            if (!node.endpoint.connected) {
                node.error("Not connected", msg);
                return;
            }
            if (node._busy) {
                node.warn("Request in progress");
                return;
            }
            node._busy = true;
            node.status({ fill: "yellow", shape: "dot", text: "processing..." });
            try {
                const command = msg.command || msg.topic || "read";
                const instance = msg.instance || node._paramInstance;
                switch (command) {
                    case "read": {
                        if (!instance) {
                            throw new Error("No parameter instance specified");
                        }
                        const { result, elapsed } = await (0, utils_1.withTiming)(() => readParameter(instance));
                        result.elapsed = elapsed;
                        msg.payload = result;
                        const nameText = result.name || `param ${instance}`;
                        node.status({ fill: "green", shape: "dot", text: `${nameText}=${result.value}` });
                        break;
                    }
                    case "write": {
                        if (!instance)
                            throw new Error("No parameter instance specified");
                        const value = msg.payload?.value !== undefined ? msg.payload.value : msg.payload;
                        const dataType = msg.dataType || msg.payload?.dataType;
                        const { result, elapsed } = await (0, utils_1.withTiming)(() => writeParameter(instance, value, dataType));
                        result.elapsed = elapsed;
                        msg.payload = result;
                        node.status({
                            fill: result.success ? "green" : "red",
                            shape: "dot",
                            text: result.success ? `wrote ${instance}` : "write failed",
                        });
                        break;
                    }
                    case "discover":
                    case "list": {
                        const { result, elapsed } = await (0, utils_1.withTiming)(() => discoverParameters());
                        msg.payload = {
                            success: true,
                            command: "discover",
                            parameters: result,
                            count: result.length,
                            elapsed,
                            timestamp: Date.now(),
                        };
                        node.status({ fill: "green", shape: "dot", text: `${result.length} params` });
                        break;
                    }
                    default:
                        msg.payload = {
                            success: false,
                            error: `Unknown command: ${command}. Use: read, write, discover`,
                        };
                }
                node.send(msg);
            }
            catch (err) {
                msg.payload = { success: false, error: err.message };
                node.error(`Parameter error: ${err.message}`, msg);
                node.status(utils_1.STATUS.error(err.message));
                node.send(msg);
            }
            finally {
                node._busy = false;
            }
        });
        node.endpoint.register(node);
        node.on("close", function (done) {
            if (node.endpoint)
                node.endpoint.deregister(node);
            done();
        });
    }
    RED.nodes.registerType("cip-param", CipParamNode);
};
//# sourceMappingURL=cip-param.js.map