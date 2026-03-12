/**
 * CIP File Object node — firmware upload/download via File Object (class 0x37).
 *
 * Provides:
 * - File upload (read from device)
 * - File download (write to device)
 * - File directory listing
 * - File metadata access (size, checksum, name)
 * - Transfer progress tracking
 *
 * ODVA Volume 1, Chapter 7-31: File Object
 *
 * @module cip-file
 */

import * as fs from "fs";
import * as path from "path";
import { STATUS, withTiming, cipStatusText } from "./utils";

const FILE_OBJECT_CLASS = 0x37;

// File Object services
const FILE_SVC = {
  INITIATE_UPLOAD: 0x4b,   // Begin upload (device → host)
  UPLOAD_TRANSFER: 0x4f,   // Get next chunk
  INITIATE_DOWNLOAD: 0x4c, // Begin download (host → device)
  DOWNLOAD_TRANSFER: 0x50, // Send next chunk
};

// File Object attributes
const FILE_ATTR = {
  STATE: 1,
  INSTANCE_NAME: 2,
  INSTANCE_FORMAT_VER: 3,
  FILE_NAME: 4,
  FILE_REVISION: 5,
  FILE_SIZE: 6,
  FILE_CHECKSUM: 7,
  INVOCATION_METHOD: 8,
  FILE_SAVE_PARAMS: 9,
  FILE_TYPE: 10,
  FILE_ENCODING: 11,
};

// File Object state
const FILE_STATE_NAMES: Record<number, string> = {
  0: "Nonexistent",
  1: "File Empty",
  2: "File Loaded",
  3: "Transfer Upload In Progress",
  4: "Transfer Download In Progress",
  5: "Storing",
  255: "File Access Error",
};

module.exports = function (RED: any) {
  function CipFileNode(this: any, config: any) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint);
    node._fileInstance = parseInt(config.fileInstance, 10) || 1;
    node._busy = false;
    node._transferInProgress = false;

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    function buildPath(classId: number, instance: number, attribute?: number): Buffer {
      const parts: number[] = [0x20, classId];
      if (instance <= 0xFF) {
        parts.push(0x24, instance);
      } else {
        // 16-bit instance
        const buf = Buffer.alloc(4);
        buf.writeUInt8(0x25, 0);
        buf.writeUInt8(0x00, 1);
        buf.writeUInt16LE(instance, 2);
        const base = Buffer.from([0x20, classId]);
        const combined = Buffer.concat([base, buf]);
        if (attribute !== undefined) {
          return Buffer.concat([combined, Buffer.from([0x30, attribute])]);
        }
        return combined;
      }
      if (attribute !== undefined) parts.push(0x30, attribute);
      return Buffer.from(parts);
    }

    function buildReq(service: number, classPath: Buffer, data?: Buffer): Buffer {
      const d = data || Buffer.alloc(0);
      const req = Buffer.alloc(2 + classPath.length + d.length);
      req.writeUInt8(service, 0);
      req.writeUInt8(classPath.length / 2, 1);
      classPath.copy(req, 2);
      if (d.length > 0) d.copy(req, 2 + classPath.length);
      return req;
    }

    async function sendReq(req: Buffer): Promise<{ status: number; data: Buffer }> {
      const controller = node.endpoint.getController();
      if (!controller) throw new Error("Controller not available");
      const raw: Buffer = await new Promise((resolve, reject) => {
        controller.write_cip(req, false, 10, (err: any, data: Buffer) => {
          if (err) reject(err); else resolve(data);
        });
      });
      if (!raw || raw.length < 4) throw new Error("Empty response");
      const status = raw.readUInt8(2);
      const extSize = raw.readUInt8(3);
      return { status, data: raw.slice(4 + extSize * 2) };
    }

    /**
     * Read file metadata.
     */
    async function readFileInfo(instance: number): Promise<any> {
      const info: any = { instance, timestamp: Date.now() };

      // State
      try {
        const p = buildPath(FILE_OBJECT_CLASS, instance, FILE_ATTR.STATE);
        const { status, data } = await sendReq(buildReq(0x0e, p));
        if (status === 0 && data.length >= 1) {
          info.state = data.readUInt8(0);
          info.stateText = FILE_STATE_NAMES[info.state] || `Unknown (${info.state})`;
        }
      } catch (_) {}

      // File name
      try {
        const p = buildPath(FILE_OBJECT_CLASS, instance, FILE_ATTR.FILE_NAME);
        const { status, data } = await sendReq(buildReq(0x0e, p));
        if (status === 0 && data.length >= 2) {
          const nameLen = data.readUInt16LE(0);
          info.fileName = data.slice(2, 2 + nameLen).toString("utf8");
        }
      } catch (_) {}

      // Instance name
      try {
        const p = buildPath(FILE_OBJECT_CLASS, instance, FILE_ATTR.INSTANCE_NAME);
        const { status, data } = await sendReq(buildReq(0x0e, p));
        if (status === 0 && data.length >= 2) {
          const nameLen = data.readUInt16LE(0);
          info.instanceName = data.slice(2, 2 + nameLen).toString("utf8");
        }
      } catch (_) {}

      // File size
      try {
        const p = buildPath(FILE_OBJECT_CLASS, instance, FILE_ATTR.FILE_SIZE);
        const { status, data } = await sendReq(buildReq(0x0e, p));
        if (status === 0 && data.length >= 4) {
          info.fileSize = data.readUInt32LE(0);
        }
      } catch (_) {}

      // Checksum
      try {
        const p = buildPath(FILE_OBJECT_CLASS, instance, FILE_ATTR.FILE_CHECKSUM);
        const { status, data } = await sendReq(buildReq(0x0e, p));
        if (status === 0 && data.length >= 2) {
          info.checksum = data.readUInt16LE(0);
        }
      } catch (_) {}

      // File revision
      try {
        const p = buildPath(FILE_OBJECT_CLASS, instance, FILE_ATTR.FILE_REVISION);
        const { status, data } = await sendReq(buildReq(0x0e, p));
        if (status === 0 && data.length >= 2) {
          info.revision = { major: data.readUInt8(0), minor: data.readUInt8(1) };
        }
      } catch (_) {}

      info.success = true;
      return info;
    }

    /**
     * Upload file from device (device → host).
     */
    async function uploadFile(instance: number): Promise<{ data: Buffer; info: any }> {
      const fPath = buildPath(FILE_OBJECT_CLASS, instance);

      // Initiate Upload
      const initReq = buildReq(FILE_SVC.INITIATE_UPLOAD, fPath, Buffer.alloc(1, 0)); // max transfer size 0 = device decides
      const initResp = await sendReq(initReq);
      if (initResp.status !== 0) {
        throw new Error(`Initiate Upload failed: ${cipStatusText(initResp.status)}`);
      }

      let fileSize = 0;
      let transferSize = 200; // default
      if (initResp.data.length >= 4) {
        fileSize = initResp.data.readUInt32LE(0);
      }
      if (initResp.data.length >= 5) {
        transferSize = initResp.data.readUInt8(4);
      }

      // Transfer data
      const chunks: Buffer[] = [];
      let transferNumber = 0;
      let complete = false;

      while (!complete && transferNumber < 10000) {
        const transferData = Buffer.alloc(1);
        transferData.writeUInt8(transferNumber & 0xFF, 0);

        const transferReq = buildReq(FILE_SVC.UPLOAD_TRANSFER, fPath, transferData);
        const transferResp = await sendReq(transferReq);

        if (transferResp.status === 0) {
          // More data follows
          if (transferResp.data.length > 1) {
            chunks.push(transferResp.data.slice(1)); // skip transfer number echo
          }
          transferNumber++;
        } else if (transferResp.status === 0x06) {
          // Last transfer (partial)
          if (transferResp.data.length > 1) {
            chunks.push(transferResp.data.slice(1));
          }
          complete = true;
        } else {
          throw new Error(`Upload transfer ${transferNumber} failed: ${cipStatusText(transferResp.status)}`);
        }

        // Progress update
        const totalBytes = chunks.reduce((a, c) => a + c.length, 0);
        const pct = fileSize > 0 ? Math.round((totalBytes / fileSize) * 100) : 0;
        node.status({ fill: "blue", shape: "dot", text: `uploading ${pct}%` });
      }

      return { data: Buffer.concat(chunks), info: { fileSize, transferSize, chunks: transferNumber + 1 } };
    }

    /**
     * Download file to device (host → device).
     */
    async function downloadFile(instance: number, fileData: Buffer): Promise<any> {
      const fPath = buildPath(FILE_OBJECT_CLASS, instance);
      const transferSize = 200; // bytes per transfer

      // Initiate Download
      const initData = Buffer.alloc(5);
      initData.writeUInt32LE(fileData.length, 0);
      initData.writeUInt8(transferSize, 4);

      const initReq = buildReq(FILE_SVC.INITIATE_DOWNLOAD, fPath, initData);
      const initResp = await sendReq(initReq);
      if (initResp.status !== 0) {
        throw new Error(`Initiate Download failed: ${cipStatusText(initResp.status)}`);
      }

      // Transfer data in chunks
      let offset = 0;
      let transferNumber = 0;

      while (offset < fileData.length) {
        const chunkSize = Math.min(transferSize, fileData.length - offset);
        const isLast = offset + chunkSize >= fileData.length;

        const chunk = Buffer.alloc(1 + chunkSize);
        chunk.writeUInt8(transferNumber & 0xFF, 0);
        fileData.copy(chunk, 1, offset, offset + chunkSize);

        const service = FILE_SVC.DOWNLOAD_TRANSFER;
        const transferReq = buildReq(service, fPath, chunk);
        const transferResp = await sendReq(transferReq);

        if (transferResp.status !== 0 && transferResp.status !== 0x06) {
          throw new Error(`Download transfer ${transferNumber} failed: ${cipStatusText(transferResp.status)}`);
        }

        offset += chunkSize;
        transferNumber++;

        const pct = Math.round((offset / fileData.length) * 100);
        node.status({ fill: "blue", shape: "dot", text: `downloading ${pct}%` });
      }

      return { success: true, size: fileData.length, transfers: transferNumber };
    }

    /**
     * List available file instances.
     */
    async function listFiles(): Promise<any[]> {
      const files: any[] = [];

      // Try instances 1-20 (typical range)
      for (let i = 1; i <= 20; i++) {
        try {
          const p = buildPath(FILE_OBJECT_CLASS, i, FILE_ATTR.STATE);
          const { status, data } = await sendReq(buildReq(0x0e, p));
          if (status === 0 && data.length >= 1) {
            const state = data.readUInt8(0);
            if (state > 0 && state < 255) {
              const info = await readFileInfo(i);
              files.push(info);
            }
          }
        } catch (_) {
          // Instance doesn't exist, skip
          break; // Assume contiguous instances
        }
      }

      return files;
    }

    // Connection lifecycle
    node.on("cip:connected", function () { node.status(STATUS.connected()); });
    node.on("cip:connecting", function () { node.status(STATUS.connecting()); });
    node.on("cip:error", function () {
      node.status({ fill: "red", shape: "ring", text: "connection error" });
    });
    node.on("cip:disconnected", function () { node.status(STATUS.disconnected()); });

    node.on("input", async function (msg: any) {
      if (!node.endpoint.connected) {
        node.error("Not connected", msg);
        return;
      }
      if (node._busy) { node.warn("Transfer in progress"); return; }

      node._busy = true;

      try {
        const command = msg.command || msg.topic || "info";
        const instance = msg.instance || node._fileInstance;

        switch (command) {
          case "info": {
            const { result, elapsed } = await withTiming(() => readFileInfo(instance));
            result.elapsed = elapsed;
            msg.payload = result;
            node.status({ fill: "green", shape: "dot", text: `${result.fileName || `file ${instance}`}` });
            break;
          }

          case "list": {
            const { result, elapsed } = await withTiming(() => listFiles());
            msg.payload = {
              success: true,
              command: "list",
              files: result,
              count: result.length,
              elapsed,
              timestamp: Date.now(),
            };
            node.status({ fill: "green", shape: "dot", text: `${result.length} files` });
            break;
          }

          case "upload": {
            node.status({ fill: "blue", shape: "dot", text: "uploading..." });
            const { result, elapsed } = await withTiming(async () => {
              const { data, info } = await uploadFile(instance);
              return { data, info };
            });

            msg.payload = {
              success: true,
              command: "upload",
              data: result.data,
              size: result.data.length,
              info: result.info,
              elapsed,
              timestamp: Date.now(),
            };

            // Save to file if path specified
            if (msg.savePath) {
              fs.writeFileSync(msg.savePath, result.data);
              msg.payload.savedTo = msg.savePath;
            }

            node.status({ fill: "green", shape: "dot", text: `uploaded ${result.data.length}B` });
            break;
          }

          case "download": {
            let fileData: Buffer;

            if (Buffer.isBuffer(msg.payload)) {
              fileData = msg.payload;
            } else if (typeof msg.payload === "string" && msg.payload.length > 0) {
              // Try as file path first
              if (fs.existsSync(msg.payload)) {
                fileData = fs.readFileSync(msg.payload);
              } else {
                // Treat as hex string
                fileData = Buffer.from(msg.payload.replace(/[\s,]/g, ""), "hex");
              }
            } else if (msg.filePath && fs.existsSync(msg.filePath)) {
              fileData = fs.readFileSync(msg.filePath);
            } else {
              throw new Error("No file data provided. Set msg.payload (Buffer/path) or msg.filePath");
            }

            node.status({ fill: "blue", shape: "dot", text: "downloading..." });
            const { result, elapsed } = await withTiming(() => downloadFile(instance, fileData));
            result.elapsed = elapsed;
            result.command = "download";
            result.timestamp = Date.now();
            msg.payload = result;
            node.status({ fill: "green", shape: "dot", text: `downloaded ${fileData.length}B` });
            break;
          }

          default:
            msg.payload = {
              success: false,
              error: `Unknown command: ${command}. Use: info, list, upload, download`,
            };
            node.status({ fill: "yellow", shape: "ring", text: "unknown cmd" });
        }

        node.send(msg);
      } catch (err: any) {
        msg.payload = { success: false, error: err.message };
        node.error(`File error: ${err.message}`, msg);
        node.status(STATUS.error(err.message));
        node.send(msg);
      } finally {
        node._busy = false;
      }
    });

    node.endpoint.register(node);

    node.on("close", function (done: () => void) {
      if (node.endpoint) node.endpoint.deregister(node);
      done();
    });
  }

  RED.nodes.registerType("cip-file", CipFileNode);
};
