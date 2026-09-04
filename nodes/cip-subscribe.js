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
const endpoint_dynamic_1 = require("./endpoint-dynamic");
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
        // Bumped every time the scan stops. A cycle already awaiting the PLC carries the
        // generation it started under, so it can tell whether it still speaks for the node.
        node._scanGen = 0;
        node._inFlight = false;
        node._tagGroup = null;
        node._configuredTags = config.tags || "";
        if (!node.endpoint) {
            node.status({ fill: "red", shape: "ring", text: "no endpoint" });
            return;
        }
        // Reflect the endpoint's real state immediately. Without this a node whose endpoint
        // never fires a cip:* event (autoConnect off) shows whatever the editor last saw,
        // which after a restart is the previous run's status.
        (0, endpoint_dynamic_1.applyInitialStatus)(node);
        /**
         * Rebind to a different endpoint.
         *
         * The TagGroup is built against a specific controller's tag list, so it has to be torn
         * down and rebuilt rather than carried across.
         */
        function useEndpoint(endpoint) {
            if (endpoint === node.endpoint)
                return;
            stopScan();
            teardownTags();
            if (node.endpoint)
                node.endpoint.deregister(node);
            node.endpoint = endpoint;
            endpoint.register(node, { connect: false });
            if (endpoint.connected) {
                const tagNames = resolveTagNames();
                if (tagNames.length > 0) {
                    setupTags(tagNames);
                    startScan();
                }
            }
            else {
                node.status(endpoint.connecting
                    ? utils_1.STATUS.connecting((0, endpoint_dynamic_1.endpointLabel)(node))
                    : utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
            }
        }
        const DYN = {
            type: "cip-endpoint",
            switchTo: useEndpoint,
            // This node holds a scan loop rather than answering one message at a time, so there
            // is no single operation a bare msg.endpoint could be borrowed for. Naming one
            // without an action is rejected instead, pointing at "switch".
            borrowable: false,
            // Documented at nodes/cip-subscribe.html but never implemented until now.
            extraActions: {
                start: (_msg, _send, done) => {
                    const tagNames = resolveTagNames();
                    if (tagNames.length === 0) {
                        done(new Error("No tags configured"));
                        return;
                    }
                    if (!node._scanning) {
                        setupTags(tagNames);
                        startScan();
                    }
                    done();
                },
                stop: (_msg, _send, done) => {
                    stopScan();
                    node.status(utils_1.STATUS.idle());
                    done();
                },
                restart: (_msg, _send, done) => {
                    stopScan();
                    teardownTags();
                    const tagNames = resolveTagNames();
                    if (tagNames.length === 0) {
                        done(new Error("No tags configured"));
                        return;
                    }
                    setupTags(tagNames);
                    startScan();
                    done();
                },
            },
        };
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
            stopScan(); // bumps the generation, orphaning any cycle still in flight
            const endpoint = node.endpoint;
            const controller = endpoint && endpoint.getController();
            if (!controller || node._tagStates.length === 0 || !node._tagGroup)
                return;
            // Both are captured, not read back off the node: a switch replaces them while a
            // read is still outstanding against the controller this cycle started on.
            const gen = node._scanGen;
            const group = node._tagGroup;
            node._scanning = true;
            node._inFlight = false;
            const current = () => node._scanning && node._scanGen === gen;
            const runCycle = async () => {
                if (!current() || node._inFlight)
                    return;
                node._inFlight = true;
                try {
                    await controller.readTagGroup(group);
                    // Without this the values just read from the endpoint we have since left would
                    // be emitted as though they came from the one we switched to.
                    if (current()) {
                        processScanResults(endpoint);
                    }
                }
                catch (err) {
                    if (current())
                        node.log(`Scan error: ${err.message}`);
                }
                finally {
                    // A superseded cycle must not clear the flag out from under its replacement.
                    if (node._scanGen === gen)
                        node._inFlight = false;
                }
            };
            // Delay the first scan cycle briefly after connection to let the CIP
            // session fully settle (avoids 1-2 TIMEOUT errors on startup).
            node._scanTimer = setTimeout(() => {
                runCycle();
                if (current()) {
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
            // Retire the current generation. Clearing the timer stops future cycles, but one
            // already awaiting the PLC would otherwise come back and emit after the switch.
            node._scanGen++;
            if (node._scanTimer) {
                clearTimeout(node._scanTimer);
                clearInterval(node._scanTimer);
                node._scanTimer = null;
            }
        }
        /**
         * Check tag values after a scan cycle, apply deadband, emit message.
         */
        function processScanResults(endpoint) {
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
                node.send((0, endpoint_dynamic_1.stampEndpoint)(msg, endpoint));
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
                node.send((0, endpoint_dynamic_1.stampEndpoint)(msg, endpoint));
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
            node.status(utils_1.STATUS.connecting((0, endpoint_dynamic_1.endpointLabel)(node)));
            stopScan();
        });
        node.on("cip:error", function () {
            node.status(utils_1.STATUS.error("connection error"));
            stopScan();
        });
        node.on("cip:disconnected", function () {
            node.status(utils_1.STATUS.disconnected((0, endpoint_dynamic_1.endpointLabel)(node)));
            stopScan();
        });
        // -- Runtime input for reconfiguration --
        node.on("input", function (msg, send, done) {
            // msg.command is kept as a deprecated alias for the start/stop/restart actions the
            // help has always documented.
            if (msg.action === undefined && typeof msg.command === "string") {
                msg = { ...msg, action: msg.command };
            }
            if ((0, endpoint_dynamic_1.handleEndpointMsg)(RED, node, msg, send, done, DYN))
                return;
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
        if (node.endpoint)
            node.endpoint.register(node);
        node.on("close", function (removed, done) {
            stopScan();
            teardownTags();
            if (node.endpoint) {
                node.endpoint.deregister(node, done, removed);
                return;
            }
            done();
        });
    }
    RED.nodes.registerType("cip-subscribe", CipSubscribeNode);
};
//# sourceMappingURL=cip-subscribe.js.map