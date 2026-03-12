"use strict";
/**
 * CIP Subscribe node -- continuously scans tag values from an Allen-Bradley PLC.
 * Uses st-ethernet-ip's readTagGroup() for efficient cyclic multi-tag reads via
 * Multiple Service Packet (0x0A).
 * Supports report-by-exception (deadband filtering) and runtime reconfiguration.
 * @module cip-subscribe
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("./utils");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Tag, TagGroup } = require("st-ethernet-ip");
module.exports = function (RED) {
    function CipSubscribeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.endpoint = RED.nodes.getNode(config.endpoint);
        node.scanRate = parseInt(config.scanRate, 10) || 1000;
        node.deadband = parseFloat(config.deadband) || 0;
        node.diffOnly = config.diffOnly === true || config.diffOnly === "true";
        node._tagStates = [];
        node._scanning = false;
        node._scanTimer = null;
        node._inFlight = false;
        node._tagGroup = null;
        node._configuredTags = config.tags || "";
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        /**
         * Parse tag names from config string or msg override.
         */
        function resolveTagNames(input) {
            const raw = input || node._configuredTags;
            return (0, utils_1.parseTagList)(raw);
        }
        /**
         * Build Tag objects and add to a TagGroup for multi-tag reads.
         */
        function setupTags(tagNames) {
            teardownTags();
            const controller = node.endpoint.getController();
            if (!controller)
                return;
            const group = new TagGroup();
            const states = [];
            for (const name of tagNames) {
                try {
                    const tag = new Tag(name);
                    group.add(tag);
                    states.push({
                        name,
                        tag,
                        lastValue: undefined,
                        changed: false,
                    });
                }
                catch (err) {
                    node.warn(`Failed to add tag "${name}": ${err.message}`);
                }
            }
            node._tagStates = states;
            node._tagGroup = group;
        }
        /**
         * Remove all tag subscriptions.
         */
        function teardownTags() {
            node._tagStates = [];
            node._tagGroup = null;
        }
        /**
         * Start the scan cycle using readTagGroup() directly.
         * We avoid controller.scan() because it runs an internal while-loop
         * that conflicts with our own setInterval timing.
         */
        function startScan() {
            stopScan();
            const controller = node.endpoint.getController();
            if (!controller || node._tagStates.length === 0 || !node._tagGroup)
                return;
            node._scanning = true;
            node._inFlight = false;
            const runCycle = async () => {
                if (!node._scanning || node._inFlight)
                    return;
                node._inFlight = true;
                try {
                    await controller.readTagGroup(node._tagGroup);
                    if (node._scanning) {
                        processScanResults();
                    }
                }
                catch (err) {
                    node.log(`Scan error: ${err.message}`);
                }
                finally {
                    node._inFlight = false;
                }
            };
            // Delay the first scan cycle briefly after connection to let the CIP
            // session fully settle (avoids 1-2 TIMEOUT errors on startup).
            node._scanTimer = setTimeout(() => {
                runCycle();
                if (node._scanning) {
                    node._scanTimer = setInterval(runCycle, node.scanRate);
                }
            }, 500);
            updateStatus();
        }
        /**
         * Stop the scan cycle.
         */
        function stopScan() {
            node._scanning = false;
            if (node._scanTimer) {
                clearTimeout(node._scanTimer);
                clearInterval(node._scanTimer);
                node._scanTimer = null;
            }
        }
        /**
         * Check tag values after a scan cycle, apply deadband, emit message.
         */
        function processScanResults() {
            const states = node._tagStates;
            if (states.length === 0)
                return;
            let anyChanged = false;
            const tagDetails = [];
            for (const s of states) {
                const currentValue = s.tag.value;
                const typeName = (0, utils_1.cipTypeName)(s.tag.type || 0);
                let changed = false;
                if (s.lastValue === undefined) {
                    // First read is always "changed"
                    changed = true;
                }
                else if (typeof currentValue === "number" && typeof s.lastValue === "number") {
                    changed = Math.abs(currentValue - s.lastValue) > node.deadband;
                }
                else {
                    changed = currentValue !== s.lastValue;
                }
                s.changed = changed;
                if (changed) {
                    s.lastValue = currentValue;
                    anyChanged = true;
                }
                tagDetails.push({
                    name: s.name,
                    value: currentValue,
                    type: typeName,
                    changed,
                });
            }
            // If diffOnly and nothing changed, skip output
            if (node.diffOnly && !anyChanged)
                return;
            const now = Date.now();
            if (states.length === 1) {
                // Single tag mode: payload = value directly
                const t = tagDetails[0];
                if (node.diffOnly && !t.changed)
                    return;
                const msg = {
                    payload: t.value,
                    tagName: t.name,
                    dataType: t.type,
                    changed: t.changed,
                    tags: tagDetails,
                    scanRate: node.scanRate,
                    timestamp: now,
                };
                node.send(msg);
            }
            else {
                // Multi-tag mode: payload = object
                const payload = {};
                for (const t of tagDetails) {
                    payload[t.name] = t.value;
                }
                const msg = {
                    payload,
                    tags: node.diffOnly
                        ? tagDetails.filter((t) => t.changed)
                        : tagDetails,
                    scanRate: node.scanRate,
                    timestamp: now,
                };
                node.send(msg);
            }
            updateStatus();
        }
        /**
         * Update node status display.
         */
        function updateStatus() {
            if (!node._scanning || node._tagStates.length === 0) {
                node.status(utils_1.STATUS.idle());
                return;
            }
            node.status({
                fill: "green",
                shape: "dot",
                text: `scanning ${node._tagStates.length} tags @ ${node.scanRate}ms`,
            });
        }
        // -- Connection lifecycle events --
        node.on("cip:connected", function () {
            const tagNames = resolveTagNames();
            if (tagNames.length === 0) {
                node.status({ fill: "yellow", shape: "ring", text: "no tags configured" });
                return;
            }
            setupTags(tagNames);
            startScan();
        });
        node.on("cip:connecting", function () {
            node.status(utils_1.STATUS.connecting());
            stopScan();
        });
        node.on("cip:error", function () {
            node.status(utils_1.STATUS.error("connection error"));
            stopScan();
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected());
            stopScan();
        });
        // -- Runtime input for reconfiguration --
        node.on("input", function (msg) {
            // Runtime override: change tag list
            if (msg.tags !== undefined) {
                const newTags = typeof msg.tags === "string"
                    ? (0, utils_1.parseTagList)(msg.tags)
                    : Array.isArray(msg.tags)
                        ? msg.tags.map((t) => String(typeof t === "object" ? t.name : t).trim()).filter(Boolean)
                        : [];
                if (newTags.length > 0) {
                    node._configuredTags = newTags.join(",");
                    if (node.endpoint.connected) {
                        stopScan();
                        setupTags(newTags);
                        startScan();
                    }
                }
            }
            // Runtime override: change scan rate
            if (msg.scanRate !== undefined) {
                const newRate = parseInt(msg.scanRate, 10);
                if (newRate > 0) {
                    node.scanRate = newRate;
                    if (node._scanning) {
                        stopScan();
                        startScan();
                    }
                }
            }
        });
        // Register with endpoint
        node.endpoint.register(node);
        node.on("close", function (done) {
            stopScan();
            teardownTags();
            if (node.endpoint) {
                node.endpoint.deregister(node);
            }
            done();
        });
    }
    RED.nodes.registerType("cip-subscribe", CipSubscribeNode);
};
//# sourceMappingURL=cip-subscribe.js.map