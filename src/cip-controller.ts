/**
 * CIP Controller node -- reads and outputs PLC controller properties and status.
 * Supports periodic polling and trigger-based reads.
 * Can issue runtime commands (run/program/test/reset).
 * @module cip-controller
 */

import {
  CipControllerConfig,
  CipEndpointNode,
  ConnectionMetrics,
  NodeStatus,
} from "./types";
import { STATUS } from "./utils";

/** Controller run mode status bit masks (CIP Identity Object, Attribute 5). */
const RUN_MODE_MAP: Record<number, string> = {
  0x0000: "unknown",
  0x0010: "run",
  0x0020: "program",
  0x0030: "test",
};

/** Keyswitch positions. */
const KEYSWITCH_MAP: Record<number, string> = {
  0x0000: "unknown",
  0x0001: "remote",
  0x0002: "run",
  0x0003: "program",
};

interface ControllerStatus {
  runMode: string;
  faulted: boolean;
  ioFault: boolean;
  majorFault: boolean;
  minorFault: boolean;
}

/**
 * Parse the numeric controller status word into structured fields.
 * The status word format (Logix5000):
 *   Bits 4-5: run mode (00=unknown, 01=run, 10=program, 11=test)
 *   Bit 2: major fault
 *   Bit 3: minor fault
 *   Bit 8: I/O fault
 *   Bit 1: faulted
 */
function parseControllerStatus(statusWord: number): ControllerStatus {
  const runModeField = statusWord & 0x0030;
  return {
    runMode: RUN_MODE_MAP[runModeField] || "unknown",
    faulted: (statusWord & 0x0002) !== 0,
    majorFault: (statusWord & 0x0004) !== 0,
    minorFault: (statusWord & 0x0008) !== 0,
    ioFault: (statusWord & 0x0100) !== 0,
  };
}

/**
 * Try to extract a value from multiple possible property paths.
 */
function tryGet(obj: any, ...paths: string[]): any {
  for (const path of paths) {
    const parts = path.split(".");
    let current = obj;
    for (const p of parts) {
      if (current == null) break;
      current = current[p];
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
}

module.exports = function (RED: any) {
  function CipControllerNode(this: any, config: CipControllerConfig & { id: string; name: string }) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint) as CipEndpointNode | null;
    node.pollInterval = parseInt(config.pollInterval as any, 10) || 0;
    node._pollTimer = null as ReturnType<typeof setInterval> | null;
    node._reading = false;

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" } as NodeStatus);
      return;
    }

    /**
     * Read controller properties and send as output message.
     */
    async function readControllerInfo(triggerMsg?: any): Promise<void> {
      if (node._reading) return; // backpressure
      if (!node.endpoint.connected) {
        node.status(STATUS.disconnected());
        return;
      }

      node._reading = true;
      try {
        const controller = node.endpoint.getController();
        if (!controller) {
          node.status(STATUS.error("no controller"));
          return;
        }

        // Gather properties from controller.state / controller.properties
        const state = controller.state || controller.properties || {};
        const stateKeys = Object.keys(state);
        node.debug(`Controller state keys: ${stateKeys.join(", ")}`);

        const name: string = tryGet(state, "name", "productName", "product_name") ||
          tryGet(controller, "state.name", "properties.name") || "Unknown";

        const serialRaw = tryGet(state, "serial_number", "serialNumber", "serial") ||
          tryGet(controller, "state.serial_number") || 0;
        const serial: string = typeof serialRaw === "number"
          ? serialRaw.toString(16).toUpperCase().padStart(8, "0")
          : String(serialRaw);

        const versionRaw = tryGet(state, "version", "revision", "major_rev");
        let firmware: { major: number; minor: number };
        if (typeof versionRaw === "string" && versionRaw.includes(".")) {
          const parts = versionRaw.split(".");
          firmware = { major: parseInt(parts[0], 10) || 0, minor: parseInt(parts[1], 10) || 0 };
        } else if (typeof versionRaw === "number") {
          const majorRev = tryGet(state, "major_rev", "majorRevision") || versionRaw;
          const minorRev = tryGet(state, "minor_rev", "minorRevision") || 0;
          firmware = { major: majorRev, minor: minorRev };
        } else {
          const majorRev = tryGet(state, "major_rev", "majorRevision") || 0;
          const minorRev = tryGet(state, "minor_rev", "minorRevision") || 0;
          firmware = { major: majorRev, minor: minorRev };
        }

        const vendorId: number = tryGet(state, "vendor_id", "vendorId") || 0;
        const deviceType: number = tryGet(state, "device_type", "deviceType") || 0;
        const productCode: number = tryGet(state, "product_code", "productCode") || 0;

        const statusWord: number = tryGet(state, "status", "controllerStatus") || 0;
        const controllerStatus = parseControllerStatus(statusWord);

        // If the controller explicitly exposes faulted, use that
        const explicitFaulted = tryGet(state, "faulted");
        if (explicitFaulted !== undefined) {
          controllerStatus.faulted = Boolean(explicitFaulted);
        }

        const keyswitchRaw = tryGet(state, "keyswitch", "keyswitchPosition", "keyswitch_position") || 0;
        const keyswitch: string = typeof keyswitchRaw === "string"
          ? keyswitchRaw
          : KEYSWITCH_MAP[keyswitchRaw] || "unknown";

        // Tag count from the controller's tag list
        const tagList = controller.state?.tagList || controller.tagList || [];
        const tagCount: number = Array.isArray(tagList) ? tagList.length : 0;

        // Wall clock time (if supported)
        let wallClock: Date | null = null;
        try {
          if (typeof node.endpoint.readWallClock === "function") {
            wallClock = await node.endpoint.readWallClock();
          }
        } catch (_e) {
          // Not all controllers support wall clock
        }

        // Connection metrics
        const metrics: ConnectionMetrics = node.endpoint.metrics || {
          connected: node.endpoint.connected,
          connectTime: null,
          lastResponseTime: 0,
          avgResponseTime: 0,
          errorCount: 0,
          reconnectCount: 0,
          totalReads: 0,
          totalWrites: 0,
        };

        const payload: any = {
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
          node.status({ fill: "red", shape: "dot", text: "Faulted" } as NodeStatus);
        } else if (controllerStatus.runMode === "run") {
          node.status({ fill: "green", shape: "dot", text: "Run" } as NodeStatus);
        } else if (controllerStatus.runMode === "program") {
          node.status({ fill: "yellow", shape: "dot", text: "Program" } as NodeStatus);
        } else if (controllerStatus.runMode === "test") {
          node.status({ fill: "blue", shape: "dot", text: "Test" } as NodeStatus);
        } else {
          node.status({ fill: "grey", shape: "dot", text: name } as NodeStatus);
        }

        const outMsg: any = {
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

        node.send(outMsg);
      } catch (err: any) {
        node.status(STATUS.error(err.message));
        node.error(`Controller info read failed: ${err.message}`, triggerMsg || {});
      } finally {
        node._reading = false;
      }
    }

    /**
     * Handle runtime commands (run, program, test, reset).
     */
    async function handleCommand(command: string, msg: any): Promise<void> {
      const cmd = command.toLowerCase().trim();
      try {
        switch (cmd) {
          case "run":
          case "program":
          case "test":
            if (typeof node.endpoint.changeMode === "function") {
              await node.endpoint.changeMode(cmd as "run" | "program" | "test");
              node.log(`Mode change to "${cmd}" requested`);
            } else {
              node.warn(`changeMode() not available on endpoint`);
            }
            break;
          case "reset":
            if (typeof node.endpoint.resetFault === "function") {
              await node.endpoint.resetFault();
              node.log("Fault reset requested");
            } else {
              node.warn(`resetFault() not available on endpoint`);
            }
            break;
          default:
            node.warn(`Unknown command: ${cmd}`);
            return;
        }
        // After command, re-read status
        await readControllerInfo(msg);
      } catch (err: any) {
        node.status(STATUS.error(err.message));
        node.error(`Command "${cmd}" failed: ${err.message}`, msg);
      }
    }

    // -- Polling --

    function startPolling(): void {
      stopPolling();
      if (node.pollInterval > 0) {
        // Initial read on connect
        readControllerInfo();
        node._pollTimer = setInterval(() => readControllerInfo(), node.pollInterval);
      }
    }

    function stopPolling(): void {
      if (node._pollTimer) {
        clearInterval(node._pollTimer);
        node._pollTimer = null;
      }
    }

    // -- Connection lifecycle events --

    node.on("cip:connected", function () {
      node.status(STATUS.connected());
      startPolling();
    });

    node.on("cip:connecting", function () {
      node.status(STATUS.connecting());
      stopPolling();
    });

    node.on("cip:error", function () {
      node.status(STATUS.error("connection error"));
      stopPolling();
    });

    node.on("cip:disconnected", function () {
      node.status(STATUS.disconnected());
      stopPolling();
    });

    // -- Input handling --

    node.on("input", function (msg: any) {
      // Handle runtime commands
      if (msg.command) {
        if (!node.endpoint.connected) {
          node.error("Not connected to PLC", msg);
          return;
        }
        handleCommand(msg.command, msg);
        return;
      }

      // Trigger-based read
      if (!node.endpoint.connected) {
        node.status(STATUS.disconnected());
        node.error("Not connected to PLC", msg);
        return;
      }
      readControllerInfo(msg);
    });

    // Register with endpoint
    node.endpoint.register(node);

    node.on("close", function (done: () => void) {
      stopPolling();
      if (node.endpoint) {
        node.endpoint.deregister(node);
      }
      done();
    });
  }

  RED.nodes.registerType("cip-controller", CipControllerNode);
};
