/**
 * CIP I/O Scanner node — implicit (Class 1 UDP) messaging for cyclic I/O.
 *
 * Establishes an I/O connection via ForwardOpen over TCP, then exchanges
 * cyclic data via UDP using Assembly Objects.
 *
 * @module cip-io-scanner
 */

import * as dgram from "dgram";
import * as net from "net";
import { CipIOScannerConfig } from "./types";
import { STATUS } from "./utils";

const ENCAP_HEADER_LEN = 24;
const EIP_PORT = 44818;
const IO_UDP_PORT_DEFAULT = 2222; // EtherNet/IP implicit messaging port

module.exports = function (RED: any) {
  function CipIOScannerNode(this: any, config: CipIOScannerConfig) {
    RED.nodes.createNode(this, config);
    const node = this;

    node._targetAddress = config.targetAddress || "";
    node._targetPort = parseInt(config.targetPort, 10) || EIP_PORT;
    node._rpi = parseInt(config.rpi, 10) || 100; // ms
    node._inputAssembly = parseInt(config.inputAssembly, 10) || 100;
    node._outputAssembly = parseInt(config.outputAssembly, 10) || 150;
    node._configAssembly = parseInt(config.configAssembly, 10) || 0;
    node._inputSize = parseInt(config.inputSize, 10) || 32;
    node._outputSize = parseInt(config.outputSize, 10) || 32;
    node._udpPort = parseInt(config.udpPort, 10) || IO_UDP_PORT_DEFAULT;
    // ODVA O→T connections (drives, exclusive-owner I/O) expect a 32-bit
    // Run/Idle header ahead of the output assembly. Default on; required for
    // PowerFlex drives to leave Idle and act on the output assembly.
    node._runIdleHeader = config.runIdleHeader !== false;
    node._runMode = true; // Run = drive acts on outputs; Idle = drive ignores them

    node._tcpSocket = null as net.Socket | null;
    node._udpSocket = null as dgram.Socket | null;
    node._sessionHandle = 0;
    node._otConnectionId = 0;  // O→T (our output → target)
    node._toConnectionId = 0;  // T→O (target output → our input)
    node._connectionSerial = Math.floor(Math.random() * 0xFFFF);
    node._seqCount = 0;
    node._active = false;
    node._closing = false;
    node._ioTimer = null as ReturnType<typeof setInterval> | null;
    node._timeoutTimer = null as ReturnType<typeof setTimeout> | null;
    node._lastInputData = null as Buffer | null;
    node._outputData = Buffer.alloc(node._outputSize);
    node._rxBuffer = Buffer.alloc(0);

    if (!node._targetAddress) {
      node.status(STATUS.error("no target address"));
      return;
    }

    // ── ENIP helpers ──

    function buildEncapHeader(cmd: number, dataLen: number, session: number): Buffer {
      const hdr = Buffer.alloc(ENCAP_HEADER_LEN);
      hdr.writeUInt16LE(cmd, 0);
      hdr.writeUInt16LE(dataLen, 2);
      hdr.writeUInt32LE(session, 4);
      return hdr;
    }

    function buildRegisterSession(): Buffer {
      const data = Buffer.alloc(4);
      data.writeUInt16LE(1, 0);
      data.writeUInt16LE(0, 2);
      return Buffer.concat([buildEncapHeader(0x0065, 4, 0), data]);
    }

    // Build ForwardOpen for Class 1 (implicit) I/O connection
    function buildForwardOpen(): Buffer {
      // CIP path to Connection Manager (class 0x06, instance 1)
      const cmPath = Buffer.from([0x20, 0x06, 0x24, 0x01]);

      const rpiMicroseconds = node._rpi * 1000;

      // ForwardOpen service data
      // Using fixed connection params for Class 1 transport
      const foData = Buffer.alloc(40);
      let off = 0;

      // Priority/Time_tick (1) + Time_out_ticks (1)
      foData.writeUInt8(0x0A, off++); // priority + time_tick
      foData.writeUInt8(0xF0, off++); // timeout_ticks (240 * 2^10 = ~246ms)

      // O→T Connection ID (we assign)
      node._otConnectionId = 0x20000000 + (node._connectionSerial & 0xFFFF);
      foData.writeUInt32LE(node._otConnectionId, off); off += 4;

      // T→O Connection ID (we assign, target fills)
      node._toConnectionId = 0x30000000 + (node._connectionSerial & 0xFFFF);
      foData.writeUInt32LE(node._toConnectionId, off); off += 4;

      // Connection Serial Number
      foData.writeUInt16LE(node._connectionSerial, off); off += 2;

      // Originator Vendor ID
      foData.writeUInt16LE(0x0001, off); off += 2;

      // Originator Serial Number
      foData.writeUInt32LE(0x12345678, off); off += 4;

      // Connection Timeout Multiplier
      foData.writeUInt8(0x03, off++); // 8x

      // Reserved (3 bytes)
      off += 3;

      // O→T RPI (microseconds)
      foData.writeUInt32LE(rpiMicroseconds, off); off += 4;

      // O→T Network Connection Parameters (16-bit)
      // Point-to-point, Class 1, Fixed size. When the 32-bit Run/Idle header
      // is used, the negotiated connection size must include those 4 bytes.
      const otSize = node._outputSize + (node._runIdleHeader ? 4 : 0);
      const otConnParams = (otSize & 0x01FF) | 0x4000; // Fixed, Class 1
      foData.writeUInt16LE(otConnParams, off); off += 2;

      // T→O RPI (microseconds)
      foData.writeUInt32LE(rpiMicroseconds, off); off += 4;

      // T→O Network Connection Parameters
      const toConnParams = (node._inputSize & 0x01FF) | 0x4000; // Fixed, Class 1
      foData.writeUInt16LE(toConnParams, off); off += 2;

      // Transport Type/Trigger: Class 1, Cyclic, Server
      foData.writeUInt8(0x01, off++); // Direction=client, Class 1

      // Connection Path
      // → Config assembly (optional), → Output assembly, → Input assembly
      const pathSegments: Buffer[] = [];

      if (node._configAssembly > 0) {
        // Config: class 0x04 (Assembly), instance = configAssembly
        pathSegments.push(Buffer.from([0x20, 0x04, 0x24, node._configAssembly & 0xFF]));
      }

      // Output (O→T): class 0x04, instance = outputAssembly
      pathSegments.push(Buffer.from([0x20, 0x04, 0x24, node._outputAssembly & 0xFF]));

      // Input (T→O): class 0x04, instance = inputAssembly
      pathSegments.push(Buffer.from([0x20, 0x04, 0x24, node._inputAssembly & 0xFF]));

      const connPath = Buffer.concat(pathSegments);

      // Connection path size in words. The connection path follows immediately
      // — there is NO reserved/pad byte between the path size and the path in a
      // Forward_Open. (A stray pad byte here shifts the path by one octet and
      // leaves a trailing byte, which targets reject as CIP 0x15 "too much data".)
      foData.writeUInt8(connPath.length / 2, off++);

      // Build complete CIP request
      // Service(1) + PathSize(1) + Path(4) + ForwardOpenData + ConnectionPath
      const cipReq = Buffer.alloc(2 + cmPath.length + off + connPath.length);
      let reqOff = 0;
      cipReq.writeUInt8(0x54, reqOff++); // ForwardOpen service
      cipReq.writeUInt8(cmPath.length / 2, reqOff++);
      cmPath.copy(cipReq, reqOff); reqOff += cmPath.length;
      foData.copy(cipReq, reqOff, 0, off); reqOff += off;
      connPath.copy(cipReq, reqOff);

      // Wrap in SendRRData
      const cpfLen = 4 + 2 + 2 + 4 + 4 + cipReq.length;
      const cpf = Buffer.alloc(cpfLen);
      let cpfOff = 0;
      cpf.writeUInt32LE(0, cpfOff); cpfOff += 4; // interface handle
      cpf.writeUInt16LE(10, cpfOff); cpfOff += 2; // timeout
      cpf.writeUInt16LE(2, cpfOff); cpfOff += 2;  // 2 items
      cpf.writeUInt16LE(0x0000, cpfOff); cpfOff += 2; // null address
      cpf.writeUInt16LE(0, cpfOff); cpfOff += 2;
      cpf.writeUInt16LE(0x00B2, cpfOff); cpfOff += 2; // UCMM
      cpf.writeUInt16LE(cipReq.length, cpfOff); cpfOff += 2;
      cipReq.copy(cpf, cpfOff);

      return Buffer.concat([buildEncapHeader(0x006F, cpf.length, node._sessionHandle), cpf]);
    }

    function buildForwardClose(): Buffer {
      const cmPath = Buffer.from([0x20, 0x06, 0x24, 0x01]);

      const fcData = Buffer.alloc(12);
      let off = 0;
      fcData.writeUInt8(0x0A, off++);
      fcData.writeUInt8(0xF0, off++);
      fcData.writeUInt16LE(node._connectionSerial, off); off += 2;
      fcData.writeUInt16LE(0x0001, off); off += 2;
      fcData.writeUInt32LE(0x12345678, off); off += 4;
      // Connection path size + reserved
      fcData.writeUInt8(0x03, off++);
      fcData.writeUInt8(0x00, off++);
      // Connection path: 0x01/slot
      const connPath = Buffer.from([0x01, 0x00, 0x20, 0x04, 0x24, node._inputAssembly & 0xFF]);

      const cipReq = Buffer.alloc(2 + cmPath.length + fcData.length + connPath.length);
      let reqOff = 0;
      cipReq.writeUInt8(0x4E, reqOff++); // ForwardClose
      cipReq.writeUInt8(cmPath.length / 2, reqOff++);
      cmPath.copy(cipReq, reqOff); reqOff += cmPath.length;
      fcData.copy(cipReq, reqOff); reqOff += fcData.length;
      connPath.copy(cipReq, reqOff);

      // Wrap in SendRRData
      const cpfLen = 4 + 2 + 2 + 4 + 4 + cipReq.length;
      const cpf = Buffer.alloc(cpfLen);
      let cpfOff = 0;
      cpf.writeUInt32LE(0, cpfOff); cpfOff += 4;
      cpf.writeUInt16LE(10, cpfOff); cpfOff += 2;
      cpf.writeUInt16LE(2, cpfOff); cpfOff += 2;
      cpf.writeUInt16LE(0x0000, cpfOff); cpfOff += 2;
      cpf.writeUInt16LE(0, cpfOff); cpfOff += 2;
      cpf.writeUInt16LE(0x00B2, cpfOff); cpfOff += 2;
      cpf.writeUInt16LE(cipReq.length, cpfOff); cpfOff += 2;
      cipReq.copy(cpf, cpfOff);

      return Buffer.concat([buildEncapHeader(0x006F, cpf.length, node._sessionHandle), cpf]);
    }

    // Build UDP output packet (Sequenced Address + Connected Data)
    function buildUDPOutputPacket(): Buffer {
      node._seqCount++;
      const seqCount = node._seqCount & 0xFFFFFFFF;

      // CPF: 2 items
      // Item 1: Sequenced Address (type=0x8002) = connID(4) + seqNum(4)
      // Item 2: Connected Data (type=0x00B1) = seqCount(2) [+ Run/Idle hdr(4)] + data
      const headerLen = node._runIdleHeader ? 4 : 0;
      const connDataLen = 2 + headerLen + node._outputSize;
      const totalLen = 2 + (2+2+8) + (2+2+connDataLen);
      const buf = Buffer.alloc(totalLen);
      let off = 0;

      buf.writeUInt16LE(2, off); off += 2; // item count
      // Item 1: Sequenced Address
      buf.writeUInt16LE(0x8002, off); off += 2;
      buf.writeUInt16LE(8, off); off += 2;
      buf.writeUInt32LE(node._otConnectionId, off); off += 4;
      buf.writeUInt32LE(seqCount, off); off += 4;
      // Item 2: Connected Data
      buf.writeUInt16LE(0x00B1, off); off += 2;
      buf.writeUInt16LE(connDataLen, off); off += 2;
      buf.writeUInt16LE(node._seqCount & 0xFFFF, off); off += 2;
      // 32-bit Run/Idle header (bit 0: 1=Run, 0=Idle). Without this set to Run,
      // ODVA drives keep the output assembly idle and never act on commands.
      if (node._runIdleHeader) {
        buf.writeUInt32LE(node._runMode ? 1 : 0, off); off += 4;
      }
      node._outputData.copy(buf, off);

      return buf;
    }

    // ── Connection lifecycle ──

    async function startConnection(): Promise<void> {
      if (node._closing) return;
      node.status({ fill: "yellow", shape: "ring", text: "connecting..." });

      try {
        // 1. TCP: RegisterSession
        await tcpConnect();
        // 2. TCP: ForwardOpen for I/O
        await sendForwardOpen();
        // 3. Start UDP I/O
        startUDPIO();

        node._active = true;
        node.status({ fill: "green", shape: "dot", text: "I/O active" });
        node.log(`I/O connection established: ${node._targetAddress} ` +
          `input=Asm${node._inputAssembly}(${node._inputSize}B) ` +
          `output=Asm${node._outputAssembly}(${node._outputSize}B) ` +
          `runIdleHeader=${node._runIdleHeader ? "on" : "off"} ` +
          `RPI=${node._rpi}ms`);
      } catch (err: any) {
        node.error(`I/O connection failed: ${err.message}`);
        node.status(STATUS.error(err.message));
        cleanup();
        // Retry after 5 seconds
        if (!node._closing) {
          setTimeout(() => startConnection(), 5000);
        }
      }
    }

    function tcpConnect(): Promise<void> {
      return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        node._tcpSocket = socket;
        node._rxBuffer = Buffer.alloc(0);

        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("TCP connect timeout"));
        }, 5000);

        socket.connect(node._targetPort, node._targetAddress, () => {
          clearTimeout(timeout);
          socket.write(buildRegisterSession());
        });

        socket.on("data", (chunk: Buffer) => {
          node._rxBuffer = Buffer.concat([node._rxBuffer, chunk]);

          while (node._rxBuffer.length >= ENCAP_HEADER_LEN) {
            const dataLen = node._rxBuffer.readUInt16LE(2);
            const totalLen = ENCAP_HEADER_LEN + dataLen;
            if (node._rxBuffer.length < totalLen) break;

            const pkt = node._rxBuffer.slice(0, totalLen);
            node._rxBuffer = node._rxBuffer.slice(totalLen);

            const cmd = pkt.readUInt16LE(0);
            if (cmd === 0x0065) {
              node._sessionHandle = pkt.readUInt32LE(4);
              resolve();
            }
          }
        });

        socket.on("error", (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    }

    function sendForwardOpen(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (!node._tcpSocket) return reject(new Error("No TCP socket"));

        const timeout = setTimeout(() => {
          reject(new Error("ForwardOpen timeout"));
        }, 5000);

        // Listen for ForwardOpen response
        const onData = (chunk: Buffer) => {
          node._rxBuffer = Buffer.concat([node._rxBuffer, chunk]);

          while (node._rxBuffer.length >= ENCAP_HEADER_LEN) {
            const dataLen = node._rxBuffer.readUInt16LE(2);
            const totalLen = ENCAP_HEADER_LEN + dataLen;
            if (node._rxBuffer.length < totalLen) break;

            const pkt = node._rxBuffer.slice(0, totalLen);
            node._rxBuffer = node._rxBuffer.slice(totalLen);

            const cmd = pkt.readUInt16LE(0);
            if (cmd === 0x006F) {
              // Parse response - find CIP reply in UCMM
              // Skip header(24) + interface(4) + timeout(2) + itemCount(2)
              let off = ENCAP_HEADER_LEN + 8;
              while (off + 4 < pkt.length) {
                const typeId = pkt.readUInt16LE(off);
                const len = pkt.readUInt16LE(off + 2);
                off += 4;
                if (typeId === 0x00B2) {
                  // CIP reply
                  const service = pkt.readUInt8(off) & 0x7F;
                  const status = pkt.readUInt8(off + 2);
                  if (service === 0x54 && status === 0) {
                    // Extract connection IDs from ForwardOpen response
                    const cipData = pkt.slice(off + 4);
                    if (cipData.length >= 8) {
                      node._otConnectionId = cipData.readUInt32LE(0);
                      node._toConnectionId = cipData.readUInt32LE(4);
                    }
                    clearTimeout(timeout);
                    node._tcpSocket!.removeListener("data", onData);
                    resolve();
                    return;
                  } else {
                    clearTimeout(timeout);
                    node._tcpSocket!.removeListener("data", onData);
                    reject(new Error(`ForwardOpen failed: CIP status 0x${status.toString(16)}`));
                    return;
                  }
                }
                off += len;
              }
            }
          }
        };

        node._tcpSocket.on("data", onData);
        node._tcpSocket.write(buildForwardOpen());
      });
    }

    function startUDPIO(): void {
      node._udpSocket = dgram.createSocket("udp4");

      node._udpSocket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        handleUDPInput(msg);
      });

      node._udpSocket.on("error", (err: Error) => {
        node.error(`UDP error: ${err.message}`);
      });

      node._udpSocket.bind(node._udpPort, () => {
        // Start cyclic output timer
        node._ioTimer = setInterval(() => {
          if (node._active && node._udpSocket) {
            const packet = buildUDPOutputPacket();
            node._udpSocket.send(packet, 0, packet.length, IO_UDP_PORT_DEFAULT, node._targetAddress);
          }
        }, node._rpi);
      });
    }

    function handleUDPInput(msg: Buffer): void {
      // Parse CPF items
      if (msg.length < 2) return;
      const itemCount = msg.readUInt16LE(0);
      let off = 2;

      for (let i = 0; i < itemCount && off + 4 <= msg.length; i++) {
        const typeId = msg.readUInt16LE(off);
        const len = msg.readUInt16LE(off + 2);
        off += 4;

        if (typeId === 0x00B1 && len > 2) {
          // Connected Data item
          const seqCount = msg.readUInt16LE(off);
          const inputData = msg.slice(off + 2, off + len);

          resetTimeoutWatch();

          // Only emit on change
          if (!node._lastInputData || !inputData.equals(node._lastInputData)) {
            node._lastInputData = Buffer.from(inputData);
            node.send({
              payload: {
                input: inputData,
                parsed: Array.from(inputData),
                sequence: seqCount,
                timestamp: Date.now(),
              },
              assembly: node._inputAssembly,
            });
          }
        }
        off += len;
      }
    }

    function resetTimeoutWatch(): void {
      if (node._timeoutTimer) clearTimeout(node._timeoutTimer);
      node._timeoutTimer = setTimeout(() => {
        if (node._active && !node._closing) {
          node._active = false;
          node.status({ fill: "yellow", shape: "dot", text: "I/O timeout" });
          node.warn("I/O data timeout");
        }
      }, node._rpi * 4);
    }

    function cleanup(): void {
      if (node._ioTimer) { clearInterval(node._ioTimer); node._ioTimer = null; }
      if (node._timeoutTimer) { clearTimeout(node._timeoutTimer); node._timeoutTimer = null; }
      if (node._udpSocket) {
        try { node._udpSocket.close(); } catch (_) {}
        node._udpSocket = null;
      }
      if (node._tcpSocket) {
        // Try to send ForwardClose before closing
        if (node._active && node._sessionHandle) {
          try { node._tcpSocket.write(buildForwardClose()); } catch (_) {}
        }
        try { node._tcpSocket.destroy(); } catch (_) {}
        node._tcpSocket = null;
      }
      node._active = false;
      node._sessionHandle = 0;
    }

    // ── Input handler (set output data) ──

    node.on("input", function (msg: any) {
      // Run/Idle control via the 32-bit header. Lets a flow command the drive
      // into Run/Idle independently of (or without) sending new output data.
      let modeChanged = false;
      if (msg.command === "run" || msg.run === true) {
        node._runMode = true; modeChanged = true;
      } else if (msg.command === "idle" || msg.run === false) {
        node._runMode = false; modeChanged = true;
      }

      if (!node._active) {
        node.error("I/O connection not active", msg);
        return;
      }

      // Allow a pure Run/Idle toggle with no fresh output payload.
      if (msg.payload === undefined || msg.payload === null) {
        if (!modeChanged) {
          node.error("Invalid output data. Provide Buffer via msg.payload", msg);
        }
        return;
      }

      let outputData: Buffer;
      if (Buffer.isBuffer(msg.payload)) {
        outputData = msg.payload;
      } else if (msg.payload && Buffer.isBuffer(msg.payload.output)) {
        outputData = msg.payload.output;
      } else if (Array.isArray(msg.payload)) {
        outputData = Buffer.from(msg.payload);
      } else {
        node.error("Invalid output data. Provide Buffer via msg.payload", msg);
        return;
      }

      // Size check
      if (outputData.length !== node._outputSize) {
        const padded = Buffer.alloc(node._outputSize, 0);
        outputData.copy(padded, 0, 0, Math.min(outputData.length, node._outputSize));
        outputData = padded;
      }

      node._outputData = outputData;
    });

    // ── Start ──

    startConnection();

    // ── Cleanup ──

    node.on("close", function (done: () => void) {
      node._closing = true;
      cleanup();
      done();
    });
  }

  RED.nodes.registerType("cip-io-scanner", CipIOScannerNode);
};
