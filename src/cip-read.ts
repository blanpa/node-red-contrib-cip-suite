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
import {
  parseTagName,
  parseProgramScope,
  resolveMemberInfo,
  canonicalizeTagName,
  getBit,
  STATUS,
  withTiming,
  cipTypeName,
  describeCipError,
  toCipError,
} from "./utils";
import { ArraySizeCache, resolveArrayLength } from "./tag-array";

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
    // Array lengths are a property of the running controller program, so the
    // memo is dropped whenever the connection is re-established.
    node._arraySizes = new ArraySizeCache();

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    function isStructureTag(tag: any): boolean {
      return tag != null && tag._template != null;
    }

    function isStructType(type: unknown): boolean {
      if (type === CIPDataType.STRUCT || type === "STRUCT") return true;
      if (typeof type === "object" && type !== null && (type as any).code === CIPDataType.STRUCT) {
        return true;
      }
      return false;
    }

    /**
     * Build a tag object for a path. Goes through `Controller.newTag()` when a
     * tag list is available so UDT paths come back as a `Structure` (which
     * decodes into an object) rather than a plain `Tag` (which yields raw bytes).
     *
     * `arrayDims` must be > 0 when reading several elements of a UDT array, or
     * `Structure` decodes the whole buffer as one element.
     */
    function createTag(
      controller: any,
      tagName: string,
      program: string | null,
      readSize = 1,
      arrayDims = 0
    ): any {
      const { Tag } = require("st-ethernet-ip");
      if (typeof controller.newTag === "function" && controller.state?.tagList) {
        return controller.newTag(tagName, program, false, arrayDims, readSize);
      }
      return new Tag(tagName, program, null, 0, arrayDims, readSize);
    }

    function formatResultType(type: unknown): string {
      if (typeof type === "string") return type;
      if (typeof type === "number") return cipTypeName(type);
      return String(type ?? "");
    }

    /**
     * Read a single tag with support for bit access, array elements, array ranges, and UDTs.
     */
    async function readSingleTag(
      tagName: string,
      options: { dataType?: string; arraySize?: number } = {}
    ): Promise<{ value: any; type: string; bitIndex?: number; arrayIndex?: number }> {
      const parsed = parseTagName(tagName);
      const controller = node.endpoint.getController();
      if (!controller) throw new Error("Controller not available");

      const effectiveDataType = options.dataType ?? node.dataType;
      const rawScope = parseProgramScope(parsed.baseName);
      const tagList = controller.state?.tagList;
      // Match the controller's own casing before any tag object is built:
      // st-ethernet-ip resolves UDT members case-sensitively, so "fis_stn[0].local"
      // would otherwise read back as raw struct bytes instead of an object.
      const scope = {
        program: rawScope.program,
        name: canonicalizeTagName(rawScope.name, tagList, rawScope.program),
      };
      // The program name travels as a separate argument to the tag constructor,
      // so the path itself must not keep its "Program:<name>." prefix.
      parsed.baseName = scope.name;
      const memberInfo = resolveMemberInfo(scope.name, tagList, scope.program);

      // Array range read: "MyArray[0..9]" or "Struct.Member[0..101]"
      if (parsed.isRange && parsed.arrayStart !== null && parsed.arrayEnd !== null) {
        const count = parsed.arrayEnd - parsed.arrayStart + 1;
        const indexedName = `${parsed.baseName}[${parsed.arrayStart}]`;
        const tag = createTag(controller, indexedName, scope.program, count);
        await controller.readTag(tag);
        return {
          value: tag.value,
          type: formatResultType(tag.type),
        };
      }

      // Array element read: "MyArray[3]"
      if (parsed.arrayIndex !== null) {
        const indexedName = `${parsed.baseName}[${parsed.arrayIndex}]`;
        const tag = createTag(controller, indexedName, scope.program);
        await controller.readTag(tag);
        return {
          value: tag.value,
          type: formatResultType(tag.type),
          arrayIndex: parsed.arrayIndex,
        };
      }

      // Bit-level access: "MyDint.5"
      if (parsed.bitIndex !== null) {
        const tag = createTag(controller, parsed.baseName, scope.program);
        await controller.readTag(tag);
        const bitValue = getBit(tag.value, parsed.bitIndex);
        return {
          value: bitValue,
          type: formatResultType(tag.type),
          bitIndex: parsed.bitIndex,
        };
      }

      // Explicit STRUCT read (or auto when tag list marks the path as a
      // non-array UDT; arrays of structs fall through to the array branch)
      if (
        !memberInfo.isArray &&
        (effectiveDataType === "STRUCT" ||
          (effectiveDataType === "auto" && memberInfo.isStruct))
      ) {
        const tag = createTag(controller, parsed.baseName, scope.program);
        await controller.readTag(tag);
        if (isStructureTag(tag)) {
          return {
            value: tag.value,
            type: "STRUCT",
          };
        }
        if (effectiveDataType === "STRUCT") {
          throw new Error(
            `Tag "${parsed.baseName}" is not a UDT/STRUCT (tag list template missing?)`
          );
        }
      }

      // Full array read when ARRAY is selected, a size is provided, or the tag
      // list resolved the path to an array
      if (
        effectiveDataType === "ARRAY" ||
        options.arraySize != null ||
        ((effectiveDataType === "auto" || effectiveDataType === "STRUCT") && memberInfo.isArray)
      ) {
        // UDT members carry their length in the template; array tags do not, so
        // those are resolved from the controller and memoised per connection.
        let size = options.arraySize ?? (memberInfo.isArray ? memberInfo.arraySize : null) ?? null;
        if (size == null || size < 1) {
          const resolved = await resolveArrayLength(
            controller,
            parsed.baseName,
            scope.program,
            (indexedName: string) => createTag(controller, indexedName, scope.program),
            node._arraySizes
          );
          size = resolved?.size ?? 1;
        }

        // A UDT array needs arrayDims > 0 or Structure decodes the whole
        // response as a single element.
        const tag = createTag(controller, parsed.baseName, scope.program, size, size > 1 ? 1 : 0);
        await controller.readTag(tag);

        return {
          value: tag.value,
          type: formatResultType(tag.type),
        };
      }

      // Standard scalar read
      const tag = createTag(controller, parsed.baseName, scope.program);
      await controller.readTag(tag);

      // Auto-detect STRUCT from response type or raw buffer payload
      if (
        effectiveDataType === "auto" &&
        (isStructType(tag.type) || tag.state?.tag?.type === CIPDataType.STRUCT)
      ) {
        const structTag = createTag(controller, parsed.baseName, scope.program);
        await controller.readTag(structTag);
        if (isStructureTag(structTag) && !Buffer.isBuffer(structTag.value)) {
          return {
            value: structTag.value,
            type: "STRUCT",
          };
        }
        if (Buffer.isBuffer(tag.value)) {
          node.warn(
            `Structure read for "${parsed.baseName}" returned raw buffer; tag list templates may be incomplete`
          );
        }
      }

      return {
        value: tag.value,
        type: formatResultType(tag.type),
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
        const rawScope = parseProgramScope(parsed.baseName);
        const tagList = controller.state?.tagList;
        const scope = {
          program: rawScope.program,
          name: canonicalizeTagName(rawScope.name, tagList, rawScope.program),
        };
        parsed.baseName = scope.name;
        const memberInfo = resolveMemberInfo(scope.name, tagList, scope.program);
        const needsSpecialRead =
          parsed.bitIndex !== null ||
          parsed.isRange ||
          node.dataType === "ARRAY" ||
          node.dataType === "STRUCT" ||
          memberInfo.isStruct ||
          memberInfo.isArray;

        if (needsSpecialRead) {
          tagObjects.push({ name: tagName, tag: null, individual: true });
        } else {
          const fullName =
            parsed.arrayIndex !== null
              ? `${parsed.baseName}[${parsed.arrayIndex}]`
              : parsed.baseName;
          const tag = createTag(controller, fullName, scope.program);
          group.add(tag);
          tagObjects.push({ name: tagName, tag, individual: false });
        }
      }

      // TagGroup counts its members through `length`; `size` is undefined, which
      // used to skip the group read entirely and return null for every tag in it.
      if (group.length > 0) {
        await controller.readTagGroup(group);
      }

      const results: MultiTagResult[] = [];
      for (const item of tagObjects) {
        if (item.individual) {
          try {
            const r = await readSingleTag(item.name);
            results.push({
              tagName: item.name,
              value: r.value,
              type: r.type,
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
            type: formatResultType(item.tag.type),
          });
        }
      }
      return results;
    }

    /**
     * Read the configured tag and send the result.
     */
    async function doRead(triggerMsg?: any): Promise<void> {
      if (node._reading) return;

      node._reading = true;
      try {
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

        const tag = (triggerMsg && triggerMsg.tagName) || node.tagName;
        if (!tag) {
          node.warn("No tag name specified");
          return;
        }

        const readOptions = {
          dataType: triggerMsg?.dataType,
          arraySize:
            triggerMsg?.arraySize != null
              ? parseInt(String(triggerMsg.arraySize), 10)
              : undefined,
        };

        const { result, elapsed } = await withTiming(() => readSingleTag(tag, readOptions));
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
            : Array.isArray(result.value)
              ? `array[${result.value.length}]`
              : typeof result.value === "object" && result.value !== null
                ? "object"
                : String(result.value);
        node.status({
          fill: "green",
          shape: "dot",
          text: `${tag} = ${displayValue} (${elapsed}ms)`,
        });
        node.send(msg);
      } catch (err: any) {
        node.status({ fill: "red", shape: "ring", text: describeCipError(err) });
        node.error(toCipError(err, "Read failed").message, triggerMsg || {});
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

    node.on("cip:connected", function () {
      node.status(STATUS.connected());
      node._arraySizes.clear();
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
