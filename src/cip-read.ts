/**
 * CIP Read node — reads tag values from an Allen-Bradley PLC.
 * Supports poll-interval and trigger-based modes.
 *
 * Enhancements over JS version:
 * - Bit-level access: "MyDint.5" reads integer then extracts bit 5
 * - Array element: "MyArray[3]" reads element 3
 * - Array range: "MyArray[0..9]" reads elements 0-9 via fragmented read
 * - UDT/Structure support using Structure class from st-ethernet-ip
 * - Batch mode: msg.tags array reads multiple tags via TagGroup
 * - Backpressure protection, browse button support, polling
 * @module cip-read
 */

import { CIPDataType, MultiTagResult } from "./types";
import { parseTagName, getBit, STATUS, withTiming, cipTypeName } from "./utils";

module.exports = function (RED: any) {
  function CipReadNode(this: any, config: any) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint);
    node.tagName = config.tagName || "";
    node.dataType = config.dataType || "auto";
    node.pollInterval = parseInt(config.pollInterval, 10) || 0;
    node._pollTimer = null as ReturnType<typeof setInterval> | null;
    node._reading = false;

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    /**
     * Read a single tag with support for bit access, array elements, array ranges, and UDTs.
     */
    async function readSingleTag(
      tagName: string
    ): Promise<{ value: any; type: string; bitIndex?: number; arrayIndex?: number }> {
      const parsed = parseTagName(tagName);
      const controller = node.endpoint.getController();
      if (!controller) throw new Error("Controller not available");

      const { Tag, TagGroup } = require("st-ethernet-ip");
      let Structure: any;
      try {
        Structure = require("st-ethernet-ip").Structure;
      } catch {
        // Structure class may not be available in all versions
      }

      // Array range read: "MyArray[0..9]"
      if (parsed.isRange && parsed.arrayStart !== null && parsed.arrayEnd !== null) {
        const count = parsed.arrayEnd - parsed.arrayStart + 1;
        const tag = new Tag(parsed.baseName, null, count);
        if (parsed.arrayStart > 0) {
          // Use fragmented read starting at offset
          tag.value = null;
        }
        // Read the tag (st-ethernet-ip handles fragmented read for count > 1)
        const tagWithIndex = new Tag(`${parsed.baseName}[${parsed.arrayStart}]`, null, count);
        await controller.readTag(tagWithIndex);
        return {
          value: tagWithIndex.value,
          type: tagWithIndex.type,
        };
      }

      // Array element read: "MyArray[3]"
      if (parsed.arrayIndex !== null) {
        const tag = new Tag(`${parsed.baseName}[${parsed.arrayIndex}]`);
        await controller.readTag(tag);
        return {
          value: tag.value,
          type: tag.type,
          arrayIndex: parsed.arrayIndex,
        };
      }

      // Bit-level access: "MyDint.5"
      if (parsed.bitIndex !== null) {
        const tag = new Tag(parsed.baseName);
        await controller.readTag(tag);
        const bitValue = getBit(tag.value, parsed.bitIndex);
        return {
          value: bitValue,
          type: tag.type,
          bitIndex: parsed.bitIndex,
        };
      }

      // Standard tag read
      const tag = new Tag(parsed.baseName);
      await controller.readTag(tag);

      // Check for UDT/Structure type
      const typeCode =
        typeof tag.type === "object" && tag.type !== null ? tag.type.code : tag.type;
      if (
        typeCode === CIPDataType.STRUCT &&
        Structure &&
        typeof Structure === "function"
      ) {
        try {
          const struct = new Structure(parsed.baseName);
          await controller.readTag(struct);
          return {
            value: struct.value,
            type: "STRUCT",
          };
        } catch (structErr: any) {
          node.warn(`Structure read for "${parsed.baseName}" failed, using raw value: ${structErr.message}`);
        }
      }

      return {
        value: tag.value,
        type: tag.type,
      };
    }

    /**
     * Read multiple tags using TagGroup for batch efficiency.
     */
    async function readBatch(
      tags: string[]
    ): Promise<MultiTagResult[]> {
      const controller = node.endpoint.getController();
      if (!controller) throw new Error("Controller not available");

      const { Tag, TagGroup } = require("st-ethernet-ip");
      const group = new TagGroup();
      const tagObjects: any[] = [];

      for (const tagName of tags) {
        const parsed = parseTagName(tagName);
        // For batch, only support simple tags and array elements
        // Bit access and ranges are handled individually
        if (parsed.bitIndex !== null || parsed.isRange) {
          // Handle individually after group read
          tagObjects.push({ name: tagName, tag: null, individual: true });
        } else {
          const fullName =
            parsed.arrayIndex !== null
              ? `${parsed.baseName}[${parsed.arrayIndex}]`
              : parsed.baseName;
          const tag = new Tag(fullName);
          group.add(tag);
          tagObjects.push({ name: tagName, tag, individual: false });
        }
      }

      // Read the group
      if (group.size > 0) {
        await controller.readTagGroup(group);
      }

      // Build results
      const results: MultiTagResult[] = [];
      for (const item of tagObjects) {
        if (item.individual) {
          try {
            const r = await readSingleTag(item.name);
            results.push({
              tagName: item.name,
              value: r.value,
              type: typeof r.type === "string" ? r.type : cipTypeName(r.type),
            });
          } catch (err: any) {
            results.push({
              tagName: item.name,
              value: null,
              type: "",
              error: err.message,
            });
          }
        } else {
          results.push({
            tagName: item.name,
            value: item.tag.value,
            type: item.tag.type,
          });
        }
      }
      return results;
    }

    /**
     * Read the configured tag and send the result.
     */
    async function doRead(triggerMsg?: any): Promise<void> {
      if (node._reading) return; // backpressure: skip if previous read still in-flight

      node._reading = true;
      try {
        // Batch mode: msg.tags is an array of tag names
        if (triggerMsg && Array.isArray(triggerMsg.tags)) {
          const { result: batchResult, elapsed } = await withTiming(() =>
            readBatch(triggerMsg.tags)
          );
          const msg: any = {
            payload: batchResult,
            timestamp: Date.now(),
            _msgid: triggerMsg._msgid,
            topic: triggerMsg.topic,
          };
          node.status({
            fill: "green",
            shape: "dot",
            text: `${batchResult.length} tags read (${elapsed}ms)`,
          });
          node.send(msg);
          return;
        }

        // Single tag mode
        const tag = (triggerMsg && triggerMsg.tagName) || node.tagName;
        if (!tag) {
          node.warn("No tag name specified");
          return;
        }

        const { result, elapsed } = await withTiming(() => readSingleTag(tag));
        const msg: any = {
          payload: result.value,
          tagName: tag,
          dataType: result.type,
          timestamp: Date.now(),
        };
        if (result.bitIndex !== undefined) {
          msg.bitIndex = result.bitIndex;
        }
        if (result.arrayIndex !== undefined) {
          msg.arrayIndex = result.arrayIndex;
        }
        if (triggerMsg) {
          msg._msgid = triggerMsg._msgid;
          msg.topic = triggerMsg.topic;
        }

        const displayValue =
          typeof result.value === "boolean"
            ? result.value
              ? "true"
              : "false"
            : String(result.value);
        node.status({
          fill: "green",
          shape: "dot",
          text: `${tag} = ${displayValue} (${elapsed}ms)`,
        });
        node.send(msg);
      } catch (err: any) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        node.error(
          `Read failed: ${err.message}`,
          triggerMsg || {}
        );
      } finally {
        node._reading = false;
      }
    }

    function startPolling(): void {
      stopPolling();
      if (node.pollInterval > 0) {
        node._pollTimer = setInterval(() => doRead(), node.pollInterval);
      }
    }

    function stopPolling(): void {
      if (node._pollTimer) {
        clearInterval(node._pollTimer);
        node._pollTimer = null;
      }
    }

    // Connection lifecycle
    node.on("cip:connected", function () {
      node.status(STATUS.connected());
      startPolling();
    });

    node.on("cip:connecting", function () {
      node.status(STATUS.connecting());
      stopPolling();
    });

    node.on("cip:error", function () {
      node.status({ fill: "red", shape: "ring", text: "connection error" });
      stopPolling();
    });

    node.on("cip:disconnected", function () {
      node.status(STATUS.disconnected());
      stopPolling();
    });

    // Trigger-based: read on incoming message
    node.on("input", function (msg: any) {
      if (!node.endpoint.connected) {
        node.status({ fill: "red", shape: "ring", text: "not connected" });
        node.error("Not connected to PLC", msg);
        return;
      }
      doRead(msg);
    });

    node.endpoint.register(node);

    node.on("close", function (done: () => void) {
      stopPolling();
      if (node.endpoint) {
        node.endpoint.deregister(node);
      }
      done();
    });
  }

  RED.nodes.registerType("cip-read", CipReadNode);
};
