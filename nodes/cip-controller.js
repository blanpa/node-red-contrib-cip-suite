"use strict";
/**
 * CIP Controller node -- reads and outputs PLC controller properties and status.
 * Supports periodic polling and trigger-based reads. Mode change and reset commands are
 * refused: CIP offers no supported way to send them.
 * @module cip-controller
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("./utils");
const endpoint_dynamic_1 = require("./endpoint-dynamic");
/**
 * Run mode, from the extended device status (bits 4-7) of the Identity Status word.
 * Logix reports 0x6 in Run and 0x7 in Program.
 */
const RUN_MODE_MAP = {
    0x6: "run",
    0x7: "program",
};
/**
 * Run mode, from the Identity State attribute (8), for controllers whose Status word does
 * not carry it. A Micro800 reports Operational (3) in Run and Standby (2) in Program.
 */
const STATE_RUN_MODE_MAP = {
    2: "program",
    3: "run",
};
/** Keyswitch position, from bits 12-13 of the Status word (Logix only). */
const KEYSWITCH_MAP = {
    1: "run",
    2: "program",
    3: "remote",
};
/**
 * Parse the Identity object's Status word (attribute 5) and State (attribute 8).
 *   Bits 4-7: extended device status (0x2 = a faulted I/O connection; run mode above)
 *   Bits 8-9: minor recoverable / unrecoverable fault
 *   Bits 10-11: major recoverable / unrecoverable fault
 *   State 4 / 5: major recoverable / unrecoverable fault
 */
function parseControllerStatus(statusWord, state) {
    const extended = (statusWord >> 4) & 0x0f;
    const minorFault = (statusWord & 0x0300) !== 0;
    const majorFault = (statusWord & 0x0c00) !== 0 || state === 4 || state === 5;
    const runMode = RUN_MODE_MAP[extended] || (state !== undefined && STATE_RUN_MODE_MAP[state]) || "unknown";
    return {
        runMode,
        faulted: minorFault || majorFault,
        majorFault,
        minorFault,
        ioFault: extended === 0x2,
    };
}
function parseKeyswitch(statusWord) {
    return KEYSWITCH_MAP[(statusWord >> 12) & 0x03] || "unknown";
}
/** The value of a successful reply, or null. A Micro800 answers with service 0xD2. */
function replyData(reply) {
    if (reply.length < 4 || reply.readUInt8(2) !== 0)
        return null;
    return reply.subarray(4 + reply.readUInt8(3) * 2);
}
/**
 * Parse a Get_Attribute_All reply from the Identity object: attributes 1-7 in order, then
 * State (8) when the device includes it.
 */
function parseIdentityAll(data) {
    if (data.length < 15)
        return null;
    const nameLen = data.readUInt8(14);
    if (data.length < 15 + nameLen)
        return null;
    const identity = {
        vendorId: data.readUInt16LE(0),
        deviceType: data.readUInt16LE(2),
        productCode: data.readUInt16LE(4),
        major: data.readUInt8(6),
        minor: data.readUInt8(7),
        status: data.readUInt16LE(8),
        serial: data.readUInt32LE(10),
        name: data.subarray(15, 15 + nameLen).toString("latin1"),
    };
    if (data.length > 15 + nameLen)
        identity.state = data.readUInt8(15 + nameLen);
    return identity;
}
/**
 * Read the Identity object through the endpoint. st-ethernet-ip reads it on connect, but
 * not on a Micro800: it skips the read there, and would time out anyway, because the
 * Micro800 answers with service 0xD2 instead of 0x81. Get_Attribute_All first, then one
 * Get_Attribute_Single per attribute for a device that refuses it. An attribute the
 * device refuses is left out.
 */
async function readIdentity(endpoint) {
    if (typeof endpoint.request !== "function")
        return {};
    // Get_Attribute_All, path: class 0x01, instance 1
    const all = replyData(await endpoint.request(Buffer.from([0x01, 0x02, 0x20, 0x01, 0x24, 0x01])));
    const parsed = all && parseIdentityAll(all);
    if (parsed)
        return parsed;
    const identity = {};
    // Get_Attribute_Single, path: class 0x01, instance 1, attribute id
    const attr = async (id) => replyData(await endpoint.request(Buffer.from([0x0e, 0x03, 0x20, 0x01, 0x24, 0x01, 0x30, id])));
    const vendor = await attr(1);
    if (vendor && vendor.length >= 2)
        identity.vendorId = vendor.readUInt16LE(0);
    const deviceType = await attr(2);
    if (deviceType && deviceType.length >= 2)
        identity.deviceType = deviceType.readUInt16LE(0);
    const productCode = await attr(3);
    if (productCode && productCode.length >= 2)
        identity.productCode = productCode.readUInt16LE(0);
    const revision = await attr(4);
    if (revision && revision.length >= 2) {
        identity.major = revision.readUInt8(0);
        identity.minor = revision.readUInt8(1);
    }
    const status = await attr(5);
    if (status && status.length >= 2)
        identity.status = status.readUInt16LE(0);
    const serial = await attr(6);
    if (serial && serial.length >= 4)
        identity.serial = serial.readUInt32LE(0);
    const name = await attr(7);
    if (name && name.length >= 1) {
        identity.name = name.subarray(1, 1 + name.readUInt8(0)).toString("latin1");
    }
    const state = await attr(8);
    if (state && state.length >= 1)
        identity.state = state.readUInt8(0);
    return identity;
}
module.exports = function (RED) {
    function CipControllerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.pollInterval = parseInt(config.pollInterval, 10) || 0;
        node._pollTimer = null;
        node._reading = false;
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
            stopPolling();
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
         * Read controller properties and send as output message.
         */
        async function readControllerInfo(triggerMsg, use) {
            // The endpoint for this message alone. Polling passes none and uses the node's own.
            const endpoint = use || node.endpoint;
            if (node._reading)
                return; // backpressure
            if (!endpoint || !endpoint.connected) {
                node.status(utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
                return;
            }
            node._reading = true;
            try {
                const controller = endpoint.getController();
                if (!controller) {
                    node.status(utils_1.STATUS.error("no controller"));
                    return;
                }
                // Read the Identity object now, so the status is current. If the controller
                // answers none of it, fall back to what st-ethernet-ip read on connect, which it
                // keeps in controller.properties (state.controller). A Micro800 connection skips
                // that read, and it only fills in name, serial, version and status.
                const identity = await readIdentity(endpoint);
                const props = controller.properties || controller.state?.controller || {};
                const name = identity.name || props.name || "Unknown";
                const serialRaw = identity.serial ?? props.serial_number ?? 0;
                const serial = typeof serialRaw === "number"
                    ? serialRaw.toString(16).toUpperCase().padStart(8, "0")
                    : String(serialRaw);
                let firmware;
                if (identity.major !== undefined) {
                    firmware = { major: identity.major, minor: identity.minor ?? 0 };
                }
                else {
                    const parts = String(props.version || "").split(".");
                    firmware = { major: parseInt(parts[0], 10) || 0, minor: parseInt(parts[1], 10) || 0 };
                }
                const vendorId = identity.vendorId ?? 0;
                const deviceType = identity.deviceType ?? 0;
                const productCode = identity.productCode ?? 0;
                const statusWord = identity.status ?? props.status ?? 0;
                const controllerStatus = parseControllerStatus(statusWord, identity.state);
                const keyswitch = parseKeyswitch(statusWord);
                // controller.tagList is the array; state.tagList is the TagList holding it.
                const tagList = controller.tagList || controller.state?.tagList?.tags || [];
                const tagCount = Array.isArray(tagList) ? tagList.length : 0;
                // Wall clock time (if supported)
                let wallClock = null;
                try {
                    if (typeof endpoint.readWallClock === "function") {
                        wallClock = await endpoint.readWallClock();
                    }
                }
                catch (_e) {
                    // Not all controllers support wall clock
                }
                // Connection metrics
                const metrics = endpoint.metrics || {
                    connected: endpoint.connected,
                    connectTime: null,
                    lastResponseTime: 0,
                    avgResponseTime: 0,
                    errorCount: 0,
                    reconnectCount: 0,
                    totalReads: 0,
                    totalWrites: 0,
                };
                const payload = {
                    name,
                    serial,
                    firmware,
                    vendorId,
                    deviceType,
                    productCode,
                    status: controllerStatus,
                    keyswitch,
                    tagCount,
                };
                if (wallClock) {
                    payload.time = wallClock;
                }
                // Set node status based on controller mode
                if (controllerStatus.faulted || controllerStatus.majorFault) {
                    node.status({ fill: "red", shape: "dot", text: "Faulted" });
                }
                else if (controllerStatus.runMode === "run") {
                    node.status({ fill: "green", shape: "dot", text: "Run" });
                }
                else if (controllerStatus.runMode === "program") {
                    node.status({ fill: "yellow", shape: "dot", text: "Program" });
                }
                else {
                    node.status({ fill: "grey", shape: "dot", text: name });
                }
                const outMsg = {
                    payload,
                    metrics: {
                        responseTime: metrics.lastResponseTime,
                        errorCount: metrics.errorCount,
                        reconnectCount: metrics.reconnectCount,
                        totalReads: metrics.totalReads,
                        totalWrites: metrics.totalWrites,
                    },
                    timestamp: Date.now(),
                };
                if (triggerMsg) {
                    outMsg._msgid = triggerMsg._msgid;
                    outMsg.topic = triggerMsg.topic;
                }
                node.send((0, endpoint_dynamic_1.stampEndpoint)(outMsg, endpoint));
            }
            catch (err) {
                node.status(utils_1.STATUS.error((0, utils_1.describeCipError)(err)));
                node.error((0, utils_1.toCipError)(err, "Controller info read failed"), triggerMsg || {});
            }
            finally {
                node._reading = false;
            }
        }
        /**
         * Handle msg.command. getProps and getStatus are plain reads.
         *
         * run/program/test and reset used to send requests that cannot do what they say: the
         * mode change wrote the Identity object's Status word (attribute 5, get-only), and
         * the "fault reset" was the Identity Reset service, which restarts the device. Logix
         * has no documented CIP request for either, so they now fail with a clear reason.
         */
        async function handleCommand(command, msg, use) {
            const cmd = command.toLowerCase().trim();
            const endpoint = use || node.endpoint;
            try {
                switch (cmd) {
                    case "getprops":
                    case "getstatus":
                        break;
                    case "run":
                    case "program":
                    case "test":
                        throw new Error("Changing the controller mode over CIP is not supported. " +
                            "Use the keyswitch or Studio 5000.");
                    case "reset":
                        throw new Error("Fault reset over CIP is not supported. The only CIP reset is a device " +
                            "restart, which this node does not send.");
                    default:
                        node.warn(`Unknown command: ${cmd}`);
                        return;
                }
                await readControllerInfo(msg, endpoint);
            }
            catch (err) {
                node.status(utils_1.STATUS.error((0, utils_1.describeCipError)(err)));
                node.error((0, utils_1.toCipError)(err, `Command "${cmd}" failed`), msg);
            }
        }
        // -- Polling --
        function startPolling() {
            stopPolling();
            if (node.pollInterval > 0) {
                // Initial read on connect
                readControllerInfo();
                node._pollTimer = setInterval(() => readControllerInfo(), node.pollInterval);
            }
        }
        function stopPolling() {
            if (node._pollTimer) {
                clearInterval(node._pollTimer);
                node._pollTimer = null;
            }
        }
        // -- Connection lifecycle events --
        node.on("cip:connected", function () {
            node.status(utils_1.STATUS.connected((0, endpoint_dynamic_1.endpointLabel)(node)));
            startPolling();
        });
        node.on("cip:connecting", function () {
            node.status(utils_1.STATUS.connecting((0, endpoint_dynamic_1.endpointLabel)(node)));
            stopPolling();
        });
        node.on("cip:error", function () {
            node.status(utils_1.STATUS.error("connection error"));
            stopPolling();
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
            stopPolling();
        });
        // -- Input handling --
        node.on("input", function (msg, send, done) {
            // msg.command (getProps/getStatus) is this node's own vocabulary and is
            // unrelated to msg.action, which controls the connection.
            // A bare msg.endpoint names the endpoint for this message only and leaves the node
            // bound where it was, so ctx is captured before any await.
            const ctx = { endpoint: node.endpoint };
            if ((0, endpoint_dynamic_1.handleEndpointMsg)(RED, node, msg, send, done, DYN, ctx))
                return;
            const endpoint = ctx.endpoint;
            (0, endpoint_dynamic_1.ensureConnected)(node, endpoint)
                .then(() => {
                if (msg.command) {
                    handleCommand(msg.command, msg, endpoint);
                    return;
                }
                readControllerInfo(msg, endpoint);
            })
                .catch((err) => {
                node.status(utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
                const error = (0, utils_1.toCipError)(err);
                done ? done(error) : node.error(error, msg);
            });
        });
        // Register with endpoint
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
    RED.nodes.registerType("cip-controller", CipControllerNode);
};
//# sourceMappingURL=cip-controller.js.map