/**
 * CIP Endpoint config node — manages a shared EtherNet/IP TCP session.
 * One instance per PLC address+slot combination.
 *
 * Enhancements over JS version:
 * - Connection metrics tracking
 * - readModifyWriteTag for atomic bit manipulation
 * - readWallClock / writeWallClock for controller time
 * - changeMode / resetFault for controller management
 * - Multi-hop routing support
 * - Metrics admin endpoint
 * @module cip-endpoint
 */

import {
  CipEndpointConfig,
  ConnectionMetrics,
  CIPService,
  CIPClass,
  CIP_TYPE_NAMES,
} from "./types";
import { withTiming, cipTypeName } from "./utils";

const { Controller } = require("st-ethernet-ip");

/** Controller run mode constants for Set_Attribute_Single (class 0x01, attr 5) */
const CONTROLLER_MODE: Record<string, number> = {
  run: 0x0001,
  program: 0x0000,
  test: 0x0002,
};

module.exports = function (RED: any) {
  function CipEndpointNode(this: any, config: CipEndpointConfig & { id: string; name: string }) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.address = config.address;
    node.port = parseInt(config.port, 10) || 44818;
    node.slot = parseInt(config.slot, 10) || 0;
    node.connTimeout = parseInt(config.connTimeout, 10) || 5000;
    node.retryInterval = parseInt(config.retryInterval, 10) || 5000;
    node.useMicro800 = config.useMicro800 || false;
    node.routingPath = config.routingPath || "";

    node.plc = null as any;
    node.connected = false;
    node.connecting = false;
    node._retryTimer = null as ReturnType<typeof setTimeout> | null;
    node._closing = false;
    node._users = new Set<any>();

    // Connection metrics
    node.metrics = {
      connected: false,
      connectTime: null,
      lastResponseTime: 0,
      avgResponseTime: 0,
      errorCount: 0,
      reconnectCount: 0,
      totalReads: 0,
      totalWrites: 0,
    } as ConnectionMetrics;

    let _responseTimes: number[] = [];

    function updateResponseTime(elapsed: number): void {
      _responseTimes.push(elapsed);
      if (_responseTimes.length > 100) {
        _responseTimes = _responseTimes.slice(-100);
      }
      node.metrics.lastResponseTime = elapsed;
      node.metrics.avgResponseTime =
        _responseTimes.reduce((a: number, b: number) => a + b, 0) / _responseTimes.length;
    }

    /**
     * Parse routingPath config string into a Buffer for multi-hop routing.
     * Format: "port/slot" pairs separated by "/", e.g. "1/0/2/192.168.1.1"
     * Each pair: port segment (0x01) + link address
     */
    function parseRoutingPath(pathStr: string): Buffer | null {
      if (!pathStr || !pathStr.trim()) return null;

      const parts = pathStr.trim().split("/");
      if (parts.length < 2 || parts.length % 2 !== 0) return null;

      const segments: Buffer[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const port = parseInt(parts[i], 10);
        const link = parts[i + 1];

        // Check if link is an IP address
        if (link.includes(".") && link.split(".").length === 4) {
          // Extended link address (IP)
          const ipBytes = link.split(".").map((b) => parseInt(b, 10));
          const seg = Buffer.alloc(2 + ipBytes.length);
          seg.writeUInt8(port | 0x10, 0); // extended flag
          seg.writeUInt8(ipBytes.length, 1);
          for (let j = 0; j < ipBytes.length; j++) {
            seg.writeUInt8(ipBytes[j], 2 + j);
          }
          // Pad to even length
          if (seg.length % 2 !== 0) {
            segments.push(Buffer.concat([seg, Buffer.alloc(1)]));
          } else {
            segments.push(seg);
          }
        } else {
          // Numeric slot
          const slot = parseInt(link, 10);
          const seg = Buffer.alloc(2);
          seg.writeUInt8(port, 0);
          seg.writeUInt8(slot, 1);
          segments.push(seg);
        }
      }

      return Buffer.concat(segments);
    }

    /**
     * Register a user node so it receives connection events.
     */
    node.register = function (userNode: any): void {
      node._users.add(userNode);
      if (node.connected) {
        userNode.emit("cip:connected");
      }
    };

    /**
     * Deregister a user node.
     */
    node.deregister = function (userNode: any): void {
      node._users.delete(userNode);
    };

    /**
     * Broadcast an event to all registered user nodes.
     */
    node._broadcast = function (event: string, data?: any): void {
      for (const u of node._users) {
        u.emit(event, data);
      }
    };

    /**
     * Connect to the PLC. Automatically retries on failure.
     */
    node.connect = async function (): Promise<void> {
      if (node._closing || node.connecting || node.connected) return;
      node.connecting = true;
      node._broadcast("cip:connecting");

      try {
        // Micro800: unconnected messaging (no ForwardOpen)
        // ControlLogix/CompactLogix: connected messaging
        node.plc = new Controller(!node.useMicro800);
        node.plc.timeout_sp = node.connTimeout;

        if (node.useMicro800) {
          // Patch write_cip: Micro800 has no backplane, so skip UnconnectedSend wrapper.
          // Send CIP messages directly as UCMM (SendRRData) without routing path.
          const enipWriteCip = Object.getPrototypeOf(Object.getPrototypeOf(node.plc)).write_cip;
          node.plc.write_cip = function (data: any, connected: boolean, timeout: number, cb: any) {
            enipWriteCip.call(this, data, false, timeout || 10, cb);
          };
        }

        // Apply multi-hop routing path if configured
        const routeBuffer = parseRoutingPath(node.routingPath);
        if (routeBuffer && node.plc) {
          node.plc.routing = routeBuffer;
        }

        const setupMode = !node.useMicro800;
        node.plc
          .connect(node.address, node.slot, setupMode)
          .then(async () => {
            if (node.useMicro800) {
              try {
                await node.plc.getControllerTagList(node.plc.state.tagList);
              } catch (e: any) {
                node.warn(
                  `Micro800 tag list fetch failed (tags may not be browsable): ${e.message}`
                );
              }
            }
            node.connecting = false;
            node.connected = true;
            node.metrics.connected = true;
            node.metrics.connectTime = Date.now();
            _responseTimes = [];
            node.log(
              `Connected to ${node.address}:${node.port} slot ${node.slot}${node.useMicro800 ? " (Micro800)" : ""}${node.routingPath ? " routing=" + node.routingPath : ""}`
            );
            node._broadcast("cip:connected");
          })
          .catch((err: Error) => {
            node.connecting = false;
            node.connected = false;
            node.metrics.connected = false;
            node.metrics.errorCount++;
            node.metrics.reconnectCount++;
            node.error(`Connection failed: ${err.message}`);
            node._broadcast("cip:error", err);
            node._scheduleRetry();
          });
      } catch (err: any) {
        node.connecting = false;
        node.connected = false;
        node.metrics.connected = false;
        node.metrics.errorCount++;
        node.metrics.reconnectCount++;
        node.error(`Connection failed: ${err.message}`);
        node._broadcast("cip:error", err);
        node._scheduleRetry();
      }
    };

    /**
     * Schedule a reconnect attempt after retryInterval ms.
     */
    node._scheduleRetry = function (): void {
      if (node._closing) return;
      clearTimeout(node._retryTimer!);
      node._retryTimer = setTimeout(() => {
        if (!node._closing) {
          node.connect();
        }
      }, node.retryInterval);
    };

    /**
     * Disconnect from the PLC.
     */
    node.disconnect = async function (): Promise<void> {
      clearTimeout(node._retryTimer!);
      node._retryTimer = null;
      if (node.plc) {
        try {
          await node.plc.disconnect();
        } catch (_: any) {
          // ignore disconnect errors during cleanup
        }
      }
      node.connected = false;
      node.connecting = false;
      node.metrics.connected = false;
      node.plc = null;
    };

    /**
     * Read a tag value from the PLC with metrics tracking.
     */
    node.readTag = async function (tagName: string): Promise<{ value: any; type: string }> {
      if (!node.connected || !node.plc) {
        throw new Error("Not connected to PLC");
      }
      const { Tag } = require("st-ethernet-ip");
      const tag = new Tag(tagName);

      try {
        const { result, elapsed } = await withTiming(() => node.plc.readTag(tag));
        updateResponseTime(elapsed);
        node.metrics.totalReads++;
        return { value: tag.value, type: tag.type };
      } catch (err: any) {
        node.metrics.errorCount++;
        throw err;
      }
    };

    /**
     * Write a value to a tag on the PLC with metrics tracking.
     */
    node.writeTag = async function (
      tagName: string,
      value: any,
      dataType?: number
    ): Promise<void> {
      if (!node.connected || !node.plc) {
        throw new Error("Not connected to PLC");
      }
      const { Tag } = require("st-ethernet-ip");
      const tag = new Tag(tagName);

      try {
        // Read first to initialize type, then write
        await node.plc.readTag(tag);
        tag.value = value;
        if (dataType != null) {
          tag.type = dataType;
        }
        const { elapsed } = await withTiming(() => node.plc.writeTag(tag));
        updateResponseTime(elapsed);
        node.metrics.totalWrites++;
      } catch (err: any) {
        node.metrics.errorCount++;
        throw err;
      }
    };

    /**
     * Atomic bit-level read-modify-write using CIP service 0x4E.
     * OR mask sets bits, AND mask clears bits. Both applied atomically by the PLC.
     */
    node.readModifyWriteTag = async function (
      tagName: string,
      orMask: Buffer,
      andMask: Buffer
    ): Promise<void> {
      if (!node.connected || !node.plc) {
        throw new Error("Not connected to PLC");
      }

      // Build CIP Read_Modify_Write_Tag request
      // Service 0x4E, path to tag, size of mask (2 or 4 bytes), OR mask, AND mask
      const { Tag } = require("st-ethernet-ip");
      const tag = new Tag(tagName);

      // Build the request path from the tag
      const pathBuf = tag.generateReadMessageRequest
        ? tag.generateReadMessageRequest().slice(2) // skip service + path size
        : null;

      if (!pathBuf) {
        // Fallback: do a non-atomic read-modify-write
        throw new Error(
          "Read-Modify-Write CIP service not available; use software read-modify-write"
        );
      }

      const maskSize = orMask.length;
      // Service(1) + pathSize(1) + path(N) + maskSize(2) + orMask(N) + andMask(N)
      const reqBuf = Buffer.alloc(2 + pathBuf.length + 2 + maskSize * 2);
      let offset = 0;
      reqBuf.writeUInt8(CIPService.READ_MODIFY_WRITE_TAG, offset++);
      reqBuf.writeUInt8(pathBuf.length / 2, offset++);
      pathBuf.copy(reqBuf, offset);
      offset += pathBuf.length;
      reqBuf.writeUInt16LE(maskSize, offset);
      offset += 2;
      orMask.copy(reqBuf, offset);
      offset += maskSize;
      andMask.copy(reqBuf, offset);

      try {
        const { elapsed } = await withTiming(
          () =>
            new Promise<void>((resolve, reject) => {
              node.plc.write_cip(reqBuf, false, 10, (err: any) => {
                if (err) reject(err);
                else resolve();
              });
            })
        );
        updateResponseTime(elapsed);
        node.metrics.totalWrites++;
      } catch (err: any) {
        node.metrics.errorCount++;
        throw err;
      }
    };

    /**
     * Read the PLC wall clock time.
     */
    node.readWallClock = async function (): Promise<Date> {
      if (!node.connected || !node.plc) {
        throw new Error("Not connected to PLC");
      }
      if (typeof node.plc.readWallClock === "function") {
        const result = await node.plc.readWallClock();
        node.metrics.totalReads++;
        return result instanceof Date ? result : new Date(result);
      }
      // Fallback: read WallClockTime attribute from Controller Object
      // CIP class 0x8B (Wall Clock/Time), instance 1, attribute 6
      const { Tag } = require("st-ethernet-ip");
      const tag = new Tag("WallClockTime");
      try {
        await node.plc.readTag(tag);
        node.metrics.totalReads++;
        return new Date(tag.value);
      } catch {
        throw new Error("Wall clock read not supported on this controller");
      }
    };

    /**
     * Write the PLC wall clock time.
     */
    node.writeWallClock = async function (date?: Date): Promise<void> {
      if (!node.connected || !node.plc) {
        throw new Error("Not connected to PLC");
      }
      const timestamp = date || new Date();
      if (typeof node.plc.writeWallClock === "function") {
        await node.plc.writeWallClock(timestamp);
        node.metrics.totalWrites++;
        return;
      }
      throw new Error("Wall clock write not supported on this controller");
    };

    /**
     * Change the controller operating mode (Run / Program / Test).
     * Sends CIP Set_Attribute_Single to Controller Object (class 0x01), instance 1, attribute 5.
     */
    node.changeMode = async function (mode: "run" | "program" | "test"): Promise<void> {
      if (!node.connected || !node.plc) {
        throw new Error("Not connected to PLC");
      }

      const modeValue = CONTROLLER_MODE[mode];
      if (modeValue === undefined) {
        throw new Error(`Invalid mode: ${mode}. Must be "run", "program", or "test"`);
      }

      // Build CIP Set_Attribute_Single request
      // Path: class 0x01 (Identity/Controller), instance 1, attribute 5 (Mode)
      const path = Buffer.from([0x20, CIPClass.IDENTITY, 0x24, 0x01, 0x30, 0x05]);
      const data = Buffer.alloc(2);
      data.writeUInt16LE(modeValue, 0);

      const reqLen = 2 + path.length + data.length;
      const reqBuf = Buffer.alloc(reqLen);
      let offset = 0;
      reqBuf.writeUInt8(CIPService.SET_ATTRIBUTE_SINGLE, offset++);
      reqBuf.writeUInt8(path.length / 2, offset++);
      path.copy(reqBuf, offset);
      offset += path.length;
      data.copy(reqBuf, offset);

      await new Promise<void>((resolve, reject) => {
        node.plc.write_cip(reqBuf, false, 10, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
    };

    /**
     * Reset controller fault.
     * Sends CIP Reset service (0x05) to Controller Object (class 0x01), instance 1.
     */
    node.resetFault = async function (): Promise<void> {
      if (!node.connected || !node.plc) {
        throw new Error("Not connected to PLC");
      }

      // Build CIP Reset request
      const path = Buffer.from([0x20, CIPClass.IDENTITY, 0x24, 0x01]);
      const reqBuf = Buffer.alloc(2 + path.length + 1);
      let offset = 0;
      reqBuf.writeUInt8(CIPService.RESET, offset++);
      reqBuf.writeUInt8(path.length / 2, offset++);
      path.copy(reqBuf, offset);
      offset += path.length;
      // Reset type 0 = non-power-cycle reset
      reqBuf.writeUInt8(0x00, offset);

      await new Promise<void>((resolve, reject) => {
        node.plc.write_cip(reqBuf, false, 10, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
    };

    /**
     * Get the underlying Controller instance.
     */
    node.getController = function (): any {
      return node.plc;
    };

    // Auto-connect when at least one user registers
    const origRegister = node.register;
    node.register = function (userNode: any): void {
      origRegister(userNode);
      if (!node.connected && !node.connecting) {
        node.connect();
      }
    };

    node.on("close", async function (done: () => void) {
      node._closing = true;
      node._broadcast("cip:disconnected");
      await node.disconnect();
      done();
    });
  }

  RED.nodes.registerType("cip-endpoint", CipEndpointNode);

  /**
   * Admin HTTP endpoint: browse tags from a deployed cip-endpoint node.
   * GET /cip-endpoint/:id/browse
   */
  RED.httpAdmin.get("/cip-endpoint/:id/browse", async function (req: any, res: any) {
    const node = RED.nodes.getNode(req.params.id);
    if (!node) {
      return res.status(404).json({ error: "Endpoint node not found. Deploy the flow first." });
    }
    if (!node.connected || !node.plc) {
      return res.status(503).json({ error: "Not connected to PLC." });
    }
    try {
      const tagList = node.plc.tagList || [];
      const tags = tagList.map((t: any) => ({
        name: t.name,
        type: t.type && t.type.typeName ? t.type.typeName : String(t.type || ""),
        program: t.program || null,
      }));
      tags.sort((a: any, b: any) => a.name.localeCompare(b.name));
      res.json(tags);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Admin HTTP endpoint: connection metrics.
   * GET /cip-endpoint/:id/metrics
   */
  RED.httpAdmin.get("/cip-endpoint/:id/metrics", function (req: any, res: any) {
    const node = RED.nodes.getNode(req.params.id);
    if (!node) {
      return res.status(404).json({ error: "Endpoint node not found. Deploy the flow first." });
    }
    try {
      const uptime =
        node.metrics.connectTime && node.connected
          ? Date.now() - node.metrics.connectTime
          : 0;

      res.json({
        ...node.metrics,
        uptime,
        address: node.address,
        port: node.port,
        slot: node.slot,
        useMicro800: node.useMicro800,
        routingPath: node.routingPath || null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
};
