"use strict";
/**
 * CIP Sync node — IEEE 1588 PTP time synchronization (ODVA Volume 2, Chapter 8).
 *
 * Provides:
 * - PTP grandmaster discovery via Time Sync Object (class 0x43)
 * - System time offset calculation
 * - PTP clock quality reading
 * - IEEE 1588 attribute monitoring (via explicit messaging)
 *
 * Note: True hardware PTP requires NIC timestamping. This implementation
 * reads PTP status via CIP explicit messaging to the Time Sync Object.
 *
 * @module cip-sync
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("./utils");
const TIME_SYNC_CLASS = 0x43;
// Time Sync Object attributes
const TS_ATTR = {
    PTP_ENABLE: 1,
    IS_SYNCHRONIZED: 2,
    SYSTEM_TIME_MICROSECONDS: 3,
    SYSTEM_TIME_NANOSECONDS: 4,
    OFFSET_FROM_MASTER: 5,
    MAX_OFFSET_FROM_MASTER: 6,
    MEAN_PATH_DELAY_TO_MASTER: 7,
    GRANDMASTER_CLOCK_INFO: 8,
    PARENT_CLOCK_INFO: 9,
    LOCAL_CLOCK_INFO: 10,
    NUMBER_OF_PORTS: 11,
    PORT_STATE_INFO: 12,
    PORT_ENABLE_CFG: 13,
    PORT_LOG_ANNOUNCE_INTERVAL: 14,
    PORT_LOG_SYNC_INTERVAL: 15,
    PRIORITY1: 16,
    PRIORITY2: 17,
    DOMAIN_NUMBER: 18,
    CLOCK_TYPE: 19,
    MANUFACTURE_IDENTITY: 20,
    PRODUCT_DESCRIPTION: 21,
    REVISION_DATA: 22,
    USER_DESCRIPTION: 23,
    PORT_PROFILE_IDENTITY: 24,
    PORT_PHY_INFO: 25,
    PORT_PHYSICAL_ADDR: 26,
    PORT_PROTOCOL_ADDR: 27,
    STEPS_REMOVED: 28,
    TIME_SYNC_TIME_SOURCE: 29,
};
module.exports = function (RED) {
    function CipSyncNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node._pollInterval = parseInt(config.pollInterval, 10) || 0;
        node._pollTimer = null;
        node._busy = false;
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        /**
         * Build CIP request for Time Sync Object.
         */
        function buildTimeSyncRequest(service, instance, attribute) {
            const pathParts = [0x20, TIME_SYNC_CLASS, 0x24, instance];
            if (attribute !== undefined) {
                pathParts.push(0x30, attribute);
            }
            const path = Buffer.from(pathParts);
            const req = Buffer.alloc(2 + path.length);
            req.writeUInt8(service, 0);
            req.writeUInt8(path.length / 2, 1);
            path.copy(req, 2);
            return req;
        }
        /**
         * Send a CIP request and get parsed response.
         */
        async function sendCIPRequest(req) {
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
            const data = raw.slice(4 + extSize * 2);
            return { status, data };
        }
        /**
         * Read a single Time Sync attribute.
         */
        async function readAttribute(attribute) {
            const req = buildTimeSyncRequest(0x0e, 1, attribute); // GetAttributeSingle
            return sendCIPRequest(req);
        }
        /**
         * Read all PTP status information.
         */
        async function readPTPStatus() {
            const result = { timestamp: Date.now() };
            // Try GetAttributeAll first
            try {
                const req = buildTimeSyncRequest(0x01, 1); // GetAttributeAll
                const { status, data } = await sendCIPRequest(req);
                if (status === 0 && data.length > 0) {
                    result.success = true;
                    result.source = "GetAttributeAll";
                    result.raw = data;
                    // Parse what we can from the bulk response
                    let off = 0;
                    if (data.length >= off + 1) {
                        result.ptpEnable = data.readUInt8(off) !== 0;
                        off += 1;
                    }
                    if (data.length >= off + 1) {
                        result.isSynchronized = data.readUInt8(off) !== 0;
                        off += 1;
                    }
                    if (data.length >= off + 8) {
                        // System time in microseconds (LINT = 64-bit, use BigInt for precision)
                        const low = BigInt(data.readUInt32LE(off));
                        const high = BigInt(data.readUInt32LE(off + 4));
                        const microsecondsBig = (high << 32n) | low;
                        result.systemTimeMicroseconds = Number(microsecondsBig);
                        result.systemTimeDate = new Date(Number(microsecondsBig / 1000n));
                        off += 8;
                    }
                    return result;
                }
            }
            catch (_) {
                // GetAttributeAll not supported, try individual attributes
            }
            // Read individual attributes
            result.success = true;
            result.source = "GetAttributeSingle";
            try {
                const { status, data } = await readAttribute(TS_ATTR.PTP_ENABLE);
                if (status === 0)
                    result.ptpEnable = data.length > 0 ? data.readUInt8(0) !== 0 : null;
            }
            catch (_) {
                result.ptpEnable = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.IS_SYNCHRONIZED);
                if (status === 0)
                    result.isSynchronized = data.length > 0 ? data.readUInt8(0) !== 0 : null;
            }
            catch (_) {
                result.isSynchronized = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.OFFSET_FROM_MASTER);
                if (status === 0 && data.length >= 8) {
                    const low = BigInt(data.readUInt32LE(0));
                    const high = BigInt(data.readInt32LE(4));
                    const ns = (high << 32n) | low;
                    result.offsetFromMaster = Number(ns); // nanoseconds
                    result.offsetFromMasterMs = Number(ns) / 1e6;
                }
            }
            catch (_) {
                result.offsetFromMaster = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.MEAN_PATH_DELAY_TO_MASTER);
                if (status === 0 && data.length >= 8) {
                    const low = BigInt(data.readUInt32LE(0));
                    const high = BigInt(data.readInt32LE(4));
                    const ns = (high << 32n) | low;
                    result.meanPathDelay = Number(ns);
                    result.meanPathDelayMs = Number(ns) / 1e6;
                }
            }
            catch (_) {
                result.meanPathDelay = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.GRANDMASTER_CLOCK_INFO);
                if (status === 0 && data.length >= 13) {
                    result.grandmaster = {
                        clockIdentity: data.slice(0, 8).toString("hex"),
                        clockClass: data.readUInt8(8),
                        clockAccuracy: data.readUInt8(9),
                        offsetScaledLogVariance: data.readUInt16LE(10),
                        priority1: data.length >= 14 ? data.readUInt8(12) : 0,
                        priority2: data.length >= 15 ? data.readUInt8(13) : 0,
                    };
                }
            }
            catch (_) {
                result.grandmaster = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.NUMBER_OF_PORTS);
                if (status === 0 && data.length >= 2) {
                    result.numberOfPorts = data.readUInt16LE(0);
                }
            }
            catch (_) {
                result.numberOfPorts = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.STEPS_REMOVED);
                if (status === 0 && data.length >= 2) {
                    result.stepsRemoved = data.readUInt16LE(0);
                }
            }
            catch (_) {
                result.stepsRemoved = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.DOMAIN_NUMBER);
                if (status === 0 && data.length >= 1) {
                    result.domainNumber = data.readUInt8(0);
                }
            }
            catch (_) {
                result.domainNumber = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.CLOCK_TYPE);
                if (status === 0 && data.length >= 2) {
                    const clockType = data.readUInt16LE(0);
                    result.clockType = clockType;
                    result.clockTypeText = [];
                    if (clockType & 0x01)
                        result.clockTypeText.push("Ordinary Clock");
                    if (clockType & 0x02)
                        result.clockTypeText.push("Boundary Clock");
                    if (clockType & 0x04)
                        result.clockTypeText.push("Peer-to-Peer Transparent Clock");
                    if (clockType & 0x08)
                        result.clockTypeText.push("End-to-End Transparent Clock");
                    if (clockType & 0x80)
                        result.clockTypeText.push("Slave Only");
                }
            }
            catch (_) {
                result.clockType = null;
            }
            try {
                const { status, data } = await readAttribute(TS_ATTR.TIME_SYNC_TIME_SOURCE);
                if (status === 0 && data.length >= 1) {
                    const src = data.readUInt8(0);
                    const sourceNames = {
                        0x10: "Atomic Clock",
                        0x20: "GPS",
                        0x30: "Terrestrial Radio",
                        0x40: "PTP",
                        0x50: "NTP",
                        0x60: "Hand Set",
                        0x90: "Other",
                        0xA0: "Internal Oscillator",
                    };
                    result.timeSource = src;
                    result.timeSourceText = sourceNames[src] || `Unknown (0x${src.toString(16)})`;
                }
            }
            catch (_) {
                result.timeSource = null;
            }
            return result;
        }
        /**
         * Enable/disable PTP on the device.
         */
        async function setPTPEnable(enable) {
            const path = Buffer.from([
                0x20, TIME_SYNC_CLASS, 0x24, 0x01, 0x30, TS_ATTR.PTP_ENABLE,
            ]);
            const data = Buffer.alloc(1);
            data.writeUInt8(enable ? 1 : 0, 0);
            const req = Buffer.alloc(2 + path.length + data.length);
            req.writeUInt8(0x10, 0); // SetAttributeSingle
            req.writeUInt8(path.length / 2, 1);
            path.copy(req, 2);
            data.copy(req, 2 + path.length);
            const resp = await sendCIPRequest(req);
            return { success: resp.status === 0, status: resp.status };
        }
        // Connection lifecycle
        node.on("cip:connected", function () {
            node.status(utils_1.STATUS.connected());
            if (node._pollInterval > 0) {
                node._pollTimer = setInterval(() => {
                    if (!node._busy)
                        doRead();
                }, node._pollInterval);
            }
        });
        node.on("cip:connecting", function () { node.status(utils_1.STATUS.connecting()); });
        node.on("cip:error", function () {
            node.status({ fill: "red", shape: "ring", text: "connection error" });
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected());
            if (node._pollTimer) {
                clearInterval(node._pollTimer);
                node._pollTimer = null;
            }
        });
        async function doRead() {
            if (!node.endpoint.connected || node._busy)
                return;
            node._busy = true;
            try {
                const { result, elapsed } = await (0, utils_1.withTiming)(() => readPTPStatus());
                result.elapsed = elapsed;
                const syncText = result.isSynchronized ? "synced" : "not synced";
                node.status({
                    fill: result.isSynchronized ? "green" : "yellow",
                    shape: "dot",
                    text: `PTP ${syncText} (${elapsed}ms)`,
                });
                node.send({ payload: result });
            }
            catch (err) {
                node.status(utils_1.STATUS.error(err.message));
            }
            finally {
                node._busy = false;
            }
        }
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
            node.status({ fill: "yellow", shape: "dot", text: "reading..." });
            try {
                const command = msg.command || msg.topic || "status";
                switch (command) {
                    case "status": {
                        const { result, elapsed } = await (0, utils_1.withTiming)(() => readPTPStatus());
                        result.elapsed = elapsed;
                        msg.payload = result;
                        break;
                    }
                    case "enable": {
                        const result = await setPTPEnable(true);
                        msg.payload = { ...result, command: "enable", timestamp: Date.now() };
                        break;
                    }
                    case "disable": {
                        const result = await setPTPEnable(false);
                        msg.payload = { ...result, command: "disable", timestamp: Date.now() };
                        break;
                    }
                    case "getTime": {
                        const { status, data } = await readAttribute(TS_ATTR.SYSTEM_TIME_MICROSECONDS);
                        if (status === 0 && data.length >= 8) {
                            const low = BigInt(data.readUInt32LE(0));
                            const high = BigInt(data.readUInt32LE(4));
                            const microsecondsBig = (high << 32n) | low;
                            const microseconds = Number(microsecondsBig);
                            msg.payload = {
                                success: true,
                                command: "getTime",
                                microseconds,
                                date: new Date(Number(microsecondsBig / 1000n)),
                                timestamp: Date.now(),
                            };
                        }
                        else {
                            msg.payload = {
                                success: false,
                                command: "getTime",
                                status,
                                statusText: (0, utils_1.cipStatusText)(status),
                            };
                        }
                        break;
                    }
                    default:
                        msg.payload = {
                            success: false,
                            error: `Unknown command: ${command}. Use: status, enable, disable, getTime`,
                        };
                }
                node.status({ fill: "green", shape: "dot", text: command });
                node.send(msg);
            }
            catch (err) {
                msg.payload = { success: false, error: err.message };
                node.error(`CIP Sync error: ${err.message}`, msg);
                node.status(utils_1.STATUS.error(err.message));
                node.send(msg);
            }
            finally {
                node._busy = false;
            }
        });
        node.endpoint.register(node);
        node.on("close", function (done) {
            if (node._pollTimer) {
                clearInterval(node._pollTimer);
                node._pollTimer = null;
            }
            if (node.endpoint)
                node.endpoint.deregister(node);
            done();
        });
    }
    RED.nodes.registerType("cip-sync", CipSyncNode);
};
//# sourceMappingURL=cip-sync.js.map