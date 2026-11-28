/**
 * CIP Subscribe node -- continuously scans tag values from an Allen-Bradley PLC.
 * Uses st-ethernet-ip's readTagGroup() for efficient cyclic multi-tag reads via
 * Multiple Service Packet (0x0A).
 * Supports report-by-exception (deadband filtering) and runtime reconfiguration.
 * @module cip-subscribe
 */

import "./st-type-patch";
import {
  CipEndpointNode,
  CipSubscribeConfig,
  NodeStatus,
} from "./types";
import { parseTagList, parseTagName, cipTypeName, STATUS, describeCipError } from "./utils";
import { SubscribePlan, SubscribeTag, buildSubscribePlan } from "./subscribe-plan";
import {
  DynOpts,
  handleEndpointMsg,
  stampEndpoint,
  endpointLabel,
  applyInitialStatus
} from "./endpoint-dynamic";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Tag, TagGroup } = require("st-ethernet-ip");

/**
 * Whether two scan values differ by more than the deadband. Arrays (a range such as
 * "MyArray[0..2]") are compared element by element: the library builds a new array on every
 * read, so comparing the arrays themselves would report a change on every scan.
 */
function valuesDiffer(current: any, last: any, deadband: number): boolean {
  if (Array.isArray(current) && Array.isArray(last)) {
    return current.length !== last.length || current.some((v, i) => valuesDiffer(v, last[i], deadband));
  }
  if (typeof current === "number" && typeof last === "number") {
    return Math.abs(current - last) > deadband;
  }
  return current !== last;
}

/** The type name for the output. st-ethernet-ip reports the name, other callers a code. */
function typeLabel(type: unknown): string {
  if (typeof type === "string") return type;
  return cipTypeName(typeof type === "number" ? type : 0);
}

interface TagState {
  name: string;
  alias?: string;
  tag: any; // st-ethernet-ip Tag instance
  lastValue: any;
  changed: boolean;
}

module.exports = function (RED: any) {
  function CipSubscribeNode(this: any, config: CipSubscribeConfig & { id: string; name: string }) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint) as CipEndpointNode | null;
    // An upgraded node takes its tags, scan rate and deadband from what the editor shows. One
    // that has not been upgraded has no plan and keeps its original behaviour.
    const plan: SubscribePlan | null = buildSubscribePlan(config, (value: string, type: string, msg?: any) =>
      RED.util.evaluateNodeProperty(value, type, node, msg)
    );
    node.scanRate = plan ? plan.scanRate : parseInt(config.scanRate as any, 10) || 1000;
    node.deadband = plan ? plan.deadband : parseFloat(config.deadband as any) || 0;
    node.diffOnly = config.diffOnly === true || (config.diffOnly as any) === "true";
    node._tagStates = [] as TagState[];
    node._scanning = false;
    node._scanTimer = null as ReturnType<typeof setInterval> | null;
    // Bumped every time the scan stops. A cycle already awaiting the PLC carries the
    // generation it started under, so it can tell whether it still speaks for the node.
    node._scanGen = 0;
    node._inFlight = false;
    node._tagGroup = null;
    node._tags = (plan ? plan.tags : parseTagList(config.tags || "").map((name: string) => ({ name }))) as SubscribeTag[];

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" } as NodeStatus);
      return;
    }

    // Reflect the endpoint's real state immediately. Without this a node whose endpoint
    // never fires a cip:* event (autoConnect off) shows whatever the editor last saw,
    // which after a restart is the previous run's status.
    applyInitialStatus(node);

    // A tag list, output, scan rate or deadband that cannot be used is reported once, and the
    // node does not scan. Redeploy to try again.
    if (plan && plan.error) {
      node.error(plan.error);
      // After applyInitialStatus has had its turn, which would otherwise show "connected".
      setTimeout(() => {
        node.status({ fill: "red", shape: "ring", text: "invalid configuration" } as NodeStatus);
      }, 10);
    }

    const warnedUnused = new Set<string>();
    /** Tell the user, once per deploy, that a message carries a property this node does not read. */
    function warnUnusedProps(msg: any): void {
      if (!plan) return;
      const advice: Record<string, string> = {
        tags: 'Ignoring msg.tags. Set Mode to "Dynamic" to take the tags from the message.',
        scanRate: "Ignoring msg.scanRate. The scan rate is set in the editor.",
      };
      for (const name of plan.unusedProps(msg)) {
        if (warnedUnused.has(name)) continue;
        warnedUnused.add(name);
        node.warn(advice[name]);
      }
    }

    /**
     * Rebind to a different endpoint.
     *
     * The TagGroup is built against a specific controller's tag list, so it has to be torn
     * down and rebuilt rather than carried across.
     */
    function useEndpoint(endpoint: any): void {
      if (endpoint === node.endpoint) return;
      stopScan();
      teardownTags();
      if (node.endpoint) node.endpoint.deregister(node);
      node.endpoint = endpoint;
      endpoint.register(node, { connect: false });
      if (endpoint.connected) {
        const tagNames = resolveTagNames();
        if (tagNames.length > 0 && !(plan && plan.error)) {
          setupTags(tagNames);
          startScan();
        }
      } else {
        node.status(
          endpoint.connecting
            ? STATUS.connecting(endpointLabel(node))
            : STATUS.disconnected(endpointLabel(node))
        );
      }
    }

    const DYN: DynOpts = {
      type: "cip-endpoint",
      switchTo: useEndpoint,
      // This node holds a scan loop rather than answering one message at a time, so there
      // is no single operation a bare msg.endpoint could be borrowed for. Naming one
      // without an action is rejected instead, pointing at "switch".
      borrowable: false,
      // Documented at nodes/cip-subscribe.html but never implemented until now.
      extraActions: {
        start: (_msg: any, _send: any, done: any) => {
          if (plan && plan.error) {
            done(new Error(plan.error));
            return;
          }
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
        stop: (_msg: any, _send: any, done: any) => {
          stopScan();
          node.status(STATUS.idle());
          done();
        },
        restart: (_msg: any, _send: any, done: any) => {
          if (plan && plan.error) {
            done(new Error(plan.error));
            return;
          }
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

    /** The tags to scan, as a copy so a scan in progress is not changed under it. */
    function resolveTagNames(): SubscribeTag[] {
      return [...node._tags];
    }

    /**
     * Build Tag objects and add to a TagGroup for multi-tag reads.
     */
    function setupTags(tagNames: SubscribeTag[]): void {
      teardownTags();
      const controller = node.endpoint.getController();
      if (!controller) return;

      const group = new TagGroup();
      const states: TagState[] = [];
      for (const { name, alias } of tagNames) {
        try {
          // "MyArray[0..2]" is not a path the library accepts: read from the first element
          // for as many as the range holds, as cip-read does.
          const parsed = parseTagName(name);
          let tag;
          if (parsed.isRange && parsed.arrayStart !== null && parsed.arrayEnd !== null) {
            if (parsed.arrayEnd < parsed.arrayStart) {
              throw new Error(`range [${parsed.arrayStart}..${parsed.arrayEnd}] ends before it starts`);
            }
            const count = parsed.arrayEnd - parsed.arrayStart + 1;
            tag = new Tag(`${parsed.baseName}[${parsed.arrayStart}]`, null, null, 0, 0, count);
          } else {
            tag = new Tag(name);
          }
          group.add(tag);
          states.push({
            name,
            alias,
            tag,
            lastValue: undefined,
            changed: false,
          });
        } catch (err: any) {
          node.warn(`Failed to add tag "${name}": ${describeCipError(err)}`);
        }
      }
      node._tagStates = states;
      node._tagGroup = group;
    }

    /**
     * Remove all tag subscriptions.
     */
    function teardownTags(): void {
      node._tagStates = [];
      node._tagGroup = null;
    }

    /**
     * Start the scan cycle using readTagGroup() directly.
     * We avoid controller.scan() because it runs an internal while-loop
     * that conflicts with our own setInterval timing.
     */
    function startScan(): void {
      stopScan(); // bumps the generation, orphaning any cycle still in flight
      if (plan && plan.error) return;
      const endpoint = node.endpoint;
      const controller = endpoint && endpoint.getController();
      if (!controller || node._tagStates.length === 0 || !node._tagGroup) return;

      // Both are captured, not read back off the node: a switch replaces them while a
      // read is still outstanding against the controller this cycle started on.
      const gen = node._scanGen;
      const group = node._tagGroup;

      node._scanning = true;
      node._inFlight = false;

      const current = (): boolean => node._scanning && node._scanGen === gen;

      const runCycle = async () => {
        if (!current() || node._inFlight) return;
        node._inFlight = true;
        try {
          await controller.readTagGroup(group);
          // Without this the values just read from the endpoint we have since left would
          // be emitted as though they came from the one we switched to.
          if (current()) {
            processScanResults(endpoint);
          }
        } catch (err: any) {
          if (current()) node.log(`Scan error: ${describeCipError(err)}`);
        } finally {
          // A superseded cycle must not clear the flag out from under its replacement.
          if (node._scanGen === gen) node._inFlight = false;
        }
      };

      // Delay the first scan cycle briefly after connection to let the CIP
      // session fully settle (avoids 1-2 TIMEOUT errors on startup).
      node._scanTimer = setTimeout(() => {
        runCycle();
        if (current()) {
          node._scanTimer = setInterval(runCycle, node.scanRate);
        }
      }, 500) as any;
      updateStatus();
    }

    /**
     * Stop the scan cycle.
     */
    function stopScan(): void {
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
    function processScanResults(endpoint?: any): void {
      const states = node._tagStates as TagState[];
      if (states.length === 0) return;

      let anyChanged = false;
      const tagDetails: Array<{ name: string; alias?: string; value: any; type: string; changed: boolean }> = [];

      for (const s of states) {
        const currentValue = s.tag.value;
        const typeName = typeLabel(s.tag.type);
        let changed = false;

        if (s.lastValue === undefined) {
          // First read is always "changed"
          changed = true;
        } else {
          changed = valuesDiffer(currentValue, s.lastValue, node.deadband);
        }

        s.changed = changed;
        if (changed) {
          // A copy, since the library hands out arrays it may keep using.
          s.lastValue = Array.isArray(currentValue) ? [...currentValue] : currentValue;
          anyChanged = true;
        }

        tagDetails.push({
          name: s.name,
          ...(s.alias ? { alias: s.alias } : {}),
          value: currentValue,
          type: typeName,
          changed,
        });
      }

      // If diffOnly and nothing changed, skip output
      if (node.diffOnly && !anyChanged) return;

      const now = Date.now();

      if (plan ? plan.output === "value" : states.length === 1) {
        // One tag: payload = value directly
        const t = tagDetails[0];
        if (node.diffOnly && !t.changed) return;
        const msg: any = {
          payload: t.value,
          tagName: t.name,
          dataType: t.type,
          changed: t.changed,
          tags: tagDetails,
          scanRate: node.scanRate,
          timestamp: now,
        };
        node.send(stampEndpoint(msg, endpoint));
      } else {
        // Several tags: payload = an object keyed by alias or tag name (of values, or of
        // results), or the array of results. A result names its tag as tagName, which is
        // what cip-write takes.
        const resultOf = (t: (typeof tagDetails)[number]) => ({
          ...(t.alias ? { alias: t.alias } : {}),
          tagName: t.name,
          value: t.value,
          type: t.type,
          changed: t.changed,
        });
        let payload: any;
        if (plan && plan.output === "array") {
          payload = tagDetails.map(resultOf);
        } else {
          payload = {};
          for (const t of tagDetails) {
            let entry: any = t.value;
            if (plan && plan.output === "keyresult") {
              // The key says which tag, so the alias is not repeated inside the result
              const { alias: _alias, ...rest } = resultOf(t) as any;
              entry = rest;
            }
            // defineProperty so an alias of __proto__ is a key and not the prototype
            Object.defineProperty(payload, t.alias || t.name, {
              value: entry,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
        }
        const msg: any = {
          payload,
          tags: node.diffOnly
            ? tagDetails.filter((t) => t.changed)
            : tagDetails,
          scanRate: node.scanRate,
          timestamp: now,
        };
        node.send(stampEndpoint(msg, endpoint));
      }

      updateStatus();
    }

    /**
     * Update node status display.
     */
    function updateStatus(): void {
      if (!node._scanning || node._tagStates.length === 0) {
        node.status(STATUS.idle());
        return;
      }
      node.status({
        fill: "green",
        shape: "dot",
        text: `scanning ${node._tagStates.length} tags @ ${node.scanRate}ms`,
      } as NodeStatus);
    }

    // -- Connection lifecycle events --

    node.on("cip:connected", function () {
      if (plan && plan.error) {
        node.status({ fill: "red", shape: "ring", text: "invalid configuration" } as NodeStatus);
        return;
      }
      const tagNames = resolveTagNames();
      if (tagNames.length === 0) {
        node.status({
          fill: "yellow",
          shape: "ring",
          text: plan && plan.mode === "dynamic" ? "waiting for tags" : "no tags configured",
        } as NodeStatus);
        return;
      }
      setupTags(tagNames);
      startScan();
    });

    node.on("cip:connecting", function () {
      node.status(STATUS.connecting(endpointLabel(node)));
      stopScan();
    });

    node.on("cip:error", function () {
      node.status(STATUS.error("connection error"));
      stopScan();
    });

    node.on("cip:disconnected", function () {
      node.status(STATUS.disconnected(endpointLabel(node)));
      stopScan();
    });

    // -- Runtime input for reconfiguration --

    node.on("input", function (msg: any, send: any, done: any) {
      // msg.command is kept as a deprecated alias for the start/stop/restart actions the
      // help has always documented.
      if (msg.action === undefined && typeof msg.command === "string") {
        msg = { ...msg, action: msg.command };
      }
      if (handleEndpointMsg(RED, node, msg, send, done, DYN)) return;

      if (plan) {
        warnUnusedProps(msg);
        if (plan.mode === "dynamic" && !plan.error) {
          const request = plan.resolveTags(msg);
          if (request.kind === "error") {
            node.error(request.error, msg);
          } else if (request.kind === "none") {
            if (!request.absent) node.warn(request.reason);
          } else {
            node._tags = request.tags;
            if (node.endpoint.connected) {
              stopScan();
              setupTags(request.tags);
              startScan();
            }
          }
        }
        if (done) done();
        return;
      }

      // Runtime override: change tag list
      if (msg.tags !== undefined) {
        const newTags = typeof msg.tags === "string"
          ? parseTagList(msg.tags)
          : Array.isArray(msg.tags)
            ? msg.tags
                .map((t: any) => String(t && typeof t === "object" ? (t.name ?? t.tagName ?? "") : (t ?? "")).trim())
                .filter(Boolean)
            : [];
        if (newTags.length > 0) {
          node._tags = newTags.map((name: string) => ({ name }));
          if (node.endpoint.connected) {
            stopScan();
            setupTags(node._tags);
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
    if (node.endpoint) node.endpoint.register(node);

    node.on("close", function (removed: boolean, done: () => void) {
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
