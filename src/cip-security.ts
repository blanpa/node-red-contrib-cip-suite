/**
 * CIP Security node — TLS/DTLS wrapper for CIP Security (ODVA Volume 8).
 *
 * Provides:
 * - TLS-wrapped EtherNet/IP connections (port 44818 with STARTTLS or 2221 direct TLS)
 * - Certificate-based device authentication
 * - CIP Security Object (class 0x5D) attribute access
 * - Security profiles: EtherNet/IP Confidentiality, EtherNet/IP Integrity
 *
 * @module cip-security
 */

import * as tls from "tls";
import * as fs from "fs";
import * as net from "net";
import { STATUS } from "./utils";

interface CipSecurityConfig {
  endpoint: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  securityMode: string; // 'none' | 'integrity' | 'confidentiality'
  tlsPort: string;
}

const CIP_SECURITY_CLASS = 0x5d;
const CIP_SECURITY_PROFILE_CLASS = 0x5c;

module.exports = function (RED: any) {
  function CipSecurityNode(this: any, config: CipSecurityConfig) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.endpoint = RED.nodes.getNode(config.endpoint);
    node._certPath = config.certPath || "";
    node._keyPath = config.keyPath || "";
    node._caPath = config.caPath || "";
    node._securityMode = config.securityMode || "none";
    node._tlsPort = parseInt(config.tlsPort, 10) || 2221;
    node._tlsSocket = null as tls.TLSSocket | null;
    node._busy = false;

    if (!node.endpoint) {
      node.status({ fill: "red", shape: "ring", text: "no endpoint" });
      return;
    }

    /**
     * Load TLS options from certificate files.
     */
    function loadTLSOptions(): tls.ConnectionOptions {
      const opts: tls.ConnectionOptions = {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      };

      if (node._certPath) {
        try {
          opts.cert = fs.readFileSync(node._certPath);
        } catch (e: any) {
          node.warn(`Cannot read certificate: ${e.message}`);
        }
      }

      if (node._keyPath) {
        try {
          opts.key = fs.readFileSync(node._keyPath);
        } catch (e: any) {
          node.warn(`Cannot read key: ${e.message}`);
        }
      }

      if (node._caPath) {
        try {
          opts.ca = fs.readFileSync(node._caPath);
        } catch (e: any) {
          node.warn(`Cannot read CA certificate: ${e.message}`);
        }
      }

      return opts;
    }

    /**
     * Build CIP request for Security Object attributes.
     */
    function buildSecurityObjectRequest(service: number, instance: number, attribute?: number): Buffer {
      const pathParts: number[] = [0x20, CIP_SECURITY_CLASS, 0x24, instance];
      if (attribute !== undefined) {
        pathParts.push(0x30, attribute);
      }
      const path = Buffer.from(pathParts);
      const req = Buffer.alloc(2 + path.length);
      req.writeUInt8(service, 0);
      req.writeUInt8(path.length / 2, 1);
      path.copy(req, 2);
      return req;
    }

    /**
     * Parse Security Object attributes from GetAttributeAll response.
     */
    function parseSecurityAttributes(data: Buffer): any {
      if (!data || data.length < 2) return { raw: data };

      const attrs: any = {};
      try {
        let off = 0;
        if (data.length >= off + 1) { attrs.state = data.readUInt8(off); off += 1; }
        if (data.length >= off + 2) { attrs.securityProfiles = data.readUInt16LE(off); off += 2; }
        if (data.length >= off + 1) {
          attrs.configurationCapability = data.readUInt8(off);
          off += 1;
        }
        if (data.length >= off + 1) {
          attrs.configurationState = data.readUInt8(off);
          off += 1;
        }
        // Interpret state
        const stateNames: Record<number, string> = {
          0: "Factory Default Configuration",
          1: "Configuration In Progress",
          2: "Configured",
          3: "Incomplete Configuration",
        };
        attrs.stateText = stateNames[attrs.state] || `Unknown (${attrs.state})`;

        // Security profiles bitmask
        attrs.profiles = [];
        if (attrs.securityProfiles & 0x01) attrs.profiles.push("EtherNet/IP Integrity");
        if (attrs.securityProfiles & 0x02) attrs.profiles.push("EtherNet/IP Confidentiality");
        if (attrs.securityProfiles & 0x04) attrs.profiles.push("CIP Authorization");
        if (attrs.securityProfiles & 0x08) attrs.profiles.push("CIP User Authentication");
        if (attrs.securityProfiles & 0x10) attrs.profiles.push("Resource-Constrained CIP Security");
      } catch (_) {
        attrs.parseError = true;
      }

      attrs.raw = data;
      return attrs;
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
        node.error("Not connected to PLC", msg);
        node.status({ fill: "red", shape: "ring", text: "not connected" });
        return;
      }

      if (node._busy) {
        node.warn("Request in progress");
        return;
      }

      node._busy = true;
      node.status({ fill: "yellow", shape: "dot", text: "requesting..." });

      try {
        const controller = node.endpoint.getController();
        const command = msg.command || msg.topic || "status";

        switch (command) {
          case "status":
          case "getAttributes": {
            // Read CIP Security Object attributes
            const req = buildSecurityObjectRequest(0x01, 1); // GetAttributeAll, instance 1
            const raw: Buffer = await new Promise((resolve, reject) => {
              controller.write_cip(req, false, 10, (err: any, data: Buffer) => {
                if (err) reject(err);
                else resolve(data);
              });
            });

            // Parse response
            const service = raw.readUInt8(0) & 0x7f;
            const status = raw.readUInt8(2);
            const extSize = raw.readUInt8(3);
            const respData = raw.slice(4 + extSize * 2);

            if (status !== 0) {
              msg.payload = {
                success: false,
                command,
                status,
                statusText: `CIP status 0x${status.toString(16)}`,
                note: "CIP Security Object may not be supported on this device",
              };
            } else {
              msg.payload = {
                success: true,
                command,
                security: parseSecurityAttributes(respData),
                timestamp: Date.now(),
              };
            }
            break;
          }

          case "connect-tls": {
            // Establish TLS connection
            const tlsOpts = loadTLSOptions();
            const targetAddr = node.endpoint.address;
            const targetPort = msg.port || node._tlsPort;

            try {
              node._tlsSocket = tls.connect(targetPort, targetAddr, tlsOpts, () => {
                const cipher = node._tlsSocket!.getCipher();
                const protocol = node._tlsSocket!.getProtocol();
                const cert = node._tlsSocket!.getPeerCertificate();

                msg.payload = {
                  success: true,
                  command: "connect-tls",
                  tls: {
                    protocol,
                    cipher: cipher ? cipher.name : "unknown",
                    authorized: node._tlsSocket!.authorized,
                    peerCN: cert ? cert.subject?.CN : "unknown",
                    peerOrg: cert ? cert.subject?.O : "unknown",
                    validTo: cert ? cert.valid_to : null,
                  },
                  timestamp: Date.now(),
                };
                node.status({ fill: "green", shape: "dot", text: `TLS: ${protocol}` });
                node.send(msg);
              });

              node._tlsSocket.on("error", (err: Error) => {
                node.error(`TLS error: ${err.message}`);
                msg.payload = {
                  success: false,
                  command: "connect-tls",
                  error: err.message,
                };
                node.send(msg);
              });

              // Don't send here - the callback above will send
              node._busy = false;
              return;
            } catch (err: any) {
              msg.payload = {
                success: false,
                command: "connect-tls",
                error: err.message,
              };
            }
            break;
          }

          case "disconnect-tls": {
            if (node._tlsSocket) {
              node._tlsSocket.destroy();
              node._tlsSocket = null;
            }
            msg.payload = { success: true, command: "disconnect-tls" };
            break;
          }

          case "getProfiles": {
            // Read Security Profile Object
            const req = buildSecurityObjectRequest(0x01, 1);
            const raw: Buffer = await new Promise((resolve, reject) => {
              controller.write_cip(req, false, 10, (err: any, data: Buffer) => {
                if (err) reject(err);
                else resolve(data);
              });
            });
            const status = raw.readUInt8(2);
            const extSize = raw.readUInt8(3);
            const respData = raw.slice(4 + extSize * 2);

            msg.payload = {
              success: status === 0,
              command,
              data: parseSecurityAttributes(respData),
              mode: node._securityMode,
              timestamp: Date.now(),
            };
            break;
          }

          default:
            msg.payload = {
              success: false,
              error: `Unknown command: ${command}. Use: status, connect-tls, disconnect-tls, getProfiles`,
            };
        }

        node.status({ fill: "green", shape: "dot", text: command });
        node.send(msg);
      } catch (err: any) {
        msg.payload = { success: false, error: err.message, timestamp: Date.now() };
        node.error(`CIP Security error: ${err.message}`, msg);
        node.status(STATUS.error(err.message));
        node.send(msg);
      } finally {
        node._busy = false;
      }
    });

    node.endpoint.register(node);

    node.on("close", function (done: () => void) {
      if (node._tlsSocket) {
        try { node._tlsSocket.destroy(); } catch (_) {}
        node._tlsSocket = null;
      }
      if (node.endpoint) node.endpoint.deregister(node);
      done();
    });
  }

  RED.nodes.registerType("cip-security", CipSecurityNode);
};
