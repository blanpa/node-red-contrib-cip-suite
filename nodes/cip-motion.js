"use strict";
/**
 * CIP Motion node — motion control via CIP Motion profile (ODVA Volume 9).
 *
 * Provides explicit-messaging access to:
 * - Motion Axis Object (class 0x42)
 * - Motion Group Object (class 0x41)
 * - Motion commands: Jog, Move, Home, Stop, ChangeSpeed
 * - Axis status monitoring with polling
 *
 * Note: CIP Motion's real-time cyclic data requires dedicated hardware (Sercos/CIP).
 * This node uses explicit messaging for command/status, suitable for
 * supervisory control and HMI integration.
 *
 * @module cip-motion
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("./utils");
const MOTION_AXIS_CLASS = 0x42;
const MOTION_GROUP_CLASS = 0x41;
// CIP Motion Axis Object attributes
const AXIS_ATTR = {
    AXIS_STATE: 1,
    COMMAND_POSITION: 3,
    COMMAND_VELOCITY: 4,
    ACTUAL_POSITION: 5,
    ACTUAL_VELOCITY: 6,
    ACTUAL_ACCELERATION: 7,
    COMMANDED_TORQUE: 8,
    ACTUAL_TORQUE: 9,
    AXIS_FAULT: 10,
    POSITION_ERROR: 11,
    MOTOR_TYPE: 12,
    FEEDBACK_TYPE: 13,
    COUNTS_PER_REV: 14,
    MAX_SPEED: 20,
    MAX_ACCEL: 21,
    MAX_DECEL: 22,
    MAX_TORQUE: 23,
    POSITION_UNITS: 30,
    VELOCITY_UNITS: 31,
    HOMING_MODE: 40,
    HOMING_SPEED: 41,
    HOME_POSITION: 42,
    GEAR_RATIO_INPUT: 50,
    GEAR_RATIO_OUTPUT: 51,
};
// Motion command service codes (via Set_Attribute_Single or dedicated services)
const MOTION_CMD = {
    JOG: 1,
    MOVE_ABSOLUTE: 2,
    MOVE_RELATIVE: 3,
    HOME: 4,
    STOP: 5,
    CHANGE_SPEED: 6,
    GEAR: 7,
    RESET_FAULT: 8,
    ENABLE: 9,
    DISABLE: 10,
};
const AXIS_STATE_NAMES = {
    0: "Idle/Not Ready",
    1: "Standstill",
    2: "Homing",
    3: "Discrete Motion",
    4: "Continuous Motion",
    5: "Synchronized Motion",
    6: "Stopping",
    7: "Error/Fault",
};
module.exports = function (RED) {
    function CipMotionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node._axisInstance = parseInt(config.axisInstance, 10) || 1;
        node._groupInstance = parseInt(config.groupInstance, 10) || 1;
        node._pollInterval = parseInt(config.pollInterval, 10) || 0;
        node._pollTimer = null;
        node._busy = false;
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        function buildCIPPath(classId, instance, attribute) {
            const parts = [0x20, classId, 0x24, instance];
            if (attribute !== undefined) {
                parts.push(0x30, attribute);
            }
            return Buffer.from(parts);
        }
        function buildRequest(service, path, data) {
            const d = data || Buffer.alloc(0);
            const req = Buffer.alloc(2 + path.length + d.length);
            req.writeUInt8(service, 0);
            req.writeUInt8(path.length / 2, 1);
            path.copy(req, 2);
            if (d.length > 0)
                d.copy(req, 2 + path.length);
            return req;
        }
        async function sendRequest(req) {
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
         * Read axis status (all relevant attributes).
         */
        async function readAxisStatus() {
            const result = {
                axisInstance: node._axisInstance,
                timestamp: Date.now(),
            };
            // Read key attributes
            const attrs = [
                { attr: AXIS_ATTR.AXIS_STATE, name: "axisState", parser: (d) => d.readUInt8(0) },
                { attr: AXIS_ATTR.ACTUAL_POSITION, name: "actualPosition", parser: (d) => d.readFloatLE(0) },
                { attr: AXIS_ATTR.ACTUAL_VELOCITY, name: "actualVelocity", parser: (d) => d.readFloatLE(0) },
                { attr: AXIS_ATTR.COMMAND_POSITION, name: "commandPosition", parser: (d) => d.readFloatLE(0) },
                { attr: AXIS_ATTR.COMMAND_VELOCITY, name: "commandVelocity", parser: (d) => d.readFloatLE(0) },
                { attr: AXIS_ATTR.ACTUAL_TORQUE, name: "actualTorque", parser: (d) => d.readFloatLE(0) },
                { attr: AXIS_ATTR.POSITION_ERROR, name: "positionError", parser: (d) => d.readFloatLE(0) },
                { attr: AXIS_ATTR.AXIS_FAULT, name: "axisFault", parser: (d) => d.readUInt32LE(0) },
            ];
            for (const a of attrs) {
                try {
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, a.attr);
                    const req = buildRequest(0x0e, path);
                    const { status, data } = await sendRequest(req);
                    if (status === 0 && data.length >= 4) {
                        result[a.name] = a.parser(data);
                    }
                    else if (status === 0 && data.length >= 1) {
                        result[a.name] = a.parser(data);
                    }
                }
                catch (_) {
                    result[a.name] = null;
                }
            }
            // Add human-readable state
            if (result.axisState !== null && result.axisState !== undefined) {
                result.axisStateText = AXIS_STATE_NAMES[result.axisState] || `Unknown (${result.axisState})`;
            }
            result.success = true;
            return result;
        }
        /**
         * Execute a motion command.
         * Uses tag writes or SetAttributeSingle depending on the command.
         */
        async function executeMotionCommand(cmd, params) {
            const result = { command: cmd, axisInstance: node._axisInstance, timestamp: Date.now() };
            switch (cmd) {
                case "jog": {
                    // Jog: set velocity via command velocity attribute
                    const velocity = Number(params.velocity || params.speed || 10);
                    const direction = params.direction === "reverse" ? -1 : 1;
                    const data = Buffer.alloc(4);
                    data.writeFloatLE(velocity * direction, 0);
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.COMMAND_VELOCITY);
                    const req = buildRequest(0x10, path, data); // SetAttributeSingle
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    result.velocity = velocity * direction;
                    break;
                }
                case "moveAbsolute": {
                    const position = Number(params.position || 0);
                    const speed = Number(params.speed || 100);
                    // Set command velocity FIRST to prevent motion at stale speed
                    const velData = Buffer.alloc(4);
                    velData.writeFloatLE(speed, 0);
                    const velPath = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.COMMAND_VELOCITY);
                    await sendRequest(buildRequest(0x10, velPath, velData));
                    // Then set command position (this triggers the move)
                    const posData = Buffer.alloc(4);
                    posData.writeFloatLE(position, 0);
                    const posPath = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.COMMAND_POSITION);
                    const posResp = await sendRequest(buildRequest(0x10, posPath, posData));
                    result.success = posResp.status === 0;
                    result.targetPosition = position;
                    result.speed = speed;
                    break;
                }
                case "moveRelative": {
                    const distance = Number(params.distance || 0);
                    const speed = Number(params.speed || 100);
                    // Read current position first
                    const curPath = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.ACTUAL_POSITION);
                    const curReq = buildRequest(0x0e, curPath);
                    const curResp = await sendRequest(curReq);
                    let currentPos = 0;
                    if (curResp.status === 0 && curResp.data.length >= 4) {
                        currentPos = curResp.data.readFloatLE(0);
                    }
                    // Set target = current + distance
                    const posData = Buffer.alloc(4);
                    posData.writeFloatLE(currentPos + distance, 0);
                    const posPath = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.COMMAND_POSITION);
                    const posReq = buildRequest(0x10, posPath, posData);
                    const resp = await sendRequest(posReq);
                    result.success = resp.status === 0;
                    result.currentPosition = currentPos;
                    result.targetPosition = currentPos + distance;
                    result.distance = distance;
                    break;
                }
                case "home": {
                    // Initiate homing sequence
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.HOMING_MODE);
                    const data = Buffer.alloc(1);
                    data.writeUInt8(params.mode || 1, 0); // Homing mode
                    const req = buildRequest(0x10, path, data);
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    result.homingMode = params.mode || 1;
                    break;
                }
                case "stop": {
                    // Emergency stop: set command velocity to 0
                    const data = Buffer.alloc(4);
                    data.writeFloatLE(0, 0);
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.COMMAND_VELOCITY);
                    const req = buildRequest(0x10, path, data);
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    break;
                }
                case "enable": {
                    // Start service on axis
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance);
                    const req = buildRequest(0x06, path); // Start service
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    break;
                }
                case "disable": {
                    // Stop service on axis
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance);
                    const req = buildRequest(0x07, path); // Stop service
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    break;
                }
                case "resetFault": {
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance);
                    const req = buildRequest(0x05, path); // Reset service
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    break;
                }
                case "changeSpeed": {
                    const speed = Number(params.speed || 0);
                    const data = Buffer.alloc(4);
                    data.writeFloatLE(speed, 0);
                    const path = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.COMMAND_VELOCITY);
                    const req = buildRequest(0x10, path, data);
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    result.speed = speed;
                    break;
                }
                case "setGearRatio": {
                    const input = Number(params.input || 1);
                    const output = Number(params.output || 1);
                    // Set gear ratio input
                    const inData = Buffer.alloc(4);
                    inData.writeFloatLE(input, 0);
                    const inPath = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.GEAR_RATIO_INPUT);
                    await sendRequest(buildRequest(0x10, inPath, inData));
                    // Set gear ratio output
                    const outData = Buffer.alloc(4);
                    outData.writeFloatLE(output, 0);
                    const outPath = buildCIPPath(MOTION_AXIS_CLASS, node._axisInstance, AXIS_ATTR.GEAR_RATIO_OUTPUT);
                    const resp = await sendRequest(buildRequest(0x10, outPath, outData));
                    result.success = resp.status === 0;
                    result.gearRatio = { input, output, ratio: input / output };
                    break;
                }
                case "getGroup": {
                    // Read Motion Group status
                    const path = buildCIPPath(MOTION_GROUP_CLASS, node._groupInstance);
                    const req = buildRequest(0x01, path); // GetAttributeAll
                    const resp = await sendRequest(req);
                    result.success = resp.status === 0;
                    result.groupData = resp.data;
                    break;
                }
                default:
                    result.success = false;
                    result.error = `Unknown command: ${cmd}. Use: jog, moveAbsolute, moveRelative, home, stop, enable, disable, resetFault, changeSpeed, setGearRatio, getGroup`;
            }
            return result;
        }
        // Connection lifecycle
        node.on("cip:connected", function () {
            node.status(utils_1.STATUS.connected());
            if (node._pollInterval > 0) {
                node._pollTimer = setInterval(() => {
                    if (!node._busy)
                        doStatusPoll();
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
        async function doStatusPoll() {
            if (!node.endpoint.connected || node._busy)
                return;
            node._busy = true;
            try {
                const status = await readAxisStatus();
                const stateText = AXIS_STATE_NAMES[status.axisState] || "?";
                node.status({ fill: "green", shape: "dot", text: `${stateText} P=${status.actualPosition?.toFixed(1) || "?"}` });
                node.send({ payload: status });
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
            node.status({ fill: "yellow", shape: "dot", text: "processing..." });
            try {
                const command = msg.command || msg.topic || "status";
                if (command === "status") {
                    const { result, elapsed } = await (0, utils_1.withTiming)(() => readAxisStatus());
                    result.elapsed = elapsed;
                    msg.payload = result;
                }
                else {
                    const { result, elapsed } = await (0, utils_1.withTiming)(() => executeMotionCommand(command, msg.payload || {}));
                    result.elapsed = elapsed;
                    msg.payload = result;
                }
                const cmdText = msg.payload.success ? command : `${command} FAIL`;
                node.status({ fill: msg.payload.success ? "green" : "red", shape: "dot", text: cmdText });
                node.send(msg);
            }
            catch (err) {
                msg.payload = { success: false, error: err.message };
                node.error(`Motion error: ${err.message}`, msg);
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
    RED.nodes.registerType("cip-motion", CipMotionNode);
};
//# sourceMappingURL=cip-motion.js.map