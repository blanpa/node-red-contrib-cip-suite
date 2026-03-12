/**
 * CIP Raw node — sends raw CIP service requests for advanced use cases.
 *
 * Enhancements over JS version:
 * - Better response parsing with human-readable CIP status
 * - Support both connected and unconnected messaging (config option)
 * - msg.data can be Buffer or hex string
 * - Response includes parsed fields: { service, status, statusText, data, raw }
 * - Support for Multiple Service Packet (service 0x0A) — msg.requests array
 * @module cip-raw
 */

import { CIPService, CIP_STATUS } from "./types";
import { cipStatusText, STATUS, withTiming } from "./utils";

/** Single CIP request descriptor for Multiple Service Packet */
interface CIPRequestDescriptor {
  service: number;
  classId: number;
  instanceId: number;
  attributeId?: number;
  data?: Buffer | string | number[] | null;
}

/** Parsed CIP response */
interface CIPResponse {
  service: number;
  status: number;
  statusText: string;
  data: Buffer | null;
  raw: Buffer;
}

module.exports = function (RED: any) {
  function CipRawNode(this: any, config: any) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint);
    node.service = parseInt(config.service, 16) || 0;
    node.classId = parseInt(config.classId, 16) || 0;
    node.instanceId = parseInt(config.instanceId, 16) || 0;
    node.attributeId = parseInt(config.attributeId, 16) || 0;
    node.useConnected = config.useConnected || false;
    node._busy = false;

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    /**
     * Convert data input to Buffer. Accepts Buffer, hex string, or number array.
     */
    function toBuffer(data: any): Buffer {
      if (data === null || data === undefined) return Buffer.alloc(0);
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === "string") {
        // Hex string: "0x01 0x02" or "01 02" or "0102"
        const cleaned = data.replace(/0x/gi, "").replace(/[\s,]+/g, "");
        if (/^[0-9a-fA-F]*$/.test(cleaned) && cleaned.length % 2 === 0) {
          return Buffer.from(cleaned, "hex");
        }
        return Buffer.from(data);
      }
      if (Array.isArray(data)) {
        return Buffer.from(data);
      }
      return Buffer.alloc(0);
    }

    /**
     * Build a CIP path buffer from class, instance, and optional attribute IDs.
     * Supports 8-bit and 16-bit segment encoding.
     */
    function buildCIPPath(classId: number, instanceId: number, attributeId?: number): Buffer {
      const segments: Buffer[] = [];

      // Class segment
      if (classId <= 0xff) {
        segments.push(Buffer.from([0x20, classId]));
      } else {
        const seg = Buffer.alloc(4);
        seg.writeUInt8(0x21, 0); // 16-bit class segment
        seg.writeUInt8(0x00, 1); // pad
        seg.writeUInt16LE(classId, 2);
        segments.push(seg);
      }

      // Instance segment
      if (instanceId <= 0xff) {
        segments.push(Buffer.from([0x24, instanceId]));
      } else {
        const seg = Buffer.alloc(4);
        seg.writeUInt8(0x25, 0); // 16-bit instance segment
        seg.writeUInt8(0x00, 1); // pad
        seg.writeUInt16LE(instanceId, 2);
        segments.push(seg);
      }

      // Attribute segment (optional)
      if (attributeId !== undefined) {
        if (attributeId <= 0xff) {
          segments.push(Buffer.from([0x30, attributeId]));
        } else {
          const seg = Buffer.alloc(4);
          seg.writeUInt8(0x31, 0); // 16-bit attribute segment
          seg.writeUInt8(0x00, 1); // pad
          seg.writeUInt16LE(attributeId, 2);
          segments.push(seg);
        }
      }

      return Buffer.concat(segments);
    }

    /**
     * Build a single CIP request message buffer.
     */
    function buildCIPRequest(
      service: number,
      path: Buffer,
      data: Buffer
    ): Buffer {
      const pathWords = path.length / 2;
      const req = Buffer.alloc(2 + path.length + data.length);
      let offset = 0;
      req.writeUInt8(service, offset++);
      req.writeUInt8(pathWords, offset++);
      path.copy(req, offset);
      offset += path.length;
      data.copy(req, offset);
      return req;
    }

    /**
     * Build a Multiple Service Packet (service 0x0A) from an array of request descriptors.
     */
    function buildMultipleServicePacket(requests: CIPRequestDescriptor[]): Buffer {
      // Build individual request buffers
      const reqBuffers: Buffer[] = [];
      for (const r of requests) {
        const path = buildCIPPath(r.classId, r.instanceId, r.attributeId);
        const data = toBuffer(r.data);
        reqBuffers.push(buildCIPRequest(r.service, path, data));
      }

      // Calculate offsets
      // Header: service(1) + pathSize(1) + path(4: class 0x02, instance 1) + count(2)
      // Then: offsets(2 * count) + request data
      const mspPath = buildCIPPath(0x02, 0x01); // Message Router, instance 1
      const headerSize = 2 + mspPath.length + 2; // service + pathSize + path + count
      const offsetTableSize = 2 * requests.length;
      const dataStart = headerSize + offsetTableSize;

      let totalDataSize = 0;
      for (const buf of reqBuffers) totalDataSize += buf.length;

      const packet = Buffer.alloc(dataStart + totalDataSize);
      let offset = 0;

      // Service
      packet.writeUInt8(CIPService.MULTIPLE_SERVICE_PACKET, offset++);
      // Path size in words
      packet.writeUInt8(mspPath.length / 2, offset++);
      // Path
      mspPath.copy(packet, offset);
      offset += mspPath.length;
      // Number of services
      packet.writeUInt16LE(requests.length, offset);
      offset += 2;

      // Offset table (offsets relative to start of count field)
      let dataOffset = offsetTableSize + 2; // relative to count field
      for (const buf of reqBuffers) {
        packet.writeUInt16LE(dataOffset, offset);
        offset += 2;
        dataOffset += buf.length;
      }

      // Request data
      for (const buf of reqBuffers) {
        buf.copy(packet, offset);
        offset += buf.length;
      }

      return packet;
    }

    /**
     * Parse a CIP response buffer into structured fields.
     */
    function parseCIPResponse(raw: Buffer): CIPResponse {
      if (!raw || raw.length < 4) {
        return {
          service: 0,
          status: 0xff,
          statusText: "No response data",
          data: null,
          raw: raw || Buffer.alloc(0),
        };
      }

      const service = raw.readUInt8(0) & 0x7f; // mask off reply bit
      // byte 1 is reserved
      const status = raw.readUInt8(2);
      const extStatusSize = raw.readUInt8(3);
      const dataOffset = 4 + extStatusSize * 2;
      const data = dataOffset < raw.length ? raw.slice(dataOffset) : null;

      return {
        service,
        status,
        statusText: cipStatusText(status),
        data,
        raw,
      };
    }

    /**
     * Parse a Multiple Service Packet response.
     */
    function parseMultipleServiceResponse(raw: Buffer): CIPResponse[] {
      if (!raw || raw.length < 6) return [];

      const count = raw.readUInt16LE(0);
      const offsets: number[] = [];
      for (let i = 0; i < count; i++) {
        offsets.push(raw.readUInt16LE(2 + i * 2));
      }

      const responses: CIPResponse[] = [];
      for (let i = 0; i < count; i++) {
        const start = offsets[i] + 2; // offsets are relative to count field
        const end = i + 1 < count ? offsets[i + 1] + 2 : raw.length;
        const respBuf = raw.slice(start, end);
        responses.push(parseCIPResponse(respBuf));
      }
      return responses;
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

      if (node._busy) {
        node.warn("Request already in progress, dropping message");
        return;
      }

      node._busy = true;
      node.status({ fill: "yellow", shape: "dot", text: "sending..." });

      try {
        const controller = node.endpoint.getController();
        if (!controller) {
          throw new Error("Controller not available");
        }

        // Multiple Service Packet mode
        if (Array.isArray(msg.requests) && msg.requests.length > 0) {
          const mspPacket = buildMultipleServicePacket(msg.requests);
          const useConnected = msg.connected != null ? Boolean(msg.connected) : node.useConnected;

          const { result: rawResponse, elapsed } = await withTiming(
            () =>
              new Promise<Buffer>((resolve, reject) => {
                controller.write_cip(mspPacket, useConnected, 10, (err: any, data: Buffer) => {
                  if (err) reject(err);
                  else resolve(data);
                });
              })
          );

          const responses = parseMultipleServiceResponse(rawResponse);
          msg.payload = {
            success: true,
            service: CIPService.MULTIPLE_SERVICE_PACKET,
            serviceText: "Multiple Service Packet",
            responses,
            elapsed,
            timestamp: Date.now(),
          };
          node.status({
            fill: "green",
            shape: "dot",
            text: `${responses.length} responses (${elapsed}ms)`,
          });
          node.send(msg);
          return;
        }

        // Single service mode
        const service = msg.service != null ? msg.service : node.service;
        const classId = msg.classId != null ? msg.classId : node.classId;
        const instanceId = msg.instanceId != null ? msg.instanceId : node.instanceId;
        const attributeId = msg.attributeId != null ? msg.attributeId : node.attributeId;
        const data = toBuffer(msg.data);
        const useConnected = msg.connected != null ? Boolean(msg.connected) : node.useConnected;

        const path = buildCIPPath(classId, instanceId, attributeId != null ? attributeId : undefined);
        const reqBuf = buildCIPRequest(service, path, data);

        // Send via write_cip
        const { result: rawResponse, elapsed } = await withTiming(
          () =>
            new Promise<Buffer>((resolve, reject) => {
              controller.write_cip(reqBuf, useConnected, 10, (err: any, data: Buffer) => {
                if (err) reject(err);
                else resolve(data);
              });
            })
        );

        const parsed = parseCIPResponse(rawResponse);

        msg.payload = {
          success: parsed.status === 0,
          service: parsed.service,
          status: parsed.status,
          statusText: parsed.statusText,
          data: parsed.data,
          raw: parsed.raw,
          elapsed,
          timestamp: Date.now(),
        };

        if (parsed.status === 0) {
          node.status({
            fill: "green",
            shape: "dot",
            text: `ok (${elapsed}ms)`,
          });
        } else {
          node.status({
            fill: "yellow",
            shape: "ring",
            text: parsed.statusText,
          });
        }

        node.send(msg);
      } catch (err: any) {
        node.status({ fill: "red", shape: "ring", text: err.message });
        msg.payload = {
          success: false,
          service: msg.service || node.service,
          status: 0xff,
          statusText: err.message,
          data: null,
          raw: null,
          error: err.message,
          timestamp: Date.now(),
        };
        node.error(`Raw CIP request failed: ${err.message}`, msg);
        node.send(msg);
      } finally {
        node._busy = false;
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

  RED.nodes.registerType("cip-raw", CipRawNode);
};
