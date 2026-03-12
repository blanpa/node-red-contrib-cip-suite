/**
 * CIP PCCC Write node - writes data to SLC500/MicroLogix/PLC-5 using PCCC addresses.
 *
 * Supports addresses like N7:0, F8:0, B3:0/5, T4:0.ACC, etc.
 * For bit addresses (B3:0/5, N7:0/3), performs a read-modify-write to preserve other bits.
 *
 * @module cip-pccc-write
 */

import {
  parsePCCCAddress,
  buildPCCCReadCommand,
  buildPCCCWriteCommand,
  parsePCCCReadResponse,
  pcccTypeName,
  PCCC_CMD,
  PCCC_FNC,
} from "./pccc-utils";
import { PCCCAddress, PCCCFileType } from "./types";
import { STATUS, setBit } from "./utils";

module.exports = function (RED: any) {
  function CipPcccWriteNode(this: any, config: any) {
    RED.nodes.createNode(this, config);
    const node = this;

    node._endpoint = RED.nodes.getNode(config.endpoint);
    node._address = config.address || "";
    node._staticValue = config.staticValue || "";
    node._useStaticValue = config.useStaticValue || false;
    node._writing = false; // backpressure flag

    if (!node._endpoint) {
      node.status(STATUS.error("no endpoint configured"));
      return;
    }

    // ── Connection events ──

    node.on("pccc:connected", () => {
      node.status(STATUS.connected());
    });

    node.on("pccc:connecting", () => {
      node.status(STATUS.connecting());
    });

    node.on("pccc:disconnected", () => {
      node.status(STATUS.disconnected());
    });

    node.on("pccc:error", (err: Error) => {
      node.status(STATUS.error(err.message));
    });

    // ── Write logic ──

    async function doWrite(addressStr: string, value: any, msg: any) {
      if (node._writing) return; // backpressure
      node._writing = true;

      let parsedAddr: PCCCAddress;
      try {
        parsedAddr = parsePCCCAddress(addressStr);
      } catch (err: any) {
        node.error(`Invalid PCCC address "${addressStr}": ${err.message}`, msg);
        node._writing = false;
        sendResult(msg, addressStr, value, false, err.message);
        return;
      }

      try {
        // Bit write: read-modify-write pattern
        if (parsedAddr.bitNumber !== null) {
          await doBitWrite(parsedAddr, value, msg);
        } else {
          // Direct write
          const writeData = buildPCCCWriteCommand(parsedAddr, value);
          await node._endpoint.sendPCCC(
            PCCC_CMD.TYPED_LOGICAL,
            PCCC_FNC.TYPED_WRITE_3ADDR,
            writeData
          );
        }

        sendResult(msg, parsedAddr.displayAddress, value, true);
        node.status(STATUS.connected());
      } catch (err: any) {
        node.error(`PCCC write "${addressStr}" failed: ${err.message}`, msg);
        node.status(STATUS.error(err.message));
        sendResult(msg, parsedAddr.displayAddress, value, false, err.message);
      } finally {
        node._writing = false;
      }
    }

    async function doBitWrite(addr: PCCCAddress, bitValue: any, msg: any) {
      // Read the current word
      const readAddr: PCCCAddress = {
        ...addr,
        bitNumber: null, // read the whole word
      };
      const readData = buildPCCCReadCommand(readAddr, 1);
      const responseData = await node._endpoint.sendPCCC(
        PCCC_CMD.TYPED_LOGICAL,
        PCCC_FNC.TYPED_READ_3ADDR,
        readData
      );

      // Parse current word value
      const currentValue = parsePCCCReadResponse(responseData, readAddr);
      if (typeof currentValue !== "number") {
        throw new Error(`Cannot perform bit write on non-numeric value at ${addr.displayAddress}`);
      }

      // Modify the bit
      const boolVal = bitValue === true || bitValue === 1 || bitValue === "1" || bitValue === "true";
      const newValue = setBit(currentValue, addr.bitNumber!, boolVal);

      // Write modified word back
      const writeData = buildPCCCWriteCommand(readAddr, newValue);
      await node._endpoint.sendPCCC(
        PCCC_CMD.TYPED_LOGICAL,
        PCCC_FNC.TYPED_WRITE_3ADDR,
        writeData
      );
    }

    function sendResult(
      msg: any,
      address: string,
      value: any,
      success: boolean,
      error?: string
    ) {
      const outMsg = {
        ...msg,
        payload: {
          success,
          address,
          value,
          ...(error ? { error } : {}),
          timestamp: Date.now(),
        },
      };
      delete outMsg._msgid;
      node.send(outMsg);
    }

    // ── Coerce value from static string to appropriate type ──

    function coerceValue(value: string, addr: PCCCAddress): any {
      switch (addr.fileType) {
        case PCCCFileType.FLOAT:
          return parseFloat(value);
        case PCCCFileType.INTEGER:
        case PCCCFileType.LONG:
        case PCCCFileType.OUTPUT:
        case PCCCFileType.INPUT:
        case PCCCFileType.STATUS:
        case PCCCFileType.COUNTER:
        case PCCCFileType.TIMER:
        case PCCCFileType.CONTROL:
          return parseInt(value, 10);
        case PCCCFileType.BIT:
          if (value === "true" || value === "1") return true;
          if (value === "false" || value === "0") return false;
          return parseInt(value, 10);
        case PCCCFileType.STRING:
        case PCCCFileType.ASCII:
          return value;
        default:
          return parseInt(value, 10);
      }
    }

    // ── Input handler ──

    node.on("input", function (msg: any) {
      if (!node._endpoint.connected) {
        node.status(STATUS.disconnected());
        node.error("Not connected to PLC", msg);
        return;
      }

      const address = msg.address || node._address;
      if (!address) {
        node.error("No PCCC address specified", msg);
        return;
      }

      let value: any;
      if (node._useStaticValue) {
        // Coerce static value based on address type
        try {
          const parsed = parsePCCCAddress(address);
          value = coerceValue(node._staticValue, parsed);
        } catch {
          value = node._staticValue;
        }
      } else {
        value = msg.payload;
      }

      if (value === undefined || value === null) {
        node.error("No value to write (msg.payload is empty)", msg);
        return;
      }

      doWrite(address, value, msg);
    });

    // ── Lifecycle ──

    node._endpoint.register(node);

    node.on("close", function (done: () => void) {
      if (node._endpoint) {
        node._endpoint.deregister(node);
      }
      done();
    });
  }

  RED.nodes.registerType("cip-pccc-write", CipPcccWriteNode);
};
