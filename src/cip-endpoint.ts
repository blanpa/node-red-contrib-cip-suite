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
import { withTiming, cipTypeName, toCipError } from "./utils";

const { Controller } = require("st-ethernet-ip");

/** CIP general status 0x01, which is how a refused ForwardOpen surfaces. */
const CIP_CONNECTION_FAILURE = 0x01;


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

    /**
     * Apply connection options.
     *
     * With `init` set every option is applied, defaulted from the flow config. Without it
     * only the properties actually present on `opts` are copied, so a runtime override such
     * as `{ slot: 2 }` changes the slot alone. This mirrors the MQTT broker node's
     * setOptions/setIfHasProperty behaviour.
     *
     * Returns the names of the options whose value actually changed, so a caller can decide
     * whether a reconnect is warranted.
     */
    node.setOptions = function (opts: any, init?: boolean): string[] {
      if (!opts || typeof opts !== "object") return [];
      const changed: string[] = [];

      const apply = (prop: string, coerce: (v: any) => any, fallback: any): void => {
        const present = Object.prototype.hasOwnProperty.call(opts, prop);
        if (!init && !present) return;
        const raw = present ? opts[prop] : undefined;
        const next = raw === undefined || raw === null || raw === "" ? fallback : coerce(raw);
        if (node[prop] !== next) {
          node[prop] = next;
          changed.push(prop);
        }
      };

      const int = (v: any) => parseInt(v, 10);
      const str = (v: any) => String(v);
      // Tolerate the string "false", which is how a Node-RED checkbox can arrive.
      const bool = (v: any) => v !== false && v !== "false";

      apply("address", str, "");
      apply("port", int, 44818);
      apply("slot", int, 0);
      apply("connTimeout", int, 5000);
      apply("retryInterval", int, 5000);
      apply("maxRetryInterval", int, 60000);
      apply("useMicro800", bool, false);
      apply("routingPath", str, "");
      apply("keepAlive", int, 30000);

      // A NaN from a non-numeric override would poison every later comparison.
      const numericDefaults: Record<string, number> = {
        port: 44818,
        slot: 0,
        connTimeout: 5000,
        retryInterval: 5000,
        maxRetryInterval: 60000,
        keepAlive: 30000,
      };
      for (const p of Object.keys(numericDefaults)) {
        if (typeof node[p] !== "number" || isNaN(node[p])) node[p] = numericDefaults[p];
      }
      if (node.keepAlive < 0) node.keepAlive = 0;
      if (node.maxRetryInterval < node.retryInterval) node.maxRetryInterval = node.retryInterval;

      return changed;
    };

    node.setOptions(config, true);

    node.plc = null as any;
    node.connected = false;
    node.connecting = false;
    node._retryTimer = null as ReturnType<typeof setTimeout> | null;
    node._closing = false;
    node._users = new Set<any>();
    /** Set by an explicit disconnect() so a pending connect or retry does not undo it. */
    node._manualDisconnect = false;
    /** Callbacks waiting for the current connect attempt to settle. */
    node._connectWaiters = [] as Array<(err: Error | null) => void>;
    /** Consecutive failed attempts, for backoff. Reset on success. */
    node._attempt = 0;
    /**
     * Incremented for every connect attempt and by every disconnect. A late callback from
     * a superseded attempt compares against it and bows out, instead of tearing down the
     * attempt that replaced it.
     */
    node._attemptId = 0;
    /** Socket listeners we added, so repeated connect cycles neither leak nor clobber. */
    node._plcListeners = [] as Array<{ event: string; handler: (...a: any[]) => void }>;
    /** Keepalive timer, running only while connected. */
    node._keepAliveTimer = null as ReturnType<typeof setInterval> | null;

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
     * Register a user node so it receives connection events, connecting on demand.
     *
     * Connecting whenever a user registers while disconnected (rather than only for the
     * very first user, as the MQTT broker node does) means a node added to a live flow
     * still brings a dropped session back up.
     */
    node.register = function (userNode: any): void {
      node._users.add(userNode);
      if (node.connected) {
        userNode.emit("cip:connected");
        return;
      }
      if (!node.connecting && !node._closing) {
        node.connect();
      }
    };

    /**
     * Deregister a user node.
     *
     * `autoDisconnect` is the `removed` flag from the caller's close handler, so the session
     * survives a redeploy but is torn down when the last consumer is actually deleted.
     */
    node.deregister = function (userNode: any, done?: () => void, autoDisconnect?: boolean): void {
      node._users.delete(userNode);
      if (autoDisconnect && !node._closing && (node.connected || node.connecting) && node._users.size === 0) {
        node.disconnect(done);
        return;
      }
      if (done) done();
    };

    /** True when a connect attempt can be started. */
    node.canConnect = function (): boolean {
      return !node.connected && !node.connecting && !node._closing;
    };

    /** Connection state and metrics, for msg.action="status" and the admin route. */
    node.getStatus = function (): any {
      return {
        // Which config node answered. Two endpoints can share an address, so the address
        // alone does not identify the connection.
        id: node.id,
        name: node.name || null,
        state: node.connected ? "connected" : node.connecting ? "connecting" : "disconnected",
        ...node.metrics,
        uptime: node.metrics.connectTime && node.connected ? Date.now() - node.metrics.connectTime : 0,
        address: node.address,
        port: node.port,
        slot: node.slot,
        useMicro800: node.useMicro800,
        routingPath: node.routingPath || null,
      };
    };

    /** Settle every callback waiting on the in-flight connect attempt. */
    node._settleConnect = function (err: Error | null): void {
      const waiters = node._connectWaiters;
      node._connectWaiters = [];
      for (const w of waiters) {
        try {
          w(err);
        } catch (e: any) {
          node.error(`connect callback threw: ${e.message}`);
        }
      }
    };

    /** Track a listener we add to the Controller so we can remove exactly those again. */
    node._plcOn = function (event: string, handler: (...a: any[]) => void): void {
      node._plcListeners.push({ event, handler });
      if (node.plc && typeof node.plc.on === "function") node.plc.on(event, handler);
    };

    node._plcRemoveListeners = function (target?: any): void {
      const plc = target || node.plc;
      for (const l of node._plcListeners) {
        if (plc && typeof plc.removeListener === "function") {
          plc.removeListener(l.event, l.handler);
        }
      }
      node._plcListeners = [];
    };

    /**
     * Close a Controller we are done with.
     *
     * A failed or superseded attempt can still be holding an open TCP socket and a
     * registered EtherNet/IP session. Dropping the reference without closing it leaks both,
     * and controllers with a small session table (Micro800 especially) then start refusing
     * new connections until the sessions age out.
     */
    node._teardownPlc = async function (plc: any): Promise<void> {
      if (!plc) return;
      node._plcRemoveListeners(plc);
      try {
        if (typeof plc.disconnect === "function") await plc.disconnect();
      } catch {
        // best effort
      }
      try {
        if (typeof plc.destroy === "function") plc.destroy();
      } catch {
        // best effort
      }
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
     * The socket went away without us asking. Until this existed, a PLC that dropped off
     * the network left `connected` true forever and no retry was ever scheduled.
     */
    node._onSocketGone = function (which: any, err?: Error): void {
      // A superseded socket finishing its close must not tear down its replacement, which
      // is exactly what happens during a forced reconnect.
      if (node.plc !== which) {
        return;
      }
      if (node._closing) return;

      node._stopKeepAlive();
      const wasUp = node.connected || node.connecting;
      node._plcRemoveListeners(which);
      node.connected = false;
      node.connecting = false;
      node.metrics.connected = false;
      node.plc = null;
      if (!wasUp) return;

      node.metrics.errorCount++;
      node.metrics.reconnectCount++;
      node.log(`Connection to ${node.address}:${node.port} lost${err ? ": " + err.message : ""}`);
      node._settleConnect(err || new Error("Connection lost"));
      node._broadcast("cip:disconnected");
      if (!node._manualDisconnect) node._scheduleRetry();
    };

    /**
     * Connect to the PLC, retrying on failure.
     *
     * The callback fires when the attempt actually settles, not when the promise chain is
     * set up, so a caller can report the real outcome. Concurrent callers all settle
     * together and each callback runs at most once per attempt.
     */
    node.connect = async function (cb?: (err: Error | null) => void): Promise<void> {
      if (typeof cb === "function") node._connectWaiters.push(cb);

      if (node._closing) {
        node._settleConnect(new Error("Endpoint is closing"));
        return;
      }
      if (node.connected) {
        node._settleConnect(null);
        return;
      }
      // Already connecting: the waiter settles with the in-flight attempt.
      if (node.connecting) return;

      node._manualDisconnect = false;
      node.connecting = true;
      const attempt = ++node._attemptId;
      const isCurrent = (): boolean => node._attemptId === attempt && !node._closing;
      node._broadcast("cip:connecting");

      // Without this a caller waiting on the callback can hang indefinitely if the
      // underlying connect never settles. It releases the waiters only; connection state
      // is still driven by the attempt itself.
      const budget = Math.max(1000, node.connTimeout * 2);
      const watchdog = setTimeout(() => {
        if (isCurrent() && node._connectWaiters.length) {
          node._settleConnect(
            new Error(`Timed out connecting to ${node.address}:${node.port} after ${budget}ms`)
          );
        }
      }, budget);

      const onSettled = (): void => clearTimeout(watchdog);

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

        const thisPlc = node.plc;
        const setupMode = !node.useMicro800;
        node.plc
          .connect(node.address, node.slot, setupMode)
          .then(async () => {
            onSettled();
            // A disconnect, or a newer attempt, that landed while this one was in flight
            // must win. Otherwise the endpoint silently comes back up on stale settings.
            if (!isCurrent() || node._manualDisconnect) {
              await node._teardownPlc(thisPlc);
              if (node.plc === thisPlc) {
                node.plc = null;
                node.connecting = false;
                node._settleConnect(new Error("Disconnected"));
              }
              return;
            }

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
            node._attempt = 0;
            node.metrics.connected = true;
            node.metrics.connectTime = Date.now();
            _responseTimes = [];
            node._watchSocket(thisPlc);
            node._startKeepAlive();
            node.log(
              `Connected to ${node.address}:${node.port} slot ${node.slot}${node.useMicro800 ? " (Micro800)" : ""}${node.routingPath ? " routing=" + node.routingPath : ""}`
            );
            node._settleConnect(null);
            node._broadcast("cip:connected");
          })
          .catch((err: Error) => {
            onSettled();
            // A superseded attempt failing must not tear down the one that replaced it.
            if (!isCurrent()) {
              node._teardownPlc(thisPlc);
              return;
            }
            node._onConnectFailed(err, thisPlc);
          });
      } catch (err: any) {
        onSettled();
        if (!isCurrent()) return;
        node._onConnectFailed(err, node.plc);
      }
    };

    node._onConnectFailed = function (raw: any, plc?: any): void {
      node._stopKeepAlive();
      // Close the failed Controller rather than just dropping it: it may still hold an
      // open socket and a registered session on the PLC.
      node._teardownPlc(plc || node.plc);

      node.connecting = false;
      node.connected = false;
      node.metrics.connected = false;
      node.metrics.errorCount++;
      node.metrics.reconnectCount++;
      node._plcRemoveListeners();
      node.plc = null;

      const err = toCipError(raw, "Connection failed");

      // Connected messaging opens a Class 3 connection with ForwardOpen, which Micro800
      // controllers refuse outright. Without this the user only sees a bare CIP status.
      if (!node.useMicro800 && raw && raw.generalStatusCode === CIP_CONNECTION_FAILURE) {
        err.message +=
          '. If this is a Micro800 series controller (Micro820/850/870), enable "Micro800 Mode" ' +
          "on the endpoint: they do not support the connected messaging this uses.";
      }

      node.error(err.message);
      node._settleConnect(err);
      node._broadcast("cip:error", err);
      if (!node._manualDisconnect) node._scheduleRetry();
    };

    /**
     * Send a minimal CIP request purely to keep the session alive.
     *
     * Controllers close an idle EtherNet/IP session after an inactivity timeout: a
     * Micro850 does so after exactly 120 seconds. Without traffic the session dies, and
     * although the drop is now detected and retried, every read landing in the reconnect
     * window still fails. Get_Attribute_Single on the Identity object is the cheapest
     * request every CIP device is required to answer.
     */
    node._sendKeepAlive = function (): Promise<void> {
      const plc = node.plc;
      if (!plc) return Promise.reject(new Error("Not connected"));

      const path = Buffer.from([0x20, CIPClass.IDENTITY, 0x24, 0x01, 0x30, 0x01]);
      const reqBuf = Buffer.alloc(2 + path.length);
      reqBuf.writeUInt8(CIPService.GET_ATTRIBUTE_SINGLE, 0);
      reqBuf.writeUInt8(path.length / 2, 1);
      path.copy(reqBuf, 2);

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        // write_cip does not always call back on a dead socket, so bound the wait.
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Keepalive timed out"));
        }, Math.max(1000, node.connTimeout));

        try {
          plc.write_cip(reqBuf, false, 10, (err: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            err ? reject(toCipError(err, "Keepalive failed")) : resolve();
          });
        } catch (err: any) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(toCipError(err, "Keepalive failed"));
        }
      });
    };

    node._startKeepAlive = function (): void {
      node._stopKeepAlive();
      if (!node.keepAlive || node.keepAlive <= 0) return;
      node._keepAliveTimer = setInterval(() => {
        if (!node.connected || !node.plc) return;
        const plc = node.plc;
        node._sendKeepAlive().catch((err: Error) => {
          // Only react if this is still the socket we pinged.
          if (node.plc !== plc) return;
          node._onSocketGone(plc, err);
        });
      }, node.keepAlive);
    };

    node._stopKeepAlive = function (): void {
      if (node._keepAliveTimer) {
        clearInterval(node._keepAliveTimer);
        node._keepAliveTimer = null;
      }
    };

    /**
     * Watch the live socket so an unexpected drop is noticed.
     *
     * Controller extends ENIP extends net.Socket, and ENIP already attaches its own error
     * handler during connect, so adding ours cannot make an error throw.
     */
    node._watchSocket = function (plc: any): void {
      if (!plc || typeof plc.on !== "function") return;
      node._plcRemoveListeners(plc);

      if (typeof plc.setMaxListeners === "function") plc.setMaxListeners(0);
      if (typeof plc.setKeepAlive === "function") {
        plc.setKeepAlive(true, Math.max(1000, node.connTimeout));
      }

      node._plcOn("close", () => node._onSocketGone(plc));
      node._plcOn("end", () => node._onSocketGone(plc));
      node._plcOn("error", (err: Error) => node._onSocketGone(plc, err));
    };

    /**
     * Schedule a reconnect, backing off exponentially up to maxRetryInterval.
     *
     * Jitter stops a rack of nodes pointed at the same PLC from retrying in lockstep after
     * a shared outage. Setting maxRetryInterval equal to retryInterval restores a flat cadence.
     */
    node._scheduleRetry = function (): void {
      if (node._closing) return;
      clearTimeout(node._retryTimer!);

      const base = Math.min(node.retryInterval * Math.pow(2, node._attempt), node.maxRetryInterval);
      const delay = Math.round(base * (0.85 + Math.random() * 0.3));
      node._attempt = Math.min(node._attempt + 1, 16);

      node._retryTimer = setTimeout(() => {
        if (!node._closing && !node._manualDisconnect) node.connect();
      }, delay);
    };

    /**
     * Disconnect from the PLC and stop retrying until told otherwise.
     *
     * Broadcasts cip:disconnected, which the original did not, so user nodes no longer sit
     * on a stale green status after an explicit disconnect.
     */
    node.disconnect = async function (cb?: () => void): Promise<void> {
      node._manualDisconnect = true;
      node._attempt = 0;
      // Abandon any attempt still in flight so its callbacks cannot resurrect us.
      node._attemptId++;
      node._stopKeepAlive();
      clearTimeout(node._retryTimer!);
      node._retryTimer = null;

      const wasUp = node.connected || node.connecting;
      const plc = node.plc;

      // Drop our listeners first so the teardown does not re-enter via _onSocketGone.
      node._plcRemoveListeners(plc);
      node.connected = false;
      node.connecting = false;
      node.metrics.connected = false;
      node.plc = null;

      await node._teardownPlc(plc);

      node._settleConnect(new Error("Disconnected"));
      // Broadcast even when nothing was up. A redundant disconnect is how a user asks
      // "are we definitely down?", and staying silent leaves any stale display uncorrected.
      void wasUp;
      if (!node._closing) node._broadcast("cip:disconnected");
      if (cb) cb();
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
  RED.httpAdmin.get("/cip-endpoint/:id/browse", RED.auth.needsPermission("cip-endpoint.read"), async function (req: any, res: any) {
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
  RED.httpAdmin.get("/cip-endpoint/:id/metrics", RED.auth.needsPermission("cip-endpoint.read"), function (req: any, res: any) {
    const node = RED.nodes.getNode(req.params.id);
    if (!node) {
      return res.status(404).json({ error: "Endpoint node not found. Deploy the flow first." });
    }
    try {
      // Same payload msg.action="status" returns, so the two cannot drift.
      res.json(node.getStatus());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
};
