"use strict";
/**
 * CIP Energy node — energy management via CIP Energy Object (ODVA Volume 2, Chapter 4-15).
 *
 * Provides:
 * - Base Energy Object (class 0x4F) attribute access
 * - Electrical Energy Object (class 0x4E) for electrical measurements
 * - Non-Electrical Energy Object (class 0x50)
 * - Energy mode control (normal, saving, off, paused)
 * - Power/energy monitoring with polling
 *
 * @module cip-energy
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("./utils");
const ENERGY_BASE_CLASS = 0x4f;
const ELECTRICAL_ENERGY_CLASS = 0x4e;
const NON_ELECTRICAL_ENERGY_CLASS = 0x50;
// Base Energy Object attributes
const ENERGY_ATTR = {
    ENERGY_TYPE: 1,
    ENERGY_MODE: 2,
    ENERGY_MODE_TRANSITION_TIME: 3,
    ENERGY_ACCURACY: 4,
    ENERGY_ACCURACY_UNITS: 5,
    NOMINAL_POWER: 6,
    RATED_POWER: 7,
    POWER: 8,
    ENERGY: 9,
    PEAK_POWER: 10,
    PEAK_POWER_RESET: 11,
};
// Electrical Energy Object attributes
const ELEC_ATTR = {
    VOLTAGE_LL: 1, // Line-to-line voltage
    VOLTAGE_LN: 2, // Line-to-neutral voltage
    CURRENT: 3, // Phase current
    FREQUENCY: 4, // Line frequency
    POWER_FACTOR: 5, // Power factor
    APPARENT_POWER: 6, // VA
    REACTIVE_POWER: 7, // VAR
    ACTIVE_POWER: 8, // W
    ACTIVE_ENERGY: 9, // kWh
    REACTIVE_ENERGY: 10, // kVARh
    APPARENT_ENERGY: 11, // kVAh
    THD_VOLTAGE: 12, // Total harmonic distortion voltage %
    THD_CURRENT: 13, // Total harmonic distortion current %
};
const ENERGY_MODE_NAMES = {
    0: "Normal",
    1: "Energy Saving",
    2: "Energy Off",
    3: "Paused",
};
const ENERGY_TYPE_NAMES = {
    0: "Non-Specific",
    1: "Electrical AC",
    2: "Electrical DC",
    3: "Pneumatic",
    4: "Hydraulic",
    5: "Mechanical",
    6: "Thermal",
};
module.exports = function (RED) {
    function CipEnergyNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node._instance = parseInt(config.instance, 10) || 1;
        node._pollInterval = parseInt(config.pollInterval, 10) || 0;
        node._pollTimer = null;
        node._busy = false;
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        function buildPath(classId, instance, attribute) {
            const parts = [0x20, classId, 0x24, instance];
            if (attribute !== undefined)
                parts.push(0x30, attribute);
            return Buffer.from(parts);
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
         * Read a single attribute and return the parsed value.
         */
        async function readAttr(classId, instance, attr) {
            const path = buildPath(classId, instance, attr);
            const req = buildReq(0x0e, path); // GetAttributeSingle
            return sendReq(req);
        }
        /**
         * Read Base Energy Object status.
         */
        async function readEnergyStatus() {
            const result = { instance: node._instance, timestamp: Date.now() };
            // Energy Type
            try {
                const { status, data } = await readAttr(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.ENERGY_TYPE);
                if (status === 0 && data.length >= 1) {
                    result.energyType = data.readUInt8(0);
                    result.energyTypeText = ENERGY_TYPE_NAMES[result.energyType] || `Unknown (${result.energyType})`;
                }
            }
            catch (_) {
                result.energyType = null;
            }
            // Energy Mode
            try {
                const { status, data } = await readAttr(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.ENERGY_MODE);
                if (status === 0 && data.length >= 1) {
                    result.energyMode = data.readUInt8(0);
                    result.energyModeText = ENERGY_MODE_NAMES[result.energyMode] || `Unknown (${result.energyMode})`;
                }
            }
            catch (_) {
                result.energyMode = null;
            }
            // Power (REAL, watts)
            try {
                const { status, data } = await readAttr(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.POWER);
                if (status === 0 && data.length >= 4) {
                    result.power = data.readFloatLE(0);
                }
            }
            catch (_) {
                result.power = null;
            }
            // Energy (LREAL or REAL, kWh)
            try {
                const { status, data } = await readAttr(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.ENERGY);
                if (status === 0) {
                    if (data.length >= 8) {
                        result.energy = data.readDoubleLE(0);
                    }
                    else if (data.length >= 4) {
                        result.energy = data.readFloatLE(0);
                    }
                }
            }
            catch (_) {
                result.energy = null;
            }
            // Nominal Power
            try {
                const { status, data } = await readAttr(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.NOMINAL_POWER);
                if (status === 0 && data.length >= 4) {
                    result.nominalPower = data.readFloatLE(0);
                }
            }
            catch (_) {
                result.nominalPower = null;
            }
            // Peak Power
            try {
                const { status, data } = await readAttr(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.PEAK_POWER);
                if (status === 0 && data.length >= 4) {
                    result.peakPower = data.readFloatLE(0);
                }
            }
            catch (_) {
                result.peakPower = null;
            }
            result.success = true;
            return result;
        }
        /**
         * Read Electrical Energy Object.
         */
        async function readElectricalEnergy() {
            const result = { instance: node._instance, type: "electrical", timestamp: Date.now() };
            const attrs = [
                { attr: ELEC_ATTR.VOLTAGE_LL, name: "voltageLL", unit: "V" },
                { attr: ELEC_ATTR.VOLTAGE_LN, name: "voltageLN", unit: "V" },
                { attr: ELEC_ATTR.CURRENT, name: "current", unit: "A" },
                { attr: ELEC_ATTR.FREQUENCY, name: "frequency", unit: "Hz" },
                { attr: ELEC_ATTR.POWER_FACTOR, name: "powerFactor", unit: "" },
                { attr: ELEC_ATTR.APPARENT_POWER, name: "apparentPower", unit: "VA" },
                { attr: ELEC_ATTR.REACTIVE_POWER, name: "reactivePower", unit: "VAR" },
                { attr: ELEC_ATTR.ACTIVE_POWER, name: "activePower", unit: "W" },
                { attr: ELEC_ATTR.ACTIVE_ENERGY, name: "activeEnergy", unit: "kWh" },
                { attr: ELEC_ATTR.REACTIVE_ENERGY, name: "reactiveEnergy", unit: "kVARh" },
                { attr: ELEC_ATTR.THD_VOLTAGE, name: "thdVoltage", unit: "%" },
                { attr: ELEC_ATTR.THD_CURRENT, name: "thdCurrent", unit: "%" },
            ];
            for (const a of attrs) {
                try {
                    const { status, data } = await readAttr(ELECTRICAL_ENERGY_CLASS, node._instance, a.attr);
                    if (status === 0 && data.length >= 4) {
                        result[a.name] = { value: data.readFloatLE(0), unit: a.unit };
                    }
                }
                catch (_) {
                    result[a.name] = null;
                }
            }
            result.success = true;
            return result;
        }
        /**
         * Set energy mode.
         */
        async function setEnergyMode(mode) {
            const data = Buffer.alloc(1);
            data.writeUInt8(mode, 0);
            const path = buildPath(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.ENERGY_MODE);
            const req = buildReq(0x10, path, data); // SetAttributeSingle
            const resp = await sendReq(req);
            return {
                success: resp.status === 0,
                mode,
                modeText: ENERGY_MODE_NAMES[mode] || `Unknown (${mode})`,
                timestamp: Date.now(),
            };
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
                const { result, elapsed } = await (0, utils_1.withTiming)(() => readEnergyStatus());
                result.elapsed = elapsed;
                const powerText = typeof result.power === "number" ? `${result.power.toFixed(1)}W` : "?";
                node.status({ fill: "green", shape: "dot", text: `${powerText} (${elapsed}ms)` });
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
                        const { result, elapsed } = await (0, utils_1.withTiming)(() => readEnergyStatus());
                        result.elapsed = elapsed;
                        msg.payload = result;
                        break;
                    }
                    case "electrical": {
                        const { result, elapsed } = await (0, utils_1.withTiming)(() => readElectricalEnergy());
                        result.elapsed = elapsed;
                        msg.payload = result;
                        break;
                    }
                    case "setMode": {
                        const mode = Number(msg.payload?.mode ?? msg.payload ?? 0);
                        msg.payload = await setEnergyMode(mode);
                        break;
                    }
                    case "normal":
                        msg.payload = await setEnergyMode(0);
                        break;
                    case "saving":
                        msg.payload = await setEnergyMode(1);
                        break;
                    case "off":
                        msg.payload = await setEnergyMode(2);
                        break;
                    case "pause":
                        msg.payload = await setEnergyMode(3);
                        break;
                    case "resetPeak": {
                        const path = buildPath(ENERGY_BASE_CLASS, node._instance, ENERGY_ATTR.PEAK_POWER_RESET);
                        const data = Buffer.alloc(1);
                        data.writeUInt8(1, 0);
                        const req = buildReq(0x10, path, data);
                        const resp = await sendReq(req);
                        msg.payload = { success: resp.status === 0, command: "resetPeak", timestamp: Date.now() };
                        break;
                    }
                    default:
                        msg.payload = {
                            success: false,
                            error: `Unknown command: ${command}. Use: status, electrical, setMode, normal, saving, off, pause, resetPeak`,
                        };
                }
                node.status({ fill: "green", shape: "dot", text: command });
                node.send(msg);
            }
            catch (err) {
                msg.payload = { success: false, error: err.message };
                node.error(`Energy error: ${err.message}`, msg);
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
    RED.nodes.registerType("cip-energy", CipEnergyNode);
};
//# sourceMappingURL=cip-energy.js.map