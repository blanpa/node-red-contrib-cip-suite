#!/usr/bin/env node
/**
 * Raw CIP debug script for Micro850.
 *
 * Tests:
 * 1. ListIdentity (UDP broadcast - no session needed)
 * 2. RegisterSession + Get Attribute All (Identity Object)
 * 3. Read a tag directly (skip readControllerProps)
 *
 * Usage: node test-micro850-raw.js [ip_address]
 */

const net = require("net");
const dgram = require("dgram");

const PLC_IP = process.argv[2] || "192.168.1.109";
const PLC_PORT = 44818;

// ── EtherNet/IP encapsulation header ──
function encapHeader(command, sessionHandle, data) {
  const hdr = Buffer.alloc(24);
  hdr.writeUInt16LE(command, 0);       // Command
  hdr.writeUInt16LE(data.length, 2);   // Data length
  hdr.writeUInt32LE(sessionHandle, 4); // Session handle
  hdr.writeUInt32LE(0, 8);            // Status
  // bytes 12-19: sender context (zeros)
  hdr.writeUInt32LE(0, 20);           // Options
  return Buffer.concat([hdr, data]);
}

// ── Commands ──
const CMD_LIST_IDENTITY = 0x0063;
const CMD_REGISTER_SESSION = 0x0065;
const CMD_SEND_RR_DATA = 0x006f;

// ── CIP Services ──
const GET_ATTRIBUTE_ALL = 0x01;
const GET_INSTANCE_ATTR_LIST = 0x55;
const READ_TAG = 0x4c;

// ──────────────────────────────────────────
// Test 1: ListIdentity via UDP
// ──────────────────────────────────────────
function testListIdentity() {
  return new Promise((resolve) => {
    console.log("\n═══ Test 1: ListIdentity (UDP) ═══");
    const sock = dgram.createSocket("udp4");
    const pkt = encapHeader(CMD_LIST_IDENTITY, 0, Buffer.alloc(0));

    sock.on("message", (msg) => {
      console.log("Response length:", msg.length, "bytes");
      console.log("Raw hex:", msg.toString("hex"));
      parseListIdentity(msg);
      sock.close();
      resolve();
    });

    sock.on("error", (err) => {
      console.log("UDP error:", err.message);
      sock.close();
      resolve();
    });

    setTimeout(() => {
      console.log("No UDP response (timeout)");
      sock.close();
      resolve();
    }, 3000);

    sock.send(pkt, 0, pkt.length, PLC_PORT, PLC_IP);
    console.log(`Sent ListIdentity to ${PLC_IP}:${PLC_PORT}`);
  });
}

function parseListIdentity(buf) {
  if (buf.length < 26) return;
  // Encap header: 24 bytes, then item count (2), then CPV item
  const itemCount = buf.readUInt16LE(24);
  console.log("Item count:", itemCount);
  if (itemCount < 1 || buf.length < 62) return;

  const cpvStart = 26;
  const typeCode = buf.readUInt16LE(cpvStart);
  const cpvLen = buf.readUInt16LE(cpvStart + 2);
  console.log("CPV type:", "0x" + typeCode.toString(16), "len:", cpvLen);

  // Identity data starts at cpvStart+4
  const id = cpvStart + 4;
  if (buf.length < id + 30) return;

  const encapVer = buf.readUInt16LE(id);
  const vendorID = buf.readUInt16LE(id + 6);
  const deviceType = buf.readUInt16LE(id + 8);
  const productCode = buf.readUInt16LE(id + 10);
  const majorRev = buf.readUInt8(id + 12);
  const minorRev = buf.readUInt8(id + 13);
  const status = buf.readUInt16LE(id + 14);
  const serial = buf.readUInt32LE(id + 16);
  const nameLen = buf.readUInt8(id + 20);
  const name = buf.slice(id + 21, id + 21 + nameLen).toString("ascii");

  console.log("\n  Encap version:", encapVer);
  console.log("  Vendor ID:", vendorID);
  console.log("  Device Type:", deviceType);
  console.log("  Product Code:", productCode);
  console.log("  Revision:", majorRev + "." + minorRev);
  console.log("  Status: 0x" + status.toString(16).padStart(4, "0"));
  console.log("  Serial: 0x" + serial.toString(16).padStart(8, "0"));
  console.log("  Product Name:", name);
}

// ──────────────────────────────────────────
// Test 2 & 3: TCP session tests
// ──────────────────────────────────────────
function testTCP() {
  return new Promise((resolve) => {
    console.log("\n═══ Test 2: RegisterSession + Get Attribute All (TCP) ═══");
    const sock = new net.Socket();
    let sessionHandle = 0;
    let step = 0;
    let recvBuf = Buffer.alloc(0);

    sock.setTimeout(5000);

    sock.on("connect", () => {
      console.log("TCP connected to", PLC_IP);
      // Send RegisterSession
      const regData = Buffer.alloc(4);
      regData.writeUInt16LE(1, 0); // Protocol version
      regData.writeUInt16LE(0, 2); // Options flags
      const pkt = encapHeader(CMD_REGISTER_SESSION, 0, regData);
      console.log("Sending RegisterSession:", pkt.toString("hex"));
      sock.write(pkt);
      step = 1;
    });

    sock.on("data", (data) => {
      recvBuf = Buffer.concat([recvBuf, data]);

      // Need at least encap header (24 bytes)
      while (recvBuf.length >= 24) {
        const dataLen = recvBuf.readUInt16LE(2);
        const totalLen = 24 + dataLen;
        if (recvBuf.length < totalLen) break;

        const pkt = recvBuf.slice(0, totalLen);
        recvBuf = recvBuf.slice(totalLen);

        const cmd = pkt.readUInt16LE(0);
        const status = pkt.readUInt32LE(8);
        console.log(`\nReceived cmd=0x${cmd.toString(16)} status=${status} len=${dataLen}`);
        console.log("Raw hex:", pkt.toString("hex"));

        if (step === 1 && cmd === CMD_REGISTER_SESSION) {
          sessionHandle = pkt.readUInt32LE(4);
          console.log("Session handle:", "0x" + sessionHandle.toString(16));

          if (status !== 0) {
            console.log("RegisterSession FAILED, status:", status);
            sock.destroy();
            resolve();
            return;
          }

          // Send Get Attribute All to Identity Object (Class 1, Instance 1)
          sendGetAttributeAll(sock, sessionHandle);
          step = 2;

        } else if (step === 2) {
          // Parse SendRRData response
          console.log("\n── Get Attribute All Response ──");
          parseSendRRDataResponse(pkt);

          // Now try reading a tag
          console.log("\n═══ Test 3: ReadTag 'Counter' ═══");
          sendReadTag(sock, sessionHandle, "Counter");
          step = 3;

        } else if (step === 3) {
          console.log("\n── ReadTag Response ──");
          parseSendRRDataResponse(pkt);

          // Try Get Instance Attribute List (tag browsing)
          console.log("\n═══ Test 4: Get Instance Attribute List (0x55) ═══");
          sendGetInstanceAttrList(sock, sessionHandle);
          step = 4;

        } else if (step === 4) {
          console.log("\n── Tag List Response ──");
          parseSendRRDataResponse(pkt);

          sock.destroy();
          resolve();
        }
      }
    });

    sock.on("timeout", () => {
      console.log("TCP timeout at step", step);
      sock.destroy();
      resolve();
    });

    sock.on("error", (err) => {
      console.log("TCP error:", err.message);
      resolve();
    });

    sock.connect(PLC_PORT, PLC_IP);
  });
}

function buildCIPPath(classId, instanceId) {
  // Logical segments: class (0x20 + ID) + instance (0x24 + ID)
  const segs = [];
  if (classId <= 0xff) {
    segs.push(Buffer.from([0x20, classId]));
  } else {
    const b = Buffer.alloc(4);
    b[0] = 0x21; b[1] = 0x00;
    b.writeUInt16LE(classId, 2);
    segs.push(b);
  }
  if (instanceId <= 0xff) {
    segs.push(Buffer.from([0x24, instanceId]));
  } else {
    const b = Buffer.alloc(4);
    b[0] = 0x25; b[1] = 0x00;
    b.writeUInt16LE(instanceId, 2);
    segs.push(b);
  }
  return Buffer.concat(segs);
}

function buildMessageRouter(service, path, data) {
  const pathWords = path.length / 2;
  const mr = Buffer.alloc(2 + path.length + data.length);
  mr[0] = service;
  mr[1] = pathWords;
  path.copy(mr, 2);
  data.copy(mr, 2 + path.length);
  return mr;
}

function buildSendRRData(sessionHandle, mrPacket) {
  // SendRRData data: interfaceHandle(4) + timeout(2) + itemCount(2) + nullAddr(4) + UCMM(4+N)
  const items = Buffer.alloc(10 + mrPacket.length);
  items.writeUInt32LE(0, 0);          // Interface handle
  items.writeUInt16LE(10, 4);         // Timeout (seconds)
  items.writeUInt16LE(2, 6);          // Item count = 2

  // Item 1: Null Address (type=0x0000, length=0)
  const nullItem = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  // Item 2: UCMM (type=0x00B2, length=N)
  const ucmmHdr = Buffer.alloc(4);
  ucmmHdr.writeUInt16LE(0x00b2, 0);
  ucmmHdr.writeUInt16LE(mrPacket.length, 2);

  const payload = Buffer.concat([items.slice(0, 8), nullItem, ucmmHdr, mrPacket]);
  return encapHeader(CMD_SEND_RR_DATA, sessionHandle, payload);
}

function sendGetAttributeAll(sock, sessionHandle) {
  const path = buildCIPPath(0x01, 0x01);  // Identity Object, Instance 1
  const mr = buildMessageRouter(GET_ATTRIBUTE_ALL, path, Buffer.alloc(0));
  const pkt = buildSendRRData(sessionHandle, mr);
  console.log("Sending Get Attribute All:", pkt.toString("hex"));
  sock.write(pkt);
}

function sendReadTag(sock, sessionHandle, tagName) {
  // ReadTag service (0x4C) with symbolic segment path
  const nameBytes = Buffer.from(tagName, "ascii");
  const padded = nameBytes.length % 2 !== 0;
  const symSeg = Buffer.alloc(2 + nameBytes.length + (padded ? 1 : 0));
  symSeg[0] = 0x91;  // ANSI Extended Symbol Segment
  symSeg[1] = nameBytes.length;
  nameBytes.copy(symSeg, 2);

  // ReadTag data: element count (UINT)
  const data = Buffer.alloc(2);
  data.writeUInt16LE(1, 0);  // Read 1 element

  const mr = buildMessageRouter(READ_TAG, symSeg, data);
  const pkt = buildSendRRData(sessionHandle, mr);
  console.log("Sending ReadTag:", pkt.toString("hex"));
  sock.write(pkt);
}

function sendGetInstanceAttrList(sock, sessionHandle) {
  // Service 0x55 on Symbol Object (class 0x6B), Instance 0
  const path = buildCIPPath(0x6b, 0x00);
  // Request attributes: 0x01 (Name), 0x02 (Type)
  const data = Buffer.alloc(6);
  data.writeUInt16LE(2, 0);    // Number of attributes
  data.writeUInt16LE(0x01, 2); // Attribute 1: Symbol Name
  data.writeUInt16LE(0x02, 4); // Attribute 2: Symbol Type
  const mr = buildMessageRouter(GET_INSTANCE_ATTR_LIST, path, data);
  const pkt = buildSendRRData(sessionHandle, mr);
  console.log("Sending GetInstanceAttrList:", pkt.toString("hex"));
  sock.write(pkt);
}

function parseSendRRDataResponse(pkt) {
  if (pkt.length < 24) return;

  const encapStatus = pkt.readUInt32LE(8);
  if (encapStatus !== 0) {
    console.log("Encapsulation error:", encapStatus);
    return;
  }

  // Find the UCMM data item
  const dataLen = pkt.readUInt16LE(2);
  if (dataLen < 6) {
    console.log("No data in response");
    return;
  }

  // Skip encap(24) + interfaceHandle(4) + timeout(2) + itemCount(2)
  let offset = 32;
  if (pkt.length < offset + 4) return;

  // Item 1: Null Address
  const item1Type = pkt.readUInt16LE(offset);
  const item1Len = pkt.readUInt16LE(offset + 2);
  offset += 4 + item1Len;

  // Item 2: UCMM
  if (pkt.length < offset + 4) return;
  const item2Type = pkt.readUInt16LE(offset);
  const item2Len = pkt.readUInt16LE(offset + 2);
  offset += 4;

  console.log("UCMM item type: 0x" + item2Type.toString(16), "len:", item2Len);

  if (pkt.length < offset + item2Len) {
    console.log("Incomplete UCMM data");
    return;
  }

  const cipData = pkt.slice(offset, offset + item2Len);
  console.log("CIP response hex:", cipData.toString("hex"));

  // Parse CIP Message Router response
  if (cipData.length < 4) return;
  const replyService = cipData[0];
  const reserved = cipData[1];
  const cipStatus = cipData[2];
  const addStatusSize = cipData[3];

  console.log("Reply service: 0x" + replyService.toString(16));
  console.log("CIP status:", cipStatus, cipStatus === 0 ? "(Success)" : "(Error 0x" + cipStatus.toString(16) + ")");

  if (addStatusSize > 0) {
    const addStatus = cipData.slice(4, 4 + addStatusSize * 2);
    console.log("Additional status:", addStatus.toString("hex"));
  }

  const responseData = cipData.slice(4 + addStatusSize * 2);
  if (responseData.length > 0) {
    console.log("Response data hex:", responseData.toString("hex"));
    console.log("Response data length:", responseData.length, "bytes");

    // Try to interpret as ASCII where possible
    const printable = responseData.toString("ascii").replace(/[^\x20-\x7e]/g, ".");
    console.log("Response data ASCII:", printable);

    // For Get Attribute All (Identity), try to parse known offsets
    if (replyService === (GET_ATTRIBUTE_ALL | 0x80) && cipStatus === 0) {
      parseIdentityResponse(responseData);
    }
    // For ReadTag response
    if (replyService === (READ_TAG | 0x80) && cipStatus === 0) {
      parseReadTagResponse(responseData);
    }
  }
}

function parseIdentityResponse(data) {
  console.log("\n  ── Identity Object Parse Attempt ──");
  console.log("  Total bytes:", data.length);

  // ControlLogix format (what st-ethernet-ip expects):
  //   offset 0-1:  Vendor ID
  //   offset 2-3:  Device Type
  //   offset 4-5:  Product Code
  //   offset 6:    Major Revision
  //   offset 7:    Minor Revision
  //   offset 8-9:  Status
  //   offset 10-13: Serial Number
  //   offset 14:   Product Name Length
  //   offset 15+:  Product Name

  if (data.length >= 15) {
    console.log("  --- ControlLogix layout ---");
    console.log("  Vendor ID:", data.readUInt16LE(0));
    console.log("  Device Type:", data.readUInt16LE(2));
    console.log("  Product Code:", data.readUInt16LE(4));
    console.log("  Major Rev:", data[6]);
    console.log("  Minor Rev:", data[7]);
    console.log("  Status: 0x" + data.readUInt16LE(8).toString(16).padStart(4, "0"));
    console.log("  Serial: 0x" + data.readUInt32LE(10).toString(16).padStart(8, "0"));
    if (data.length > 14) {
      const nameLen = data[14];
      console.log("  Name length:", nameLen);
      if (data.length >= 15 + nameLen) {
        console.log("  Product Name:", data.slice(15, 15 + nameLen).toString("ascii"));
      }
    }
  }

  // Dump byte-by-byte for manual inspection
  console.log("\n  Byte dump:");
  for (let i = 0; i < data.length; i += 16) {
    const line = data.slice(i, Math.min(i + 16, data.length));
    const hex = Array.from(line).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(line).map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".").join("");
    console.log(`  ${i.toString(16).padStart(4, "0")}: ${hex.padEnd(48)} ${ascii}`);
  }
}

function parseReadTagResponse(data) {
  if (data.length < 2) return;
  const typeCode = data.readUInt16LE(0);
  const typeNames = {
    0x00c1: "BOOL", 0x00c2: "SINT", 0x00c3: "INT", 0x00c4: "DINT",
    0x00c7: "STRING", 0x00c8: "8-BIT-STRING", 0x00ca: "REAL",
    0x00d3: "DWORD", 0x00cb: "LREAL"
  };
  const typeName = typeNames[typeCode] || "0x" + typeCode.toString(16);
  console.log("  Type:", typeName, "(0x" + typeCode.toString(16) + ")");

  const valueData = data.slice(2);
  if (typeCode === 0x00c4 && valueData.length >= 4) {
    console.log("  Value (DINT):", valueData.readInt32LE(0));
  } else if (typeCode === 0x00ca && valueData.length >= 4) {
    console.log("  Value (REAL):", valueData.readFloatLE(0));
  } else if (typeCode === 0x00c1 && valueData.length >= 1) {
    console.log("  Value (BOOL):", valueData[0] !== 0);
  } else if (typeCode === 0x00c3 && valueData.length >= 2) {
    console.log("  Value (INT):", valueData.readInt16LE(0));
  } else {
    console.log("  Value hex:", valueData.toString("hex"));
  }
}

// ── Main ──
async function main() {
  console.log("Micro850 Raw CIP Debug Tool");
  console.log("Target:", PLC_IP + ":" + PLC_PORT);

  await testListIdentity();
  await testTCP();

  console.log("\n═══ Done ═══");
}

main().catch(console.error);
