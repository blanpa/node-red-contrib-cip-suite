/**
 * CIP PCCC Read node - reads data from SLC500/MicroLogix/PLC-5 using PCCC addresses.
 *
 * Supports addresses like N7:0, F8:0, B3:0/5, T4:0.ACC, etc.
 * Can poll at a configurable interval or be triggered by incoming messages.
 *
 * @module cip-pccc-read
 */

import {
  parsePCCCAddress,
  buildPCCCReadCommand,
  parsePCCCReadResponse,
  pcccTypeName,
  PCCC_CMD,
  PCCC_FNC,
} from "./pccc-utils";
import { PCCCAddress } from "./types";
import { STATUS } from "./utils";

module.exports = function (RED: any) {
  function CipPcccReadNode(this: any, config: any) {
    RED.nodes.createNode(this, config);
    const node = this;

    node._endpoint = RED.nodes.getNode(config.endpoint);
    node._address = config.address || "";
    node._count = parseInt(config.count, 10) || 1;
    node._pollInterval = parseInt(config.pollInterval, 10) || 0;
    node._pollTimer = null as ReturnType<typeof setInterval> | null;
    node._reading = false; // backpressure flag

    if (!node._endpoint) {
      node.status(STATUS.error("no endpoint configured"));
      return;
    }

    // ── Connection events ──

    node.on("pccc:connected", () => {
      node.status(STATUS.connected());
      if (node._pollInterval > 0) {
        node._startPolling();
      }
    });

    node.on("pccc:connecting", () => {
      node.status(STATUS.connecting());
    });

    node.on("pccc:disconnected", () => {
      node.status(STATUS.disconnected());
      node._stopPolling();
    });

    node.on("pccc:error", (err: Error) => {
      node.status(STATUS.error(err.message));
    });

    // ── Read logic ──

    async function doRead(addressStr: string, count: number, msg: any) {
      if (node._reading) return; // backpressure
      node._reading = true;

      try {
        let parsedAddr: PCCCAddress;
        try {
          parsedAddr = parsePCCCAddress(addressStr);
        } catch (err: any) {
          node.error(`Invalid PCCC address "${addressStr}": ${err.message}`, msg);
          node._reading = false;
          return;
        }

        const readData = buildPCCCReadCommand(parsedAddr, count);
        const responseData = await node._endpoint.sendPCCC(
          PCCC_CMD.TYPED_LOGICAL,
          PCCC_FNC.TYPED_READ_3ADDR,
          readData
        );

        let value: any;
        if (count > 1) {
          // Parse multiple elements
          const values: any[] = [];
          const elemSize = getResponseElementSize(parsedAddr);
          for (let i = 0; i < count; i++) {
            const elemOffset = i * elemSize;
            if (elemOffset + elemSize > responseData.length) break;
            const elemBuf = responseData.slice(elemOffset, elemOffset + elemSize);
            // Create a per-element address (same type, just different element)
            const elemAddr: PCCCAddress = {
              ...parsedAddr,
              elementNumber: parsedAddr.elementNumber + i,
            };
            values.push(parsePCCCReadResponse(elemBuf, elemAddr));
          }
          value = values;
        } else {
          value = parsePCCCReadResponse(responseData, parsedAddr);
        }

        const outMsg = {
          ...msg,
          payload: value,
          address: parsedAddr.displayAddress,
          fileType: pcccTypeName(parsedAddr),
          timestamp: Date.now(),
        };
        // Remove _msgid from original msg to avoid duplicates
        delete outMsg._msgid;

        node.send(outMsg);
        node.status(STATUS.connected());
      } catch (err: any) {
        node.error(`PCCC read "${addressStr}" failed: ${err.message}`, msg);
        node.status(STATUS.error(err.message));
      } finally {
        node._reading = false;
      }
    }

    function getResponseElementSize(addr: PCCCAddress): number {
      // For timer/counter/control with sub-element, response is a single word
      if (
        (addr.fileType === 0x87 || addr.fileType === 0x88 || addr.fileType === 0x89) &&
        addr.subElement > 0
      ) {
        return 2;
      }
      return addr.elementSize;
    }

    // ── Polling ──

    node._startPolling = function () {
      node._stopPolling();
      if (node._pollInterval > 0 && node._address) {
        node._pollTimer = setInterval(() => {
          if (node._endpoint.connected) {
            doRead(node._address, node._count, {});
          }
        }, node._pollInterval);
      }
    };

    node._stopPolling = function () {
      if (node._pollTimer) {
        clearInterval(node._pollTimer);
        node._pollTimer = null;
      }
    };

    // ── Input handler ──

    node.on("input", function (msg: any) {
      if (!node._endpoint.connected) {
        node.status(STATUS.disconnected());
        node.error("Not connected to PLC", msg);
        return;
      }

      const address = msg.address || node._address;
      const count = msg.count != null ? parseInt(msg.count, 10) : node._count;

      if (!address) {
        node.error("No PCCC address specified", msg);
        return;
      }

      doRead(address, count, msg);
    });

    // ── Lifecycle ──

    node._endpoint.register(node);

    node.on("close", function (done: () => void) {
      node._stopPolling();
      if (node._endpoint) {
        node._endpoint.deregister(node);
      }
      done();
    });
  }

  RED.nodes.registerType("cip-pccc-read", CipPcccReadNode);
};
