"use strict";
/**
 * CIP Discover node -- discovers EtherNet/IP devices on the network.
 * Sends a ListIdentity (0x0063) broadcast via UDP and collects responses.
 * Standalone node: does not require a cip-endpoint connection.
 * @module cip-discover
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const dgram = __importStar(require("dgram"));
const utils_1 = require("./utils");
const EIP_PORT = 44818;
const ENCAP_COMMAND_LIST_IDENTITY = 0x0063;
const ENCAP_HEADER_SIZE = 24;
/**
 * Build a ListIdentity encapsulation packet (24-byte header, empty body).
 */
function buildListIdentityPacket() {
    const buf = Buffer.alloc(ENCAP_HEADER_SIZE);
    buf.writeUInt16LE(ENCAP_COMMAND_LIST_IDENTITY, 0); // command
    buf.writeUInt16LE(0, 2); // data length
    buf.writeUInt32LE(0, 4); // session handle
    buf.writeUInt32LE(0, 8); // status
    buf.fill(0, 12, 20); // sender context
    buf.writeUInt32LE(0, 20); // options
    return buf;
}
/**
 * Parse a ListIdentity response into a DiscoveredDevice.
 * Response layout (after 24-byte encap header):
 *   itemCount(2) + itemTypeCode(2) + itemLength(2) + body...
 * Body:
 *   encapProtocol(2) + socketAddr(16) + vendorId(2) + deviceType(2) +
 *   productCode(2) + majorRev(1) + minorRev(1) + status(2) + serial(4) +
 *   nameLen(1) + name(N) + state(1)
 */
function parseListIdentityResponse(data, remoteAddress) {
    try {
        if (data.length < ENCAP_HEADER_SIZE + 6)
            return null;
        const command = data.readUInt16LE(0);
        if (command !== (ENCAP_COMMAND_LIST_IDENTITY | 0x0000) &&
            command !== ENCAP_COMMAND_LIST_IDENTITY) {
            // Not a ListIdentity response (reply command is same as request for ListIdentity)
        }
        let offset = ENCAP_HEADER_SIZE;
        // Item count
        const itemCount = data.readUInt16LE(offset);
        offset += 2;
        if (itemCount < 1)
            return null;
        // Item type code + item length
        const _itemTypeCode = data.readUInt16LE(offset);
        offset += 2;
        const _itemLength = data.readUInt16LE(offset);
        offset += 2;
        // Encapsulation protocol version
        const _encapProtocol = data.readUInt16LE(offset);
        offset += 2;
        // Socket address (16 bytes): sin_family(2) + port(2) + ip(4) + zeros(8)
        const _sinFamily = data.readInt16BE(offset);
        offset += 2;
        const port = data.readUInt16BE(offset);
        offset += 2;
        const ipBytes = data.slice(offset, offset + 4);
        const _ip = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
        offset += 4;
        offset += 8; // zeros
        // Device identity
        if (offset + 14 > data.length)
            return null;
        const vendorId = data.readUInt16LE(offset);
        offset += 2;
        const deviceType = data.readUInt16LE(offset);
        offset += 2;
        const productCode = data.readUInt16LE(offset);
        offset += 2;
        const majorRev = data.readUInt8(offset);
        offset += 1;
        const minorRev = data.readUInt8(offset);
        offset += 1;
        const status = data.readUInt16LE(offset);
        offset += 2;
        const serial = data.readUInt32LE(offset);
        offset += 4;
        // Product name (length-prefixed string)
        if (offset >= data.length)
            return null;
        const nameLen = data.readUInt8(offset);
        offset += 1;
        let productName = "";
        if (nameLen > 0 && offset + nameLen <= data.length) {
            productName = data.slice(offset, offset + nameLen).toString("ascii");
        }
        return {
            address: remoteAddress,
            port,
            vendorId,
            deviceType,
            productCode,
            revision: `${majorRev}.${minorRev}`,
            status,
            serial: serial.toString(16).toUpperCase().padStart(8, "0"),
            productName,
        };
    }
    catch (_err) {
        return null;
    }
}
module.exports = function (RED) {
    function CipDiscoverNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.broadcastAddress = config.broadcastAddress || "255.255.255.255";
        node.timeout = parseInt(config.timeout, 10) || 3000;
        node._discovering = false;
        node.status(utils_1.STATUS.idle());
        node.on("input", function (msg) {
            if (node._discovering) {
                node.warn("Discovery already in progress");
                return;
            }
            const targetAddress = msg.address || null;
            const broadcastAddr = targetAddress || node.broadcastAddress;
            const timeout = (msg.timeout && parseInt(msg.timeout, 10) > 0)
                ? parseInt(msg.timeout, 10)
                : node.timeout;
            node._discovering = true;
            node.status({
                fill: "blue",
                shape: "dot",
                text: "discovering...",
            });
            const devices = [];
            const seenAddresses = new Set();
            let socket = null;
            let timeoutHandle = null;
            function cleanup() {
                node._discovering = false;
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                if (socket) {
                    try {
                        socket.close();
                    }
                    catch (_e) {
                        // ignore
                    }
                    socket = null;
                }
            }
            function finish() {
                cleanup();
                const statusText = `found ${devices.length} device${devices.length !== 1 ? "s" : ""}`;
                node.status({
                    fill: devices.length > 0 ? "green" : "yellow",
                    shape: "dot",
                    text: statusText,
                });
                node.send({
                    payload: devices,
                    deviceCount: devices.length,
                    broadcastAddress: broadcastAddr,
                    timestamp: Date.now(),
                    _msgid: msg._msgid,
                    topic: msg.topic,
                });
            }
            try {
                socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
                socket.on("error", (err) => {
                    node.error(`Discovery error: ${err.message}`, msg);
                    node.status(utils_1.STATUS.error(err.message));
                    cleanup();
                });
                socket.on("message", (data, rinfo) => {
                    const key = `${rinfo.address}:${rinfo.port}`;
                    if (seenAddresses.has(key))
                        return;
                    const device = parseListIdentityResponse(data, rinfo.address);
                    if (device) {
                        seenAddresses.add(key);
                        devices.push(device);
                    }
                });
                socket.bind(0, () => {
                    if (!socket)
                        return;
                    try {
                        socket.setBroadcast(true);
                    }
                    catch (_e) {
                        // setBroadcast may fail on some platforms for unicast targets
                    }
                    const packet = buildListIdentityPacket();
                    socket.send(packet, 0, packet.length, EIP_PORT, broadcastAddr, (err) => {
                        if (err) {
                            node.error(`Failed to send ListIdentity: ${err.message}`, msg);
                            node.status(utils_1.STATUS.error(err.message));
                            cleanup();
                            return;
                        }
                    });
                    // Wait for responses until timeout
                    timeoutHandle = setTimeout(finish, timeout);
                });
            }
            catch (err) {
                node.error(`Discovery failed: ${err.message}`, msg);
                node.status(utils_1.STATUS.error(err.message));
                cleanup();
            }
        });
        node.on("close", function (done) {
            node._discovering = false;
            done();
        });
    }
    RED.nodes.registerType("cip-discover", CipDiscoverNode);
};
//# sourceMappingURL=cip-discover.js.map