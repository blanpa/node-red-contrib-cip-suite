"use strict";
/**
 * CIP PCCC Endpoint config node - manages a raw EtherNet/IP TCP session
 * for PCCC-over-CIP communication with SLC500, MicroLogix, and PLC-5 controllers.
 *
 * Unlike the CIP endpoint (which uses st-ethernet-ip Controller for Logix),
 * this node uses a raw net.Socket with hand-built EtherNet/IP encapsulation,
 * since PCCC devices do not support Logix CIP services.
 *
 * @module cip-pccc-endpoint
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
const net = __importStar(require("net"));
const pccc_utils_1 = require("./pccc-utils");
// EtherNet/IP encapsulation commands
const ENCAP_CMD_REGISTER_SESSION = 0x0065;
const ENCAP_CMD_SEND_RR_DATA = 0x006f;
const ENCAP_HEADER_LENGTH = 24;
module.exports = function (RED) {
    function CipPcccEndpointNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.address = config.address;
        node.port = parseInt(config.port, 10) || 44818;
        node.connTimeout = parseInt(config.connTimeout, 10) || 5000;
        node.retryInterval = parseInt(config.retryInterval, 10) || 5000;
        node._socket = null;
        node._sessionHandle = 0;
        node._tns = 0; // PCCC transaction number (1-65535)
        node.connected = false;
        node.connecting = false;
        node._closing = false;
        node._retryTimer = null;
        node._users = new Set();
        node._rxBuffer = Buffer.alloc(0);
        node._pendingRequests = new Map(); // keyed by TNS
        // ── User registration ──
        node.register = function (userNode) {
            node._users.add(userNode);
            if (node.connected) {
                userNode.emit("pccc:connected");
            }
            if (!node.connected && !node.connecting) {
                node.connect();
            }
        };
        node.deregister = function (userNode) {
            node._users.delete(userNode);
        };
        node._broadcast = function (event, data) {
            for (const u of node._users) {
                u.emit(event, data);
            }
        };
        // ── TNS management ──
        node._nextTNS = function () {
            node._tns = (node._tns % 0xffff) + 1;
            return node._tns;
        };
        // ── EtherNet/IP framing helpers ──
        function buildEncapHeader(command, dataLength, sessionHandle) {
            const header = Buffer.alloc(ENCAP_HEADER_LENGTH);
            header.writeUInt16LE(command, 0); // command
            header.writeUInt16LE(dataLength, 2); // length of data after header
            header.writeUInt32LE(sessionHandle, 4); // session handle
            header.writeUInt32LE(0, 8); // status
            // bytes 12-19: sender context (zeroed)
            header.writeUInt32LE(0, 20); // options
            return header;
        }
        function buildRegisterSessionData() {
            const data = Buffer.alloc(4);
            data.writeUInt16LE(1, 0); // protocol version
            data.writeUInt16LE(0, 2); // options flags
            return data;
        }
        function buildSendRRDataPacket(cipMessage, sessionHandle) {
            // Interface handle (4) + timeout (2) + item count (2) +
            // Null Address Item (type 2 + length 2) +
            // UCMM Data Item (type 2 + length 2 + data N)
            const itemsLength = 4 + 2 + 2 + (2 + 2) + (2 + 2 + cipMessage.length);
            const data = Buffer.alloc(itemsLength);
            let offset = 0;
            // Interface handle
            data.writeUInt32LE(0x00000000, offset);
            offset += 4;
            // Timeout
            data.writeUInt16LE(10, offset);
            offset += 2;
            // Item count
            data.writeUInt16LE(2, offset);
            offset += 2;
            // Item 1: Null Address
            data.writeUInt16LE(0x0000, offset);
            offset += 2; // type
            data.writeUInt16LE(0, offset);
            offset += 2; // length
            // Item 2: UCMM Data
            data.writeUInt16LE(0x00b2, offset);
            offset += 2; // type
            data.writeUInt16LE(cipMessage.length, offset);
            offset += 2; // length
            cipMessage.copy(data, offset);
            offset += cipMessage.length;
            const header = buildEncapHeader(ENCAP_CMD_SEND_RR_DATA, data.length, sessionHandle);
            return Buffer.concat([header, data]);
        }
        // ── Connection management ──
        node.connect = async function () {
            if (node._closing || node.connecting || node.connected)
                return;
            node.connecting = true;
            node._broadcast("pccc:connecting");
            try {
                const socket = new net.Socket();
                node._socket = socket;
                node._rxBuffer = Buffer.alloc(0);
                socket.setTimeout(node.connTimeout);
                socket.on("timeout", () => {
                    node.warn("Socket timeout");
                    socket.destroy();
                });
                socket.on("error", (err) => {
                    node.connecting = false;
                    if (node.connected) {
                        node.connected = false;
                        node.error(`Connection error: ${err.message}`);
                        node._broadcast("pccc:error", err);
                        node._broadcast("pccc:disconnected");
                    }
                    node._rejectAllPending(new Error("Connection lost"));
                    node._scheduleRetry();
                });
                socket.on("close", () => {
                    const wasConnected = node.connected;
                    node.connected = false;
                    node.connecting = false;
                    node._socket = null;
                    node._sessionHandle = 0;
                    node._rejectAllPending(new Error("Connection closed"));
                    if (wasConnected && !node._closing) {
                        node._broadcast("pccc:disconnected");
                        node._scheduleRetry();
                    }
                });
                socket.on("data", (chunk) => {
                    node._rxBuffer = Buffer.concat([node._rxBuffer, chunk]);
                    node._processRxBuffer();
                });
                socket.connect(node.port, node.address, () => {
                    // Re-arm timeout for session keepalive (detect silent disconnects)
                    socket.setTimeout(node.connTimeout * 6);
                    node._sendRegisterSession();
                });
            }
            catch (err) {
                node.connecting = false;
                node.error(`Connection failed: ${err.message}`);
                node._broadcast("pccc:error", err);
                node._scheduleRetry();
            }
        };
        node._sendRegisterSession = function () {
            const regData = buildRegisterSessionData();
            const header = buildEncapHeader(ENCAP_CMD_REGISTER_SESSION, regData.length, 0);
            const packet = Buffer.concat([header, regData]);
            if (node._socket) {
                node._socket.write(packet);
            }
        };
        node._processRxBuffer = function () {
            while (node._rxBuffer.length >= ENCAP_HEADER_LENGTH) {
                const dataLength = node._rxBuffer.readUInt16LE(2);
                const totalLength = ENCAP_HEADER_LENGTH + dataLength;
                if (node._rxBuffer.length < totalLength) {
                    break; // incomplete packet, wait for more data
                }
                const packet = node._rxBuffer.slice(0, totalLength);
                node._rxBuffer = node._rxBuffer.slice(totalLength);
                const command = packet.readUInt16LE(0);
                const status = packet.readUInt32LE(8);
                if (command === ENCAP_CMD_REGISTER_SESSION) {
                    if (status !== 0) {
                        node.connecting = false;
                        node.error(`RegisterSession failed with status 0x${status.toString(16)}`);
                        node._broadcast("pccc:error", new Error("RegisterSession failed"));
                        if (node._socket)
                            node._socket.destroy();
                        return;
                    }
                    node._sessionHandle = packet.readUInt32LE(4);
                    node.connecting = false;
                    node.connected = true;
                    node.log(`PCCC connected to ${node.address}:${node.port} (session 0x${node._sessionHandle.toString(16)})`);
                    node._broadcast("pccc:connected");
                }
                else if (command === ENCAP_CMD_SEND_RR_DATA) {
                    node._handleSendRRDataResponse(packet);
                }
            }
        };
        node._handleSendRRDataResponse = function (packet) {
            // Parse encapsulated response
            const encapStatus = packet.readUInt32LE(8);
            if (encapStatus !== 0) {
                node.warn(`SendRRData encap status: 0x${encapStatus.toString(16)}`);
                return;
            }
            // Skip encap header (24) + interface handle (4) + timeout (2) + item count (2) = 32
            let offset = ENCAP_HEADER_LENGTH + 4 + 2;
            if (offset + 2 > packet.length)
                return;
            const itemCount = packet.readUInt16LE(offset);
            offset += 2;
            // Find UCMM Data item (type 0x00B2)
            for (let i = 0; i < itemCount; i++) {
                if (offset + 4 > packet.length)
                    return;
                const typeId = packet.readUInt16LE(offset);
                offset += 2;
                const itemLength = packet.readUInt16LE(offset);
                offset += 2;
                if (typeId === 0x00b2) {
                    // CIP reply data
                    const cipReply = packet.slice(offset, offset + itemLength);
                    node._handleCIPReply(cipReply);
                    return;
                }
                offset += itemLength;
            }
        };
        node._handleCIPReply = function (cipReply) {
            // CIP reply format:
            // service(1) + reserved(1) + generalStatus(1) + addStatusSize(1) + [addStatus] + data
            if (cipReply.length < 4)
                return;
            const service = cipReply[0];
            const generalStatus = cipReply[2];
            const addStatusSize = cipReply[3]; // in 16-bit words
            const dataOffset = 4 + addStatusSize * 2;
            if (generalStatus !== 0) {
                // CIP error - extract TNS from PCCC data if possible
                const errMsg = `CIP error: service=0x${(service & 0x7f).toString(16)} status=0x${generalStatus.toString(16)}`;
                node.warn(errMsg);
                // Try to find the pending request from the PCCC response
                if (cipReply.length > dataOffset + 7) {
                    // After requester ID: cmd(1) + sts(1) + tns(2)
                    const reqIdLen = cipReply[dataOffset];
                    const pcccOffset = dataOffset + 1 + reqIdLen;
                    if (cipReply.length >= pcccOffset + 4) {
                        const tns = cipReply.readUInt16LE(pcccOffset + 2);
                        const pending = node._pendingRequests.get(tns);
                        if (pending) {
                            clearTimeout(pending.timer);
                            node._pendingRequests.delete(tns);
                            pending.reject(new Error(errMsg));
                            return;
                        }
                    }
                }
                // Reject oldest pending if we can't find TNS
                node._rejectOldest(new Error(errMsg));
                return;
            }
            if (cipReply.length <= dataOffset)
                return;
            const responseData = cipReply.slice(dataOffset);
            // Response data: requesterIdLen(1) + requesterIdData(N) + pcccPacket
            if (responseData.length < 1)
                return;
            const reqIdLen = responseData[0];
            const pcccOffset = 1 + reqIdLen;
            if (responseData.length < pcccOffset + 4)
                return;
            // PCCC reply: cmd(1) + sts(1) + tns(2) + [data]
            const pcccCmd = responseData[pcccOffset];
            const pcccSts = responseData[pcccOffset + 1];
            const pcccTns = responseData.readUInt16LE(pcccOffset + 2);
            const pending = node._pendingRequests.get(pcccTns);
            if (!pending) {
                node.warn(`Received PCCC response for unknown TNS ${pcccTns}`);
                return;
            }
            clearTimeout(pending.timer);
            node._pendingRequests.delete(pcccTns);
            if (pcccSts !== 0) {
                // PCCC STS byte: bits 0-3 = error code, bit 4 = EXT STS follows
                const errCode = pcccSts & 0x0f;
                const hasExtSts = (pcccSts & 0x10) !== 0;
                let errMsg = `PCCC error: STS=0x${pcccSts.toString(16)}`;
                if (hasExtSts && responseData.length > pcccOffset + 4) {
                    const extSts = responseData[pcccOffset + 4];
                    errMsg += ` EXT_STS=0x${extSts.toString(16)}`;
                }
                pending.reject(new Error(errMsg));
                return;
            }
            // PCCC response data starts after cmd(1) + sts(1) + tns(2) = 4 bytes
            // For typed reads, there's also FNC echo (1 byte) before data
            const pcccDataOffset = pcccOffset + 4;
            const pcccData = responseData.slice(pcccDataOffset);
            pending.resolve(pcccData);
        };
        node._rejectOldest = function (err) {
            const firstKey = node._pendingRequests.keys().next().value;
            if (firstKey !== undefined) {
                const pending = node._pendingRequests.get(firstKey);
                if (pending) {
                    clearTimeout(pending.timer);
                    node._pendingRequests.delete(firstKey);
                    pending.reject(err);
                }
            }
        };
        node._rejectAllPending = function (err) {
            for (const [tns, pending] of node._pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(err);
            }
            node._pendingRequests.clear();
        };
        // ── Public API: sendPCCC ──
        /**
         * Send a PCCC command wrapped in CIP Execute PCCC via SendRRData.
         * Returns a promise that resolves with the PCCC response data buffer.
         */
        node.sendPCCC = function (cmd, fnc, data) {
            return new Promise((resolve, reject) => {
                if (!node.connected || !node._socket) {
                    return reject(new Error("Not connected"));
                }
                const tns = node._nextTNS();
                const cipMessage = (0, pccc_utils_1.buildCIPPcccMessage)(cmd, fnc, data, tns);
                const packet = buildSendRRDataPacket(cipMessage, node._sessionHandle);
                const timer = setTimeout(() => {
                    node._pendingRequests.delete(tns);
                    reject(new Error(`PCCC request timeout (TNS=${tns})`));
                }, node.connTimeout);
                node._pendingRequests.set(tns, { resolve, reject, timer });
                try {
                    node._socket.write(packet);
                }
                catch (err) {
                    clearTimeout(timer);
                    node._pendingRequests.delete(tns);
                    reject(new Error(`Socket write error: ${err.message}`));
                }
            });
        };
        // ── Reconnection ──
        node._scheduleRetry = function () {
            if (node._closing)
                return;
            clearTimeout(node._retryTimer);
            node._retryTimer = setTimeout(() => {
                if (!node._closing) {
                    node.connect();
                }
            }, node.retryInterval);
        };
        node.disconnect = async function () {
            clearTimeout(node._retryTimer);
            node._retryTimer = null;
            node._rejectAllPending(new Error("Disconnecting"));
            if (node._socket) {
                try {
                    node._socket.destroy();
                }
                catch (_) {
                    // ignore
                }
            }
            node._socket = null;
            node._sessionHandle = 0;
            node.connected = false;
            node.connecting = false;
        };
        // ── Cleanup ──
        node.on("close", async function (done) {
            node._closing = true;
            node._broadcast("pccc:disconnected");
            await node.disconnect();
            done();
        });
    }
    RED.nodes.registerType("cip-pccc-endpoint", CipPcccEndpointNode);
};
//# sourceMappingURL=cip-pccc-endpoint.js.map