/**
 * CIP Write node — writes tag values to an Allen-Bradley PLC.
 *
 * Enhancements over JS version:
 * - Bit-level write: "MyDint.5" uses read-modify-write (atomic if available)
 * - Array element write: "MyArray[3]"
 * - Array range write: msg.payload is array of values
 * - UDT/Structure write support
 * - Batch mode: msg.tags is array of {name, value}
 * - read-modify-write config option for atomic bit operations
 * - Backpressure protection, static value, browse button
 * @module cip-write
 */

import { CIPDataType, WriteResult } from "./types";
import {
  parseTagName,
  getBit,
  setBit,
  buildBitMasks,
  STATUS,
  withTiming,
  cipTypeName,
  describeCipError,
  toCipError,
} from "./utils";
import {
  DynOpts,
  MsgEndpoint,
  handleEndpointMsg,
  stampEndpoint,
  ensureConnected,
  endpointLabel,
  applyInitialStatus
} from "./endpoint-dynamic";

module.exports = function (RED: any) {
  function CipWriteNode(this: any, config: any) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint);
    node.tagName = config.tagName || "";
    node.dataType = config.dataType || "auto";
    node.staticValue = config.staticValue;
    node.useStaticValue = config.useStaticValue || false;
    node.useAtomicBitWrite = config.useAtomicBitWrite || false;
    node._writing = false;

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    // Reflect the endpoint's real state immediately. Without this a node whose endpoint
    // never fires a cip:* event (autoConnect off) shows whatever the editor last saw,
    // which after a restart is the previous run's status.
    applyInitialStatus(node);

    /** Rebind to a different endpoint, moving our registration with us. */
    function useEndpoint(endpoint: any): void {
      if (endpoint === node.endpoint) return;
      
      // Deregistering is enough to stop the old endpoint's broadcasts reaching us: it
      // fans out by emitting on its registered user nodes.
      if (node.endpoint) node.endpoint.deregister(node);
      node.endpoint = endpoint;
      endpoint.register(node, { connect: false });
      if (!endpoint.connected) {
        node.status(
          endpoint.connecting
            ? STATUS.connecting(endpointLabel(node))
            : STATUS.disconnected(endpointLabel(node))
        );
      }
    }

    const DYN: DynOpts = { type: "cip-endpoint", switchTo: useEndpoint };

    /**
     * Determine the byte size of a CIP data type for bit mask operations.
     */
    function getTypeByteSize(typeCode: any): number {
      const code = typeof typeCode === "object" && typeCode !== null ? typeCode.code : typeCode;
      switch (code) {
        case CIPDataType.BOOL:
        case CIPDataType.SINT:
        case CIPDataType.USINT:
          return 1;
        case CIPDataType.INT:
        case CIPDataType.UINT:
          return 2;
        case CIPDataType.DINT:
        case CIPDataType.UDINT:
        case CIPDataType.REAL:
        case CIPDataType.DWORD:
          return 4;
        case CIPDataType.LINT:
        case CIPDataType.LREAL:
        case CIPDataType.LWORD:
          return 8;
        default:
          return 4; // default to DINT size
      }
    }

    /**
     * Write a single tag with support for bit access, array elements, array ranges, and UDTs.
     */
    async function writeSingleTag(tagName: string, value: any, use?: any): Promise<WriteResult> {
      const parsed = parseTagName(tagName);
      const endpoint = use || node.endpoint;
      if (!endpoint) throw new Error("No endpoint selected");
      const controller = endpoint.getController();
      if (!controller) throw new Error("Controller not available");

      const { Tag } = require("st-ethernet-ip");
      let Structure: any;
      try {
        Structure = require("st-ethernet-ip").Structure;
      } catch {
        // Structure class may not be available
      }

      // Bit-level write: "MyDint.5"
      if (parsed.bitIndex !== null) {
        const bitValue = Boolean(value);

        // Try atomic read-modify-write first (CIP service 0x4E)
        if (
          node.useAtomicBitWrite &&
          typeof endpoint.readModifyWriteTag === "function"
        ) {
          try {
            // Need to read the tag first to determine type/size
            const tag = new Tag(parsed.baseName);
            await controller.readTag(tag);
            const byteSize = getTypeByteSize(tag.type);
            const { orMask, andMask } = buildBitMasks(byteSize, parsed.bitIndex, bitValue);
            await endpoint.readModifyWriteTag(parsed.baseName, orMask, andMask);
            return {
              success: true,
              tagName,
              value: bitValue,
              timestamp: Date.now(),
            };
          } catch (err: any) {
            // Fall through to software read-modify-write
            node.warn(
              `Atomic bit write failed, falling back to software RMW: ${err.message}`
            );
          }
        }

        // Software read-modify-write
        const tag = new Tag(parsed.baseName);
        await controller.readTag(tag);
        const currentValue = tag.value as number;
        const newValue = setBit(currentValue, parsed.bitIndex, bitValue);
        tag.value = newValue;
        await controller.writeTag(tag);

        return {
          success: true,
          tagName,
          value: bitValue,
          timestamp: Date.now(),
        };
      }

      // Array range write: "MyArray[0..9]" with array of values
      if (parsed.isRange && parsed.arrayStart !== null && parsed.arrayEnd !== null) {
        if (!Array.isArray(value)) {
          throw new Error(
            `Array range write requires an array of values, got ${typeof value}`
          );
        }
        const count = parsed.arrayEnd - parsed.arrayStart + 1;
        if (value.length !== count) {
          throw new Error(
            `Array range [${parsed.arrayStart}..${parsed.arrayEnd}] expects ${count} values, got ${value.length}`
          );
        }
        // Write each element individually
        for (let i = 0; i < count; i++) {
          const idx = parsed.arrayStart + i;
          const elemTag = new Tag(`${parsed.baseName}[${idx}]`);
          await controller.readTag(elemTag); // init type
          elemTag.value = value[i];
          await controller.writeTag(elemTag);
        }
        return {
          success: true,
          tagName,
          value,
          timestamp: Date.now(),
        };
      }

      // Array element write: "MyArray[3]"
      if (parsed.arrayIndex !== null) {
        const tag = new Tag(`${parsed.baseName}[${parsed.arrayIndex}]`);
        await controller.readTag(tag); // init type
        tag.value = value;
        await controller.writeTag(tag);
        return {
          success: true,
          tagName,
          value,
          timestamp: Date.now(),
        };
      }

      // UDT/Structure write
      const tag = new Tag(parsed.baseName);
      await controller.readTag(tag); // init type

      const typeCode =
        typeof tag.type === "object" && tag.type !== null ? tag.type.code : tag.type;
      if (
        typeCode === CIPDataType.STRUCT &&
        Structure &&
        typeof Structure === "function" &&
        typeof value === "object" &&
        value !== null
      ) {
        try {
          const struct = new Structure(parsed.baseName);
          await controller.readTag(struct);
          // Apply new values to the structure
          if (typeof struct.value === "object" && struct.value !== null) {
            Object.assign(struct.value, value);
          } else {
            struct.value = value;
          }
          await controller.writeTag(struct);
          return {
            success: true,
            tagName,
            value,
            timestamp: Date.now(),
          };
        } catch {
          // Fall through to standard write
        }
      }

      // Standard tag write
      tag.value = value;
      if (node.dataType !== "auto") {
        const explicitType = parseInt(node.dataType, 16);
        if (!isNaN(explicitType)) {
          tag.type = explicitType;
        }
      }
      await controller.writeTag(tag);

      return {
        success: true,
        tagName,
        value,
        timestamp: Date.now(),
      };
    }

    /**
     * Write multiple tags in batch.
     */
    async function writeBatch(
      tags: Array<{ name: string; value: any }>,
      use?: any
    ): Promise<WriteResult[]> {
      const results: WriteResult[] = [];
      for (const item of tags) {
        try {
          const r = await writeSingleTag(item.name, item.value, use);
          results.push(r);
        } catch (err: any) {
          results.push({
            success: false,
            tagName: item.name,
            value: item.value,
            error: err.message,
            timestamp: Date.now(),
          });
        }
      }
      return results;
    }

    // Connection lifecycle
    node.on("cip:connected", function () {
      node.status(STATUS.connected(endpointLabel(node)));
    });

    node.on("cip:connecting", function () {
      node.status(STATUS.connecting(endpointLabel(node)));
    });

    node.on("cip:error", function () {
      node.status({ fill: "red", shape: "ring", text: "connection error" });
    });

    node.on("cip:disconnected", function () {
      node.status(STATUS.disconnected(endpointLabel(node)));
    });

    node.on("input", async function (msg: any, send: any, done: any) {
      // A bare msg.endpoint names the endpoint for this write only and leaves the node
      // bound where it was, so ctx is captured before any await.
      const ctx: MsgEndpoint = { endpoint: node.endpoint };
      if (handleEndpointMsg(RED, node, msg, send, done, DYN, ctx)) return;
      const endpoint = ctx.endpoint;

      try {
        await ensureConnected(node, endpoint);
      } catch (err: any) {
        node.status({ fill: "red", shape: "ring", text: describeCipError(err) });
        done ? done(toCipError(err)) : node.error(describeCipError(err), msg);
        return;
      }

      if (node._writing) {
        node.warn("Write already in progress, dropping message");
        return;
      }

      node._writing = true;
      try {
        // Batch mode: msg.tags is array of {name, value}
        if (Array.isArray(msg.tags)) {
          const { result: batchResults, elapsed } = await withTiming(() =>
            writeBatch(msg.tags, endpoint)
          );
          const allOk = batchResults.every((r: WriteResult) => r.success);
          msg.payload = batchResults;
          node.status({
            fill: allOk ? "green" : "yellow",
            shape: "dot",
            text: `${batchResults.length} tags written (${elapsed}ms)`,
          });
          node.send(stampEndpoint(msg, endpoint));
          return;
        }

        // Single tag mode
        const tag = msg.tagName || node.tagName;
        if (!tag) {
          node.error("No tag name specified", msg);
          return;
        }

        const value = node.useStaticValue ? node.staticValue : msg.payload;
        if (value === undefined || value === null) {
          node.error("No value to write", msg);
          return;
        }

        const { result, elapsed } = await withTiming(() => writeSingleTag(tag, value, endpoint));
        node.status({
          fill: "green",
          shape: "dot",
          text: `${tag} written (${elapsed}ms)`,
        });
        msg.payload = result;
        node.send(stampEndpoint(msg, endpoint));
      } catch (err: any) {
        node.status({ fill: "red", shape: "ring", text: describeCipError(err) });
        msg.payload = {
          success: false,
          tagName: msg.tagName || node.tagName,
          error: err.message,
          timestamp: Date.now(),
        } as WriteResult;
        node.error(
          `Write failed for ${msg.tagName || node.tagName}: ${err.message}`,
          msg
        );
        node.send(stampEndpoint(msg, endpoint));
      } finally {
        node._writing = false;
      }
    });

    if (node.endpoint) node.endpoint.register(node);

    node.on("close", function (done: () => void) {
      if (node.endpoint) {
        node.endpoint.deregister(node);
      }
      done();
    });
  }

  RED.nodes.registerType("cip-write", CipWriteNode);
};
