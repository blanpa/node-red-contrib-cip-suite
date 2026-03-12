/**
 * CIP Browse node — browses available tags on an Allen-Bradley PLC.
 *
 * Enhancements over JS version:
 * - Include UDT template info in output (structure definition if available)
 * - Include array dimensions in output
 * - Filter option: msg.filter (string) to filter tags by name pattern (glob/regex)
 * - Program filter: msg.program to only show tags from specific program
 * - Rich output format: { name, type, typeName, dimensions, program, isUDT, templateId }
 * @module cip-browse
 */

import { CIPDataType, TagInfo } from "./types";
import { cipTypeName, STATUS } from "./utils";

module.exports = function (RED: any) {
  function CipBrowseNode(this: any, config: any) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint);
    node._browsing = false;

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    /**
     * Convert a glob-style pattern to a RegExp.
     * Supports * (any chars) and ? (single char).
     */
    function globToRegex(pattern: string): RegExp {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const globbed = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
      return new RegExp(`^${globbed}$`, "i");
    }

    /**
     * Parse filter string: if it starts with "/" treat as regex, otherwise as glob.
     */
    function parseFilter(filter: string): RegExp | null {
      if (!filter || !filter.trim()) return null;
      const trimmed = filter.trim();

      // Regex: /pattern/flags
      const regexMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexMatch) {
        try {
          return new RegExp(regexMatch[1], regexMatch[2] || "i");
        } catch {
          // Invalid regex, treat as glob
        }
      }

      return globToRegex(trimmed);
    }

    /**
     * Extract type information from a tag list entry.
     */
    function extractTypeInfo(t: any): {
      typeCode: number;
      typeName: string;
      isUDT: boolean;
      templateId: number | null;
    } {
      let typeCode: number;
      let typeName: string;
      let isUDT = false;
      let templateId: number | null = null;

      if (t.type && typeof t.type === "object") {
        typeCode = t.type.code || 0;
        typeName = t.type.typeName || cipTypeName(typeCode);
        isUDT = t.type.structure === true || typeCode === CIPDataType.STRUCT;
        templateId = t.type.templateId || null;
      } else if (typeof t.type === "number") {
        typeCode = t.type;
        // For CIP, type code might encode structure flag in upper bits
        // If bit 15 is set, the lower bits are the template instance
        if (typeCode & 0x8000) {
          isUDT = true;
          templateId = typeCode & 0x0fff;
          typeName = "STRUCT";
          typeCode = CIPDataType.STRUCT;
        } else {
          typeName = cipTypeName(typeCode);
        }
      } else {
        typeCode = 0;
        typeName = String(t.type || "UNKNOWN");
      }

      return { typeCode, typeName, isUDT, templateId };
    }

    // Connection lifecycle
    node.on("cip:connected", function () {
      node.status(STATUS.connected());
    });

    node.on("cip:connecting", function () {
      node.status(STATUS.connecting());
    });

    node.on("cip:error", function () {
      node.status({ fill: "red", shape: "ring", text: "connection error" });
    });

    node.on("cip:disconnected", function () {
      node.status(STATUS.disconnected());
    });

    node.on("input", async function (msg: any) {
      if (!node.endpoint.connected) {
        node.status({ fill: "red", shape: "ring", text: "not connected" });
        node.error("Not connected to PLC", msg);
        return;
      }

      if (node._browsing) {
        node.warn("Browse already in progress, dropping message");
        return;
      }

      node._browsing = true;
      node.status({ fill: "yellow", shape: "dot", text: "browsing..." });

      try {
        const controller = node.endpoint.getController();
        if (!controller) {
          throw new Error("Controller not available");
        }

        let tagList = controller.tagList || [];
        if (!tagList.length) {
          await controller.getControllerTagList(controller.state.tagList);
          tagList = controller.tagList || [];
        }

        // Build enriched tag info
        let tags: TagInfo[] = tagList.map((t: any) => {
          const { typeCode, typeName, isUDT, templateId } = extractTypeInfo(t);
          const dimensions = t.dims || t.dimensions || [];

          const tag: TagInfo & { isUDT: boolean; templateId: number | null } = {
            name: t.name,
            type: typeCode,
            typeName,
            dimensions: Array.isArray(dimensions) ? dimensions : [],
            program: t.program || null,
            isUDT,
            templateId,
          } as any;

          return tag;
        });

        // Apply program filter
        const programFilter = msg.program
          ? String(msg.program).trim()
          : null;
        if (programFilter) {
          tags = tags.filter((t) => {
            if (!t.program) return false;
            return t.program.toLowerCase() === programFilter.toLowerCase();
          });
        }

        // Apply name filter (glob or regex)
        const filterStr = msg.filter ? String(msg.filter) : null;
        const filterRegex = filterStr ? parseFilter(filterStr) : null;
        if (filterRegex) {
          tags = tags.filter((t) => filterRegex.test(t.name));
        }

        // Sort alphabetically by name
        tags.sort((a, b) => a.name.localeCompare(b.name));

        node.status({
          fill: "green",
          shape: "dot",
          text: `${tags.length} tags found`,
        });

        msg.payload = tags;
        msg.timestamp = Date.now();
        node.send(msg);
      } catch (err: any) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        node.error(`Browse failed: ${err.message}`, msg);
      } finally {
        node._browsing = false;
      }
    });

    node.endpoint.register(node);

    node.on("close", function (done: () => void) {
      if (node.endpoint) {
        node.endpoint.deregister(node);
      }
      done();
    });
  }

  RED.nodes.registerType("cip-browse", CipBrowseNode);
};
