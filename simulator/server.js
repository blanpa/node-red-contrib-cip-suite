/**
 * EtherNet/IP PLC Simulator.
 * Implements the EtherNet/IP encapsulation + CIP protocol at the level
 * required by st-ethernet-ip's Controller.connect() flow:
 *   1. RegisterSession
 *   2. Forward Open (via Unconnected Send in SendRRData)
 *   3. readControllerProps via SendUnitData (connected)
 *   4. getControllerTagList via SendUnitData (connected)
 *   5. readTag / writeTag via SendUnitData (connected)
 * @module server
 */

const net = require("net");
const dgram = require("dgram");
const { createDefaultTags, CIP_TYPES } = require("./tags");
const { getProfile } = require("./profiles");
const { validateDriveForwardOpen } = require("./forward-open");

const PORT = parseInt(process.env.EIP_PORT, 10) || 44818;
const IO_UDP_PORT = parseInt(process.env.IO_UDP_PORT, 10) || 2222;
const profile = getProfile(process.env.PLC_TYPE);
const tags = createDefaultTags(profile.tagSet);
let nextSession = 1;

// Active implicit (Class 1) I/O connection state, used by the drive profiles.
const ioState = {
  active: false,
  toConnId: 0,      // T→O connection ID the drive produces on
  otConnId: 0,      // O→T connection ID the scanner produces on
  inputSize: 8,     // bytes produced on T→O
  seq: 0,
  peer: null,       // { address, port } learned from the scanner's first O→T packet
  producer: null,   // setInterval handle
  apiMs: 100,       // negotiated packet interval
};

// Simulator state for new objects
let simAxisPosition = 0.0;
let simEnergyAccumulator = 0.0;
let simPeakPower = 0.0;
let simEnergyMode = 0;
const simParams = [
  { name: "Speed", value: 50.0, type: 0xCA, min: 0, max: 100, def: 50, units: "RPM", readOnly: false },
  { name: "Temperature", value: 22.5, type: 0xCA, min: -40, max: 200, def: 20, units: "\u00B0C", readOnly: true },
  { name: "Mode", value: 0, type: 0xC7, min: 0, max: 3, def: 0, units: "", readOnly: false },
  { name: "Threshold", value: 500.0, type: 0xCA, min: 0, max: 1000, def: 500, units: "mV", readOnly: false },
  { name: "Enable", value: 1, type: 0xC1, min: 0, max: 1, def: 1, units: "", readOnly: false },
];

// Simulate changing values
setInterval(() => {
  const counter = tags.get("Counter");
  if (counter) counter.value += 1;
  const temp = tags.get("Temperature");
  if (temp) temp.value = +(20 + Math.random() * 10).toFixed(2);
  // Update axis position (slow drift)
  simAxisPosition += 0.01;
  if (simAxisPosition > 360.0) simAxisPosition -= 360.0;
  // Accumulate energy
  const currentPower = 3000 + Math.random() * 1000;
  simEnergyAccumulator += currentPower / 3600; // Wh per second tick
  if (currentPower > simPeakPower) simPeakPower = currentPower;
}, 1000);

// ─── ENIP encapsulation ─────────────────────────────────────────────

/**
 * Build a 24-byte ENIP header + data.
 * @param {number} cmd
 * @param {number} session
 * @param {Buffer} ctx - 8-byte sender context
 * @param {Buffer} data
 * @returns {Buffer}
 */
function enipPacket(cmd, session, ctx, data) {
  const hdr = Buffer.alloc(24);
  hdr.writeUInt16LE(cmd, 0);
  hdr.writeUInt16LE(data.length, 2);
  hdr.writeUInt32LE(session, 4);
  hdr.writeUInt32LE(0, 8); // status OK
  if (ctx) ctx.copy(hdr, 12, 0, 8);
  return Buffer.concat([hdr, data]);
}

// ─── CIP Message Router response builder ────────────────────────────

/**
 * Build a CIP Message Router response.
 * @param {number} service - original request service code
 * @param {number} status - general status (0 = success)
 * @param {Buffer} [serviceData] - response payload
 * @param {number} [extended] - optional 16-bit extended status word
 * @returns {Buffer}
 */
function cipResponse(service, status, serviceData, extended) {
  const data = serviceData || Buffer.alloc(0);
  if (extended !== undefined && extended !== null) {
    const hdr = Buffer.alloc(6);
    hdr.writeUInt8(service | 0x80, 0); // reply service
    hdr.writeUInt8(0, 1);              // reserved
    hdr.writeUInt8(status, 2);         // general status
    hdr.writeUInt8(1, 3);              // extended status size (1 word)
    hdr.writeUInt16LE(extended & 0xffff, 4);
    return Buffer.concat([hdr, data]);
  }
  const hdr = Buffer.alloc(4);
  hdr.writeUInt8(service | 0x80, 0); // reply service
  hdr.writeUInt8(0, 1);              // reserved
  hdr.writeUInt8(status, 2);         // general status
  hdr.writeUInt8(0, 3);              // extended status size
  return Buffer.concat([hdr, data]);
}

// ─── CPF (Common Packet Format) helpers ─────────────────────────────

/**
 * Wrap CIP reply in SendRRData CPF (Null Address + UCMM Data items).
 * @param {number} session
 * @param {Buffer} ctx
 * @param {Buffer} cipReply
 * @returns {Buffer}
 */
function sendRRDataReply(session, ctx, cipReply) {
  // interface handle(4) + timeout(2) + itemCount(2) + nullItem(4) + ucmmItem(4+data)
  const cpf = Buffer.alloc(16 + cipReply.length);
  cpf.writeUInt32LE(0, 0);          // interface handle
  cpf.writeUInt16LE(0, 4);          // timeout
  cpf.writeUInt16LE(2, 6);          // 2 items
  cpf.writeUInt16LE(0x0000, 8);     // Null Address type
  cpf.writeUInt16LE(0, 10);         // Null Address length
  cpf.writeUInt16LE(0x00b2, 12);    // UCMM data type
  cpf.writeUInt16LE(cipReply.length, 14);
  cipReply.copy(cpf, 16);
  return enipPacket(0x006f, session, ctx, cpf);
}

/**
 * Wrap CIP reply in SendUnitData CPF (Connected Address + Connected Data items).
 * @param {number} session
 * @param {Buffer} ctx
 * @param {Buffer} cipReply
 * @param {number} connId
 * @param {number} seqNum
 * @returns {Buffer}
 */
function sendUnitDataReply(session, ctx, cipReply, connId, seqNum) {
  const connDataLen = 2 + cipReply.length;
  const cpf = Buffer.alloc(20 + connDataLen);
  cpf.writeUInt32LE(0, 0);            // interface handle
  cpf.writeUInt16LE(0, 4);            // timeout
  cpf.writeUInt16LE(2, 6);            // 2 items
  cpf.writeUInt16LE(0x00a1, 8);       // Connected Address type
  cpf.writeUInt16LE(4, 10);           // 4 bytes
  cpf.writeUInt32LE(connId, 12);      // connection ID
  cpf.writeUInt16LE(0x00b1, 16);      // Connected Data type
  cpf.writeUInt16LE(connDataLen, 18); // seq(2) + data
  cpf.writeUInt16LE(seqNum, 20);      // sequence count
  cipReply.copy(cpf, 22);
  return enipPacket(0x0070, session, ctx, cpf);
}

// ─── CIP service handlers ───────────────────────────────────────────

/**
 * Handle Forward Open (0x54). Returns O->T connection ID.
 * @param {Buffer} reqData - service data from the CIP request
 * @returns {Buffer} CIP reply
 */
function handleForwardOpen(reqData) {
  // Strict AC-drive (PowerFlex 525) acceptance: validate the connection path and
  // transport the way real drive firmware does, and arm cyclic UDP I/O on success.
  if (profile.strictDriveForwardOpen && profile.ioConfig) {
    const result = validateDriveForwardOpen(reqData, profile.ioConfig);
    if (!result.ok) {
      console.log(`  ForwardOpen → REJECTED 0x${result.status.toString(16)} ` +
        `(ext 0x${result.extended.toString(16).padStart(4, "0")}): ${result.reason}`);
      return cipResponse(0x54, result.status, undefined, result.extended);
    }
    const p = result.parsed;
    ioState.otConnId = p.otConnId;
    ioState.toConnId = 0x0f520000 + (p.connSerial & 0xffff);
    ioState.inputSize = profile.ioConfig.inputSize;
    ioState.apiMs = Math.max(10, Math.round((p.toRpi || 100000) / 1000));
    ioState.active = true;
    ioState.peer = null; // learned from the first inbound O→T packet
    console.log(`  ForwardOpen → ACCEPTED (cfg=${profile.ioConfig.configInstance} ` +
      `out=${profile.ioConfig.outputInstance} in=${profile.ioConfig.inputInstance}, ` +
      `transport=0x${p.transport.toString(16)}, API=${ioState.apiMs}ms) — awaiting O→T packets`);

    const data = Buffer.alloc(26);
    data.writeUInt32LE(p.otConnId, 0);   // O→T connection ID (echo originator)
    data.writeUInt32LE(ioState.toConnId, 4); // T→O connection ID (we assign)
    data.writeUInt16LE(p.connSerial, 8);
    data.writeUInt16LE(p.vendorId, 10);
    data.writeUInt32LE(p.origSerial, 12);
    data.writeUInt32LE(p.otRpi || 100000, 16); // O→T API
    data.writeUInt32LE(p.toRpi || 100000, 20); // T→O API
    data.writeUInt8(0, 24);
    data.writeUInt8(0, 25);
    return cipResponse(0x54, 0, data);
  }

  // Extract T->O Connection ID from request (offset 4-7)
  const toConnId = reqData.length >= 8 ? reqData.readUInt32LE(4) : 0xAAAA0001;

  // Build Forward Open response data:
  // O->T ConnID(4) + T->O ConnID(4) + ConnSerial(2) + Vendor(2) + OrigSerial(4)
  // + O->T API(4) + T->O API(4) + ReplySize(1) + Reserved(1)
  const data = Buffer.alloc(26);
  data.writeUInt32LE(0xBBBB0001, 0); // O->T connection ID (our side)
  data.writeUInt32LE(toConnId, 4);    // T->O connection ID (client side)
  data.writeUInt16LE(reqData.length >= 10 ? reqData.readUInt16LE(8) : 1, 8); // conn serial
  data.writeUInt16LE(reqData.length >= 12 ? reqData.readUInt16LE(10) : 0, 10); // vendor
  data.writeUInt32LE(reqData.length >= 16 ? reqData.readUInt32LE(12) : 0, 12); // orig serial
  data.writeUInt32LE(2000, 16);       // O->T API
  data.writeUInt32LE(2000, 20);       // T->O API
  data.writeUInt8(0, 24);             // reply size
  data.writeUInt8(0, 25);             // reserved
  return cipResponse(0x54, 0, data);
}

/**
 * Handle Forward Close (0x4e).
 * @returns {Buffer}
 */
function handleForwardClose() {
  if (ioState.active) {
    stopIoProducer();
    ioState.active = false;
    console.log("  ForwardClose → I/O connection closed");
  }
  const data = Buffer.alloc(10);
  data.writeUInt16LE(1, 0);           // connection serial
  data.writeUInt16LE(0, 2);           // vendor
  data.writeUInt32LE(0, 4);           // originator serial
  data.writeUInt8(0, 8);              // reply size
  data.writeUInt8(0, 9);              // reserved
  return cipResponse(0x4e, 0, data);
}

// ─── Implicit (Class 1) UDP I/O ─────────────────────────────────────

let ioUdpSocket = null;

/**
 * Build a T→O cyclic data packet (drive → scanner): Sequenced Address item +
 * Connected Data item (seqCount + input assembly bytes). No Run/Idle header on
 * the T→O direction.
 * @returns {Buffer}
 */
function buildIoInputPacket() {
  ioState.seq = (ioState.seq + 1) & 0xffffffff;

  // Input assembly: word 0 = Logic Status (running/ready bits), word 1 = Speed
  // Feedback (ramps), remaining bytes 0. Gives the scanner changing data so it
  // emits on change.
  const input = Buffer.alloc(ioState.inputSize);
  if (ioState.inputSize >= 2) input.writeUInt16LE(0x0007, 0);           // Ready+Active+CommandedRef
  if (ioState.inputSize >= 4) input.writeUInt16LE(ioState.seq * 10 & 0xffff, 2); // speed feedback ramp

  const connDataLen = 2 + input.length;
  const total = 2 + (2 + 2 + 8) + (2 + 2 + connDataLen);
  const buf = Buffer.alloc(total);
  let off = 0;
  buf.writeUInt16LE(2, off); off += 2;                 // item count
  buf.writeUInt16LE(0x8002, off); off += 2;            // Sequenced Address item
  buf.writeUInt16LE(8, off); off += 2;
  buf.writeUInt32LE(ioState.toConnId, off); off += 4;  // T→O connection ID
  buf.writeUInt32LE(ioState.seq, off); off += 4;       // sequence number
  buf.writeUInt16LE(0x00b1, off); off += 2;            // Connected Data item
  buf.writeUInt16LE(connDataLen, off); off += 2;
  buf.writeUInt16LE(ioState.seq & 0xffff, off); off += 2; // seq count
  input.copy(buf, off);
  return buf;
}

/**
 * Parse an inbound O→T packet (scanner → drive): learn the peer, log Run/Idle.
 */
function handleIoOutputPacket(msg, rinfo) {
  if (!ioState.active) return;
  if (!ioState.peer) {
    ioState.peer = { address: rinfo.address, port: rinfo.port };
    console.log(`  [I/O] first O→T packet from ${rinfo.address}:${rinfo.port} — starting T→O production`);
    startIoProducer();
  }
  // Decode CPF to read the Run/Idle header (first 4 bytes of connected data).
  try {
    const itemCount = msg.readUInt16LE(0);
    let off = 2;
    for (let i = 0; i < itemCount && off + 4 <= msg.length; i++) {
      const typeId = msg.readUInt16LE(off);
      const len = msg.readUInt16LE(off + 2);
      off += 4;
      if (typeId === 0x00b1 && len >= 6) {
        const runIdle = msg.readUInt32LE(off + 2) & 0x01; // after 2-byte seqCount
        if (runIdle !== ioState._lastRun) {
          ioState._lastRun = runIdle;
          console.log(`  [I/O] scanner Run/Idle header = ${runIdle ? "RUN" : "IDLE"}`);
        }
      }
      off += len;
    }
  } catch (_) { /* ignore malformed */ }
}

function startIoProducer() {
  stopIoProducer();
  ioState.producer = setInterval(() => {
    if (!ioState.active || !ioState.peer || !ioUdpSocket) return;
    const pkt = buildIoInputPacket();
    ioUdpSocket.send(pkt, 0, pkt.length, ioState.peer.port, ioState.peer.address);
  }, ioState.apiMs);
  if (ioState.producer.unref) ioState.producer.unref();
}

function stopIoProducer() {
  if (ioState.producer) { clearInterval(ioState.producer); ioState.producer = null; }
}

function startIoUdpServer() {
  ioUdpSocket = dgram.createSocket("udp4");
  ioUdpSocket.on("message", handleIoOutputPacket);
  ioUdpSocket.on("error", (err) => console.error(`  [I/O] UDP error: ${err.message}`));
  ioUdpSocket.bind(IO_UDP_PORT, () => {
    console.log(`  [I/O] implicit messaging UDP listening on :${IO_UDP_PORT}`);
  });
}

/**
 * Handle GET_ATTRIBUTE_ALL (0x01) on Identity Object (class 0x01).
 * st-ethernet-ip's readControllerProps parses this.
 * @returns {Buffer}
 */
function handleGetAttributeAll() {
  // Micro800: no readControllerProps support — return error
  if (!profile.supportsReadControllerProps) {
    console.log("  GetAttributeAll on Identity Object → rejected (not supported by profile)");
    return cipResponse(0x01, 0x08); // service not supported
  }
  const name = profile.name;
  // Format expected by st-ethernet-ip controller.js readControllerProps:
  // vendor(2) + deviceType(2) + prodCode(2) + majorRev(1) + minorRev(1)
  // + status(2) + serial(4) + nameLen(1) + name(N)
  const data = Buffer.alloc(14 + 1 + name.length);
  let off = 0;
  data.writeUInt16LE(profile.vendor, off); off += 2;
  data.writeUInt16LE(profile.deviceType, off); off += 2;
  data.writeUInt16LE(profile.productCode, off); off += 2;
  data.writeUInt8(profile.majorRevision, off); off += 1;
  data.writeUInt8(profile.minorRevision, off); off += 1;
  data.writeUInt16LE(0x0000, off); off += 2;  // status
  data.writeUInt32LE(profile.serial, off); off += 4;
  data.writeUInt8(name.length, off); off += 1;
  data.write(name, off, "ascii");
  return cipResponse(0x01, 0, data);
}

/**
 * Handle GET_ATTRIBUTE_SINGLE (0x0e).
 * @returns {Buffer}
 */
function handleGetAttributeSingle() {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(0x12345678, 0);
  return cipResponse(0x0e, 0, data);
}

/**
 * Handle GET_INSTANCE_ATTRIBUTE_LIST (0x55) for tag browsing.
 * st-ethernet-ip expects: for each tag: instanceID(4) + nameLen(2) + name(N) + type(2)
 * @param {number} startInstance
 * @param {string|null} program - filter to tags belonging to this program
 * @returns {Buffer}
 */
function handleGetInstanceAttributeList(startInstance, program) {
  const tagArray = Array.from(tags.values());
  const entries = [];
  let instanceCounter = 0;

  for (let i = 0; i < tagArray.length; i++) {
    const tag = tagArray[i];

    // Filter by program scope
    if (program) {
      if (tag.program !== program) continue;
    } else {
      // Global scope: exclude program-scoped tags (they'll be fetched per-program)
      // But include them so st-ethernet-ip discovers the program names
    }

    instanceCounter++;
    if (instanceCounter < startInstance) continue;

    // For program-scoped tags, st-ethernet-ip expects the short name (without "Program:X." prefix)
    let displayName = tag.name;
    if (program && displayName.startsWith(`Program:${program}.`)) {
      displayName = displayName.substring(`Program:${program}.`.length);
    }

    const nameBytes = Buffer.from(displayName, "ascii");
    const entry = Buffer.alloc(4 + 2 + nameBytes.length + 2);
    let off = 0;
    entry.writeUInt32LE(instanceCounter, off); off += 4;
    entry.writeUInt16LE(nameBytes.length, off); off += 2;
    nameBytes.copy(entry, off); off += nameBytes.length;
    entry.writeUInt16LE(tag.type, off);
    entries.push(entry);
  }

  const allData = Buffer.concat(entries);
  return cipResponse(0x55, 0, allData);
}

/**
 * Encode a tag value as CIP read response data.
 * Format: type(2) + value bytes (no count field in read response)
 * @param {object} tag
 * @returns {Buffer}
 */
function encodeTagValue(tag) {
  let buf;
  switch (tag.type) {
    case CIP_TYPES.BOOL:
    case CIP_TYPES.SINT:
      buf = Buffer.alloc(2 + 1);
      buf.writeUInt16LE(tag.type, 0);
      buf.writeUInt8(tag.value ? 1 : 0, 2);
      return buf;
    case CIP_TYPES.INT:
      buf = Buffer.alloc(2 + 2);
      buf.writeUInt16LE(tag.type, 0);
      buf.writeInt16LE(tag.value, 2);
      return buf;
    case CIP_TYPES.DINT:
      buf = Buffer.alloc(2 + 4);
      buf.writeUInt16LE(tag.type, 0);
      buf.writeInt32LE(tag.value, 2);
      return buf;
    case CIP_TYPES.REAL:
      buf = Buffer.alloc(2 + 4);
      buf.writeUInt16LE(tag.type, 0);
      buf.writeFloatLE(tag.value, 2);
      return buf;
    default:
      buf = Buffer.alloc(2 + 4);
      buf.writeUInt16LE(CIP_TYPES.DINT, 0);
      buf.writeInt32LE(0, 2);
      return buf;
  }
}

/**
 * Parse a CIP path to extract class ID, instance ID, and optional program name.
 * Handles paths that may start with a DATA segment (for program-scoped requests).
 * @param {Buffer} buf
 * @returns {{classId: number, instanceId: number, program: string|null}}
 */
function parseClassPath(buf) {
  let offset = 0;
  let classId = 0;
  let instanceId = 0;
  let program = null;

  while (offset < buf.length) {
    const seg = buf.readUInt8(offset);
    if (seg === 0x91) {
      // DATA segment — program name
      const len = buf.readUInt8(offset + 1);
      const str = buf.toString("ascii", offset + 2, offset + 2 + len);
      if (str.startsWith("Program:")) {
        program = str.replace("Program:", "");
      }
      offset += 2 + len;
      if (len % 2 !== 0) offset += 1; // pad
    } else if (seg === 0x20) {
      classId = buf.readUInt8(offset + 1);
      offset += 2;
    } else if (seg === 0x21) {
      // 16-bit class
      offset += 1; // pad
      classId = buf.readUInt16LE(offset + 1);
      offset += 3;
    } else if (seg === 0x24) {
      instanceId = buf.readUInt8(offset + 1);
      offset += 2;
    } else if (seg === 0x25) {
      // 16-bit instance or special 0-instance marker
      if (offset + 3 < buf.length) {
        instanceId = buf.readUInt16LE(offset + 2);
        offset += 4;
      } else {
        offset += 4;
      }
    } else if (seg === 0x30) {
      offset += 2; // attribute segment
    } else {
      offset += 2; // skip unknown
    }
  }
  return { classId, instanceId, program };
}

/**
 * Parse symbolic segment (0x91) to extract tag name.
 * @param {Buffer} buf
 * @returns {{tagName: string, bytesConsumed: number}}
 */
function parseSymbolicPath(buf) {
  let offset = 0;
  let tagName = "";

  while (offset < buf.length) {
    const seg = buf.readUInt8(offset);
    if (seg === 0x91) {
      const len = buf.readUInt8(offset + 1);
      tagName += buf.toString("ascii", offset + 2, offset + 2 + len);
      offset += 2 + len;
      if (len % 2 !== 0) offset += 1; // pad
    } else if (seg === 0x28) {
      const idx = buf.readUInt8(offset + 1);
      tagName += `[${idx}]`;
      offset += 2;
    } else {
      break;
    }
  }
  return { tagName, bytesConsumed: offset };
}

/**
 * Handle a Read Tag (0x4C) or Read Tag Fragmented (0x52) request.
 * @param {number} service
 * @param {string} tagName
 * @returns {Buffer}
 */
function handleReadTag(service, tagName) {
  const tag = tags.get(tagName);
  if (!tag) {
    console.log(`  READ unknown: "${tagName}"`);
    return cipResponse(service, 0x05); // path destination unknown
  }
  console.log(`  READ ${tagName} = ${tag.value}`);
  return cipResponse(service, 0, encodeTagValue(tag));
}

/**
 * Handle a Write Tag (0x4D) request.
 * @param {number} service
 * @param {string} tagName
 * @param {Buffer} dataBuf - type(2) + count(2) + value
 * @returns {Buffer}
 */
function handleWriteTag(service, tagName, dataBuf) {
  if (dataBuf.length < 5) {
    return cipResponse(service, 0x13); // not enough data
  }
  const type = dataBuf.readUInt16LE(0);
  let value;
  switch (type) {
    case CIP_TYPES.BOOL:
    case CIP_TYPES.SINT:
      value = dataBuf.readUInt8(4);
      break;
    case CIP_TYPES.INT:
      value = dataBuf.readInt16LE(4);
      break;
    case CIP_TYPES.DINT:
      value = dataBuf.readInt32LE(4);
      break;
    case CIP_TYPES.REAL:
      value = dataBuf.readFloatLE(4);
      break;
    default:
      value = 0;
  }

  const tag = tags.get(tagName);
  if (tag) {
    tag.value = value;
    console.log(`  WRITE ${tagName} = ${value}`);
  } else {
    const typeName = Object.keys(CIP_TYPES).find((k) => CIP_TYPES[k] === type) || "DINT";
    tags.set(tagName, { name: tagName, type, typeName, value, dims: 0 });
    console.log(`  WRITE (new) ${tagName} = ${value}`);
  }
  return cipResponse(service, 0);
}

// ─── New CIP Object handlers ────────────────────────────────────────

/**
 * Handle Time Sync Object (class 0x43) requests.
 */
function handleTimeSyncObject(service, path) {
  if (service === 0x01) {
    // GetAttributeAll — simulated PTP data
    const data = Buffer.alloc(10);
    data.writeUInt8(1, 0);  // ptpEnable
    data.writeUInt8(1, 1);  // isSynchronized
    const usec = BigInt(Date.now()) * 1000n;
    data.writeBigInt64LE(usec, 2);  // systemTime microseconds
    console.log("  TIME SYNC GetAttributeAll");
    return cipResponse(0x01, 0, data);
  }
  if (service === 0x0e) {
    // GetAttributeSingle
    const attrId = extractAttributeId(path);
    let data;
    switch (attrId) {
      case 1: // PTP_ENABLE
        data = Buffer.alloc(1);
        data.writeUInt8(1, 0);
        break;
      case 2: // IS_SYNCHRONIZED
        data = Buffer.alloc(1);
        data.writeUInt8(1, 0);
        break;
      case 3: // SYSTEM_TIME_MICROSECONDS
        data = Buffer.alloc(8);
        data.writeBigInt64LE(BigInt(Date.now()) * 1000n, 0);
        break;
      case 5: // OFFSET_FROM_MASTER
        data = Buffer.alloc(8);
        data.writeBigInt64LE(BigInt(Math.floor((Math.random() - 0.5) * 200)), 0);
        break;
      case 7: // MEAN_PATH_DELAY
        data = Buffer.alloc(8);
        data.writeBigInt64LE(BigInt(100 + Math.floor(Math.random() * 900)), 0);
        break;
      case 8: { // GRANDMASTER_CLOCK_INFO
        data = Buffer.alloc(14);
        // 8-byte clockID
        data.writeBigUInt64BE(0xDEADBEEF00000001n, 0);
        data.writeUInt8(248, 8);   // class (default)
        data.writeUInt8(0xFE, 9);  // accuracy (unknown)
        data.writeUInt16LE(0xFFFF, 10); // variance
        data.writeUInt8(128, 12);  // priority1
        data.writeUInt8(128, 13);  // priority2
        break;
      }
      case 11: // NUMBER_OF_PORTS
        data = Buffer.alloc(2);
        data.writeUInt16LE(1, 0);
        break;
      case 18: // DOMAIN_NUMBER
        data = Buffer.alloc(1);
        data.writeUInt8(0, 0);
        break;
      case 19: // CLOCK_TYPE
        data = Buffer.alloc(2);
        data.writeUInt16LE(0x01, 0); // Ordinary Clock
        break;
      case 29: // TIME_SOURCE
        data = Buffer.alloc(1);
        data.writeUInt8(0xA0, 0); // Internal Oscillator
        break;
      default:
        console.log(`  TIME SYNC unknown attr ${attrId}`);
        return cipResponse(0x0e, 0x14); // attribute not supported
    }
    console.log(`  TIME SYNC GetAttributeSingle attr=${attrId}`);
    return cipResponse(0x0e, 0, data);
  }
  return cipResponse(service, 0x08);
}

/**
 * Handle CIP Security Object (class 0x5D) requests.
 */
function handleCipSecurityObject(service) {
  if (service === 0x01) {
    // GetAttributeAll — simulated security state
    const data = Buffer.alloc(5);
    data.writeUInt8(0, 0);         // state: factory default
    data.writeUInt16LE(0x03, 1);   // profiles: integrity + confidentiality
    data.writeUInt8(0x01, 3);      // configCapability
    data.writeUInt8(0, 4);         // configState
    console.log("  CIP SECURITY GetAttributeAll");
    return cipResponse(0x01, 0, data);
  }
  return cipResponse(service, 0x08);
}

/**
 * Handle Motion Axis Object (class 0x42) requests.
 */
function handleMotionAxisObject(service, path, data) {
  if (service === 0x0e) {
    // GetAttributeSingle
    const attrId = extractAttributeId(path);
    let resp;
    switch (attrId) {
      case 1: // AXIS_STATE
        resp = Buffer.alloc(1);
        resp.writeUInt8(1, 0); // Standstill
        break;
      case 3: // COMMAND_POSITION
        resp = Buffer.alloc(4);
        resp.writeFloatLE(simAxisPosition, 0);
        break;
      case 4: // COMMAND_VELOCITY
        resp = Buffer.alloc(4);
        resp.writeFloatLE(0, 0);
        break;
      case 5: // ACTUAL_POSITION
        resp = Buffer.alloc(4);
        resp.writeFloatLE(simAxisPosition, 0);
        break;
      case 6: // ACTUAL_VELOCITY
        resp = Buffer.alloc(4);
        resp.writeFloatLE(0, 0);
        break;
      case 9: // ACTUAL_TORQUE
        resp = Buffer.alloc(4);
        resp.writeFloatLE(0, 0);
        break;
      case 10: // AXIS_FAULT
        resp = Buffer.alloc(4);
        resp.writeUInt32LE(0, 0);
        break;
      case 11: // POSITION_ERROR
        resp = Buffer.alloc(4);
        resp.writeFloatLE(0.001, 0);
        break;
      default:
        console.log(`  MOTION AXIS unknown attr ${attrId}`);
        return cipResponse(0x0e, 0x14);
    }
    console.log(`  MOTION AXIS GetAttributeSingle attr=${attrId}`);
    return cipResponse(0x0e, 0, resp);
  }
  if (service === 0x10) {
    // SetAttributeSingle — accept writes
    console.log("  MOTION AXIS SetAttributeSingle");
    return cipResponse(0x10, 0);
  }
  if (service === 0x06) {
    // Start
    console.log("  MOTION AXIS Start");
    return cipResponse(0x06, 0);
  }
  if (service === 0x07) {
    // Stop
    console.log("  MOTION AXIS Stop");
    return cipResponse(0x07, 0);
  }
  if (service === 0x05) {
    // Reset
    console.log("  MOTION AXIS Reset");
    return cipResponse(0x05, 0);
  }
  return cipResponse(service, 0x08);
}

/**
 * Handle Base Energy Object (class 0x4F) requests.
 */
function handleBaseEnergyObject(service, path, data) {
  if (service === 0x0e) {
    const attrId = extractAttributeId(path);
    let resp;
    switch (attrId) {
      case 1: // ENERGY_TYPE
        resp = Buffer.alloc(1);
        resp.writeUInt8(1, 0); // Electrical AC
        break;
      case 2: // ENERGY_MODE
        resp = Buffer.alloc(1);
        resp.writeUInt8(simEnergyMode, 0);
        break;
      case 6: // NOMINAL_POWER
        resp = Buffer.alloc(4);
        resp.writeFloatLE(5000.0, 0);
        break;
      case 7: // RATED_POWER
        resp = Buffer.alloc(4);
        resp.writeFloatLE(7500.0, 0);
        break;
      case 8: { // POWER
        resp = Buffer.alloc(4);
        const pwr = 3000 + Math.random() * 1000;
        resp.writeFloatLE(pwr, 0);
        break;
      }
      case 9: // ENERGY
        resp = Buffer.alloc(4);
        resp.writeFloatLE(simEnergyAccumulator, 0);
        break;
      case 10: // PEAK_POWER
        resp = Buffer.alloc(4);
        resp.writeFloatLE(simPeakPower, 0);
        break;
      default:
        console.log(`  BASE ENERGY unknown attr ${attrId}`);
        return cipResponse(0x0e, 0x14);
    }
    console.log(`  BASE ENERGY GetAttributeSingle attr=${attrId}`);
    return cipResponse(0x0e, 0, resp);
  }
  if (service === 0x10) {
    // SetAttributeSingle — accept mode changes
    console.log("  BASE ENERGY SetAttributeSingle");
    return cipResponse(0x10, 0);
  }
  return cipResponse(service, 0x08);
}

/**
 * Handle Electrical Energy Object (class 0x4E) requests.
 */
function handleElectricalEnergyObject(service, path) {
  if (service === 0x0e) {
    const attrId = extractAttributeId(path);
    let resp;
    switch (attrId) {
      case 1: // VOLTAGE_LL
        resp = Buffer.alloc(4);
        resp.writeFloatLE(480.0 + (Math.random() - 0.5) * 5, 0);
        break;
      case 2: // VOLTAGE_LN
        resp = Buffer.alloc(4);
        resp.writeFloatLE(277.0 + (Math.random() - 0.5) * 3, 0);
        break;
      case 3: // CURRENT
        resp = Buffer.alloc(4);
        resp.writeFloatLE(8.0 + (Math.random() - 0.5) * 0.5, 0);
        break;
      case 4: // FREQUENCY
        resp = Buffer.alloc(4);
        resp.writeFloatLE(60.0 + (Math.random() - 0.5) * 0.02, 0);
        break;
      case 5: // POWER_FACTOR
        resp = Buffer.alloc(4);
        resp.writeFloatLE(0.92, 0);
        break;
      case 6: { // APPARENT_POWER
        resp = Buffer.alloc(4);
        const vln = 277.0;
        const current = 8.0;
        resp.writeFloatLE(3 * vln * current, 0); // 3-phase apparent
        break;
      }
      case 8: { // ACTIVE_POWER
        resp = Buffer.alloc(4);
        resp.writeFloatLE(3000 + Math.random() * 1000, 0);
        break;
      }
      case 9: // ACTIVE_ENERGY
        resp = Buffer.alloc(4);
        resp.writeFloatLE(simEnergyAccumulator, 0);
        break;
      default:
        console.log(`  ELECTRICAL ENERGY unknown attr ${attrId}`);
        return cipResponse(0x0e, 0x14);
    }
    console.log(`  ELECTRICAL ENERGY GetAttributeSingle attr=${attrId}`);
    return cipResponse(0x0e, 0, resp);
  }
  return cipResponse(service, 0x08);
}

/**
 * Handle File Object (class 0x37) requests.
 */
function handleFileObject(service, path, data) {
  if (service === 0x0e) {
    const attrId = extractAttributeId(path);
    let resp;
    switch (attrId) {
      case 1: // STATE
        resp = Buffer.alloc(1);
        resp.writeUInt8(2, 0); // File Loaded
        break;
      case 2: { // INSTANCE_NAME (SHORT_STRING)
        const name = "FirmwareImage";
        resp = Buffer.alloc(1 + name.length);
        resp.writeUInt8(name.length, 0);
        resp.write(name, 1, "ascii");
        break;
      }
      case 4: { // FILE_NAME (SHORT_STRING)
        const fname = "firmware_v32.bin";
        resp = Buffer.alloc(1 + fname.length);
        resp.writeUInt8(fname.length, 0);
        resp.write(fname, 1, "ascii");
        break;
      }
      case 5: // FILE_REVISION
        resp = Buffer.alloc(2);
        resp.writeUInt8(32, 0);
        resp.writeUInt8(11, 1);
        break;
      case 6: // FILE_SIZE
        resp = Buffer.alloc(4);
        resp.writeUInt32LE(1024, 0);
        break;
      case 7: // FILE_CHECKSUM
        resp = Buffer.alloc(2);
        resp.writeUInt16LE(0xABCD, 0);
        break;
      default:
        console.log(`  FILE OBJECT unknown attr ${attrId}`);
        return cipResponse(0x0e, 0x14);
    }
    console.log(`  FILE OBJECT GetAttributeSingle attr=${attrId}`);
    return cipResponse(0x0e, 0, resp);
  }
  // Upload services — return simulated firmware data
  if (service === 0x4b || service === 0x4c) {
    console.log("  FILE OBJECT Upload service");
    const fakeData = Buffer.alloc(64, 0xFF);
    return cipResponse(service, 0, fakeData);
  }
  // Download services — accept and discard
  if (service === 0x4d || service === 0x4e) {
    console.log("  FILE OBJECT Download service (accepted)");
    return cipResponse(service, 0);
  }
  return cipResponse(service, 0x08);
}

/**
 * Handle Parameter Object (class 0x0F) requests.
 */
function handleParameterObject(service, path, instanceId, data) {
  if (instanceId === 0) {
    // Class-level request
    if (service === 0x0e) {
      const attrId = extractAttributeId(path);
      if (attrId === 1) {
        // MaxInstance
        const resp = Buffer.alloc(2);
        resp.writeUInt16LE(simParams.length, 0);
        console.log("  PARAMETER class MaxInstance");
        return cipResponse(0x0e, 0, resp);
      }
    }
    return cipResponse(service, 0x14);
  }

  // Instance-level (1-5)
  const paramIdx = instanceId - 1;
  if (paramIdx < 0 || paramIdx >= simParams.length) {
    return cipResponse(service, 0x05); // path destination unknown
  }
  const param = simParams[paramIdx];

  if (service === 0x0e) {
    // GetAttributeSingle — return all parameter descriptor data
    const attrId = extractAttributeId(path);
    let resp;
    switch (attrId) {
      case 1: // VALUE
        if (param.type === 0xCA) {
          resp = Buffer.alloc(4);
          resp.writeFloatLE(param.value, 0);
        } else if (param.type === 0xC7) {
          resp = Buffer.alloc(2);
          resp.writeUInt16LE(param.value, 0);
        } else {
          resp = Buffer.alloc(1);
          resp.writeUInt8(param.value, 0);
        }
        break;
      case 2: { // DESCRIPTOR (name as SHORT_STRING)
        resp = Buffer.alloc(1 + param.name.length);
        resp.writeUInt8(param.name.length, 0);
        resp.write(param.name, 1, "ascii");
        break;
      }
      case 3: // DATA_TYPE
        resp = Buffer.alloc(2);
        resp.writeUInt16LE(param.type, 0);
        break;
      case 4: // DATA_SIZE
        if (param.type === 0xCA) {
          resp = Buffer.alloc(1);
          resp.writeUInt8(4, 0);
        } else if (param.type === 0xC7) {
          resp = Buffer.alloc(1);
          resp.writeUInt8(2, 0);
        } else {
          resp = Buffer.alloc(1);
          resp.writeUInt8(1, 0);
        }
        break;
      case 5: { // DESCRIPTOR_STRING (name)
        resp = Buffer.alloc(1 + param.name.length);
        resp.writeUInt8(param.name.length, 0);
        resp.write(param.name, 1, "ascii");
        break;
      }
      case 6: { // UNITS (SHORT_STRING)
        const u = param.units || "";
        resp = Buffer.alloc(1 + u.length);
        resp.writeUInt8(u.length, 0);
        if (u.length > 0) resp.write(u, 1, "ascii");
        break;
      }
      case 7: // MIN_VALUE
        if (param.type === 0xCA) {
          resp = Buffer.alloc(4);
          resp.writeFloatLE(param.min, 0);
        } else if (param.type === 0xC7) {
          resp = Buffer.alloc(2);
          resp.writeUInt16LE(param.min, 0);
        } else {
          resp = Buffer.alloc(1);
          resp.writeUInt8(param.min, 0);
        }
        break;
      case 8: // MAX_VALUE
        if (param.type === 0xCA) {
          resp = Buffer.alloc(4);
          resp.writeFloatLE(param.max, 0);
        } else if (param.type === 0xC7) {
          resp = Buffer.alloc(2);
          resp.writeUInt16LE(param.max, 0);
        } else {
          resp = Buffer.alloc(1);
          resp.writeUInt8(param.max, 0);
        }
        break;
      case 9: // DEFAULT_VALUE
        if (param.type === 0xCA) {
          resp = Buffer.alloc(4);
          resp.writeFloatLE(param.def, 0);
        } else if (param.type === 0xC7) {
          resp = Buffer.alloc(2);
          resp.writeUInt16LE(param.def, 0);
        } else {
          resp = Buffer.alloc(1);
          resp.writeUInt8(param.def, 0);
        }
        break;
      default:
        console.log(`  PARAMETER unknown attr ${attrId}`);
        return cipResponse(0x0e, 0x14);
    }
    console.log(`  PARAMETER inst=${instanceId} GetAttributeSingle attr=${attrId}`);
    return cipResponse(0x0e, 0, resp);
  }

  if (service === 0x10) {
    // SetAttributeSingle
    if (param.readOnly) {
      console.log(`  PARAMETER inst=${instanceId} write rejected (read-only)`);
      return cipResponse(0x10, 0x0E); // attribute not settable
    }
    console.log(`  PARAMETER inst=${instanceId} SetAttributeSingle`);
    return cipResponse(0x10, 0);
  }

  return cipResponse(service, 0x08);
}

/**
 * Extract attribute ID from a CIP path (looks for 0x30 segment).
 * @param {Buffer} path
 * @returns {number}
 */
function extractAttributeId(path) {
  for (let i = 0; i < path.length - 1; i++) {
    if (path.readUInt8(i) === 0x30) {
      return path.readUInt8(i + 1);
    }
  }
  return 0;
}

// ─── Multiple Service Packet (0x0A) ─────────────────────────────────

/**
 * Handle Multiple Service Packet — dispatches each embedded request.
 * Request data: count(2) + offsets(2*count) + embedded CIP requests
 * Response data: count(2) + offsets(2*count) + embedded CIP replies
 * @param {Buffer} data - service data (after path)
 * @returns {Buffer}
 */
function handleMultipleServicePacket(data) {
  if (data.length < 2) return cipResponse(0x0a, 0x13);
  const count = data.readUInt16LE(0);
  if (data.length < 2 + count * 2) return cipResponse(0x0a, 0x13);

  // Parse offsets (relative to the count field at data[0])
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push(data.readUInt16LE(2 + i * 2));
  }

  // Dispatch each embedded request
  // Offsets are relative to the count field (data[0]), so absolute = offset itself
  const replies = [];
  for (let i = 0; i < count; i++) {
    const start = offsets[i];
    const end = i + 1 < count ? offsets[i + 1] : data.length;
    const embeddedMsg = data.slice(start, end);
    replies.push(handleCipRequest(embeddedMsg));
  }

  // Build response: count(2) + offsets(2*count) + replies
  // Offsets are ABSOLUTE byte positions within this buffer (st-ethernet-ip
  // uses them directly: data.copy(buf, 0, offsets[i], offsets[i+1]))
  let totalReplyLen = 0;
  for (const r of replies) totalReplyLen += r.length;
  const resp = Buffer.alloc(2 + count * 2 + totalReplyLen);
  resp.writeUInt16LE(count, 0);

  const headerLen = 2 + count * 2;  // count(2) + offset table(2*count)
  let absOffset = headerLen;         // first reply starts right after header
  let writePos = headerLen;
  for (let i = 0; i < count; i++) {
    resp.writeUInt16LE(absOffset, 2 + i * 2);
    replies[i].copy(resp, writePos);
    writePos += replies[i].length;
    absOffset += replies[i].length;
  }

  console.log(`  MULTIPLE SERVICE PACKET: ${count} requests`);
  return cipResponse(0x0a, 0, resp);
}

// ─── Main CIP request dispatcher ────────────────────────────────────

/**
 * Route a CIP request to the appropriate handler.
 * @param {Buffer} cipMsg - full CIP message (service + pathSize + path + data)
 * @returns {Buffer} CIP reply
 */
function handleCipRequest(cipMsg) {
  if (cipMsg.length < 2) return cipResponse(0, 0x08);

  const service = cipMsg.readUInt8(0);
  const pathSizeWords = cipMsg.readUInt8(1);
  const pathSize = pathSizeWords * 2;
  const path = cipMsg.slice(2, 2 + pathSize);
  const data = cipMsg.slice(2 + pathSize);

  // Multiple Service Packet (0x0A) — bundle of CIP requests
  if (service === 0x0a) {
    return handleMultipleServicePacket(data);
  }

  // Unconnected Send (0x52) to Connection Manager — unwrap embedded message
  if (service === 0x52) {
    return handleUnconnectedSend(path, data);
  }

  // GET_INSTANCE_ATTRIBUTE_LIST (0x55) — tag browsing. Path may start
  // with a DATA segment for program-scoped tags, so check service first.
  if (service === 0x55) {
    if (!profile.supportsTagBrowse) {
      console.log("  Tag browse → rejected (not supported by profile: " + profile.name + ")");
      return cipResponse(0x55, 0x08); // service not supported
    }
    const { classId, instanceId, program } = parseClassPath(path);
    if (classId === 0x6b) {
      console.log(`  TAG LIST request (program=${program || "global"}, start=${instanceId})`);
      return handleGetInstanceAttributeList(instanceId, program);
    }
    return cipResponse(service, 0x08);
  }

  // Determine request type from path
  if (path.length >= 2) {
    const seg0 = path.readUInt8(0);

    // Symbolic segment → tag operation (read/write)
    if (seg0 === 0x91) {
      const { tagName } = parseSymbolicPath(path);
      if (service === 0x4c) return handleReadTag(0x4c, tagName);
      if (service === 0x4d || service === 0x53) return handleWriteTag(service, tagName, data);
      // Read Tag Fragmented (0x52) in connected mode
      return handleReadTag(service, tagName);
    }

    // Logical segment (class-based path)
    if (seg0 === 0x20) {
      const { classId, instanceId } = parseClassPath(path);

      // Time Sync Object (0x43)
      if (classId === 0x43) {
        return handleTimeSyncObject(service, path);
      }

      // Motion Axis Object (0x42)
      if (classId === 0x42) {
        return handleMotionAxisObject(service, path, data);
      }

      // Electrical Energy Object (0x4E)
      if (classId === 0x4e) {
        return handleElectricalEnergyObject(service, path);
      }

      // Base Energy Object (0x4F)
      if (classId === 0x4f) {
        return handleBaseEnergyObject(service, path, data);
      }

      // CIP Security Object (0x5D)
      if (classId === 0x5d) {
        return handleCipSecurityObject(service);
      }

      // File Object (0x37)
      if (classId === 0x37) {
        return handleFileObject(service, path, data);
      }

      // Parameter Object (0x0F)
      if (classId === 0x0f) {
        return handleParameterObject(service, path, instanceId, data);
      }

      // Connection Manager (0x06) — Forward Open / Close
      if (classId === 0x06) {
        if (service === 0x54) {
          if (!profile.supportsForwardOpen) {
            console.log("  ForwardOpen → rejected (no backplane, profile: " + profile.name + ")");
            return cipResponse(0x54, 0x01); // connection failure
          }
          return handleForwardOpen(data);
        }
        if (service === 0x4e) return handleForwardClose();
        return cipResponse(service, 0);
      }

      // Identity Object (0x01)
      if (classId === 0x01) {
        if (service === 0x01) return handleGetAttributeAll();
        if (service === 0x0e) return handleGetAttributeSingle();
        return cipResponse(service, 0);
      }

      // Symbol Object (0x6B) — tag list (non-program path)
      if (classId === 0x6b) {
        return handleGetInstanceAttributeList(instanceId, null);
      }

      // PCCC Object (0x67) — Execute PCCC
      if (classId === 0x67 && service === 0x4b) {
        if (!profile.supportsPCCC) {
          console.log("  PCCC → rejected (not supported by profile: " + profile.name + ")");
          return cipResponse(0x4b, 0x08);
        }
        return handleExecutePCCC(data);
      }

      return handleGetAttributeSingle();
    }
  }

  // Read-Modify-Write Tag (0x4E)
  if (service === 0x4e && path.length >= 2 && path[0] === 0x91) {
    const { tagName } = parseSymbolicPath(path);
    return handleReadModifyWrite(tagName, data);
  }

  // Execute PCCC (0x4B) on PCCC Object (class 0x67)
  if (service === 0x4b) {
    if (!profile.supportsPCCC) {
      console.log("  PCCC → rejected (not supported by profile: " + profile.name + ")");
      return cipResponse(0x4b, 0x08); // service not supported
    }
    const { classId } = parseClassPath(path);
    if (classId === 0x67) {
      return handleExecutePCCC(data);
    }
  }

  // Set Attribute Single (0x10) — for mode change simulation
  if (service === 0x10) {
    return cipResponse(0x10, 0);
  }

  // Reset (0x05) — for fault reset simulation
  if (service === 0x05) {
    console.log("  RESET service received");
    return cipResponse(0x05, 0);
  }

  return cipResponse(service, 0x08); // service not supported
}

/**
 * Handle Read-Modify-Write Tag (0x4E).
 * Data: OR_mask_size(2) + OR_mask(N) + AND_mask(N)
 */
function handleReadModifyWrite(tagName, dataBuf) {
  const tag = tags.get(tagName);
  if (!tag) return cipResponse(0x4e, 0x05);

  if (dataBuf.length < 2) return cipResponse(0x4e, 0x13);
  const maskSize = dataBuf.readUInt16LE(0);
  if (dataBuf.length < 2 + maskSize * 2) return cipResponse(0x4e, 0x13);

  const orMask = dataBuf.slice(2, 2 + maskSize);
  const andMask = dataBuf.slice(2 + maskSize, 2 + maskSize * 2);

  // Apply: value = (value AND andMask) OR orMask
  let value = tag.value;
  for (let i = 0; i < maskSize && i < 4; i++) {
    const byteVal = (value >>> (i * 8)) & 0xff;
    const newByte = (byteVal & andMask[i]) | orMask[i];
    value = (value & ~(0xff << (i * 8))) | (newByte << (i * 8));
  }
  tag.value = value;
  console.log(`  READ-MODIFY-WRITE ${tagName}: ${tag.value} -> ${value}`);
  return cipResponse(0x4e, 0);
}

/**
 * Handle Execute PCCC (0x4B) service.
 * Request: requesterIdLen(1) + vendorId(2) + serial(4) + PCCC_packet
 * PCCC packet: cmd(1) + sts(1) + tns(2) + fnc(1) + data(N)
 */
function handleExecutePCCC(data) {
  if (data.length < 7) return cipResponse(0x4b, 0x13);

  const reqIdLen = data[0];
  const pcccOffset = reqIdLen;
  if (data.length < pcccOffset + 5) return cipResponse(0x4b, 0x13);

  const pcccCmd = data[pcccOffset];
  const pcccSts = data[pcccOffset + 1];
  const pcccTns = data.readUInt16LE(pcccOffset + 2);
  const pcccFnc = data[pcccOffset + 4];
  const pcccData = data.slice(pcccOffset + 5);

  console.log(`  PCCC cmd=0x${pcccCmd.toString(16)} fnc=0x${pcccFnc.toString(16)} tns=${pcccTns}`);

  let pcccReply;
  if (pcccCmd === 0x0f && pcccFnc === 0xa2) {
    // Typed Logical Read
    pcccReply = handlePCCCRead(pcccData, pcccTns);
  } else if (pcccCmd === 0x0f && pcccFnc === 0xaa) {
    // Typed Logical Write
    pcccReply = handlePCCCWrite(pcccData, pcccTns);
  } else {
    // Unknown PCCC function
    pcccReply = buildPCCCReply(pcccCmd | 0x40, 0x10, pcccTns, Buffer.alloc(0));
  }

  // Wrap PCCC reply in CIP response
  // Response data: requesterIdLen(1) + requesterIdData(N) + PCCC_reply
  // reqIdLen = number of bytes that follow (vendorId(2) + serial(4) = 6)
  const respData = Buffer.alloc(1 + 6 + pcccReply.length);
  respData[0] = 6;                            // requester ID data length
  respData.writeUInt16LE(0x0001, 1);          // vendor ID
  respData.writeUInt32LE(0x12345678, 3);      // serial number
  pcccReply.copy(respData, 7);                // PCCC reply at offset 1+6=7

  return cipResponse(0x4b, 0, respData);
}

function buildPCCCReply(cmd, sts, tns, data) {
  const reply = Buffer.alloc(4 + data.length);
  reply[0] = cmd | 0x40;  // reply flag
  reply[1] = sts;
  reply.writeUInt16LE(tns, 2);
  data.copy(reply, 4);
  return reply;
}

function handlePCCCRead(data, tns) {
  if (data.length < 7) return buildPCCCReply(0x0f, 0x02, tns, Buffer.alloc(0));

  const byteSize = data[0];
  const fileNum = data[1];
  const fileType = data[2];
  const elemNum = data[3] | (data[4] << 8);
  const subElem = data[5] | (data[6] << 8);

  // Map file type to PCCC tag
  const typeMap = { 0x8a: "N", 0x8b: "F", 0x86: "B", 0x85: "S", 0x87: "T", 0x88: "C" };
  const typeLetter = typeMap[fileType] || "N";
  const pcccTag = tags.get(`_PCCC_${typeLetter}${fileNum}`);

  if (!pcccTag || !Array.isArray(pcccTag.value)) {
    return buildPCCCReply(0x0f, 0x10, tns, Buffer.alloc(0)); // illegal command
  }

  const values = pcccTag.value;
  let respBuf;

  if (fileType === 0x8b) {
    // Float
    respBuf = Buffer.alloc(byteSize);
    for (let i = 0; i < byteSize / 4 && elemNum + i < values.length; i++) {
      respBuf.writeFloatLE(values[elemNum + i], i * 4);
    }
  } else {
    // Integer (16-bit)
    respBuf = Buffer.alloc(byteSize);
    for (let i = 0; i < byteSize / 2 && elemNum + i < values.length; i++) {
      respBuf.writeInt16LE(values[elemNum + i], i * 2);
    }
  }

  console.log(`  PCCC READ ${typeLetter}${fileNum}:${elemNum} (${byteSize} bytes)`);
  return buildPCCCReply(0x0f, 0x00, tns, respBuf);
}

function handlePCCCWrite(data, tns) {
  if (data.length < 7) return buildPCCCReply(0x0f, 0x02, tns, Buffer.alloc(0));

  const byteSize = data[0];
  const fileNum = data[1];
  const fileType = data[2];
  const elemNum = data[3] | (data[4] << 8);
  const writeData = data.slice(7);

  const typeMap = { 0x8a: "N", 0x8b: "F", 0x86: "B" };
  const typeLetter = typeMap[fileType] || "N";
  const pcccTag = tags.get(`_PCCC_${typeLetter}${fileNum}`);

  if (!pcccTag || !Array.isArray(pcccTag.value)) {
    return buildPCCCReply(0x0f, 0x10, tns, Buffer.alloc(0));
  }

  if (fileType === 0x8b) {
    for (let i = 0; i < writeData.length / 4 && elemNum + i < pcccTag.value.length; i++) {
      pcccTag.value[elemNum + i] = writeData.readFloatLE(i * 4);
    }
  } else {
    for (let i = 0; i < writeData.length / 2 && elemNum + i < pcccTag.value.length; i++) {
      pcccTag.value[elemNum + i] = writeData.readInt16LE(i * 2);
    }
  }

  console.log(`  PCCC WRITE ${typeLetter}${fileNum}:${elemNum}`);
  return buildPCCCReply(0x0f, 0x00, tns, Buffer.alloc(0));
}

/**
 * Handle Unconnected Send — unwrap and dispatch the embedded CIP message.
 * Format: priority(1) + timeoutTicks(1) + msgLen(2) + embeddedMsg(N) + [pad] + routePathLen(1) + reserved(1) + routePath
 * @param {Buffer} path - the routing path of the UC Send itself
 * @param {Buffer} data - service data
 * @returns {Buffer}
 */
function handleUnconnectedSend(path, data) {
  if (data.length < 4) return cipResponse(0x52, 0x08);
  // skip priority(1) + timeoutTicks(1)
  const msgLen = data.readUInt16LE(2);
  if (data.length < 4 + msgLen) return cipResponse(0x52, 0x08);
  const embeddedMsg = data.slice(4, 4 + msgLen);
  return handleCipRequest(embeddedMsg);
}

// ─── TCP Server ─────────────────────────────────────────────────────

const server = net.createServer((socket) => {
  let sessionHandle = 0;
  let recvBuf = Buffer.alloc(0);
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[+] Client connected: ${addr}`);

  socket.on("data", (chunk) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);

    while (recvBuf.length >= 24) {
      const dataLen = recvBuf.readUInt16LE(2);
      const totalLen = 24 + dataLen;
      if (recvBuf.length < totalLen) break;

      const pkt = recvBuf.slice(0, totalLen);
      recvBuf = recvBuf.slice(totalLen);

      const cmd = pkt.readUInt16LE(0);
      const session = pkt.readUInt32LE(4);
      const ctx = pkt.slice(12, 20);
      const pktData = pkt.slice(24);

      try {
        switch (cmd) {
          // RegisterSession (0x0065)
          case 0x0065: {
            sessionHandle = nextSession++;
            const resp = Buffer.alloc(4);
            resp.writeUInt16LE(1, 0); // protocol version
            resp.writeUInt16LE(0, 2); // options
            socket.write(enipPacket(0x0065, sessionHandle, ctx, resp));
            console.log(`  RegisterSession -> ${sessionHandle}`);
            break;
          }

          // UnregisterSession (0x0066)
          case 0x0066:
            console.log("  UnregisterSession");
            sessionHandle = 0;
            break;

          // SendRRData (0x006F) — unconnected messaging
          case 0x006f: {
            const cipMsg = extractCipFromCPF(pktData, false);
            if (cipMsg) {
              const reply = handleCipRequest(cipMsg);
              socket.write(sendRRDataReply(session, ctx, reply));
            }
            break;
          }

          // SendUnitData (0x0070) — connected messaging
          case 0x0070: {
            if (!profile.supportsConnectedMessaging) {
              console.log("  SendUnitData → rejected (profile has no connected messaging)");
              // Reply with ENIP error status 0x0001 (invalid command)
              socket.write(enipPacket(0x0070, session, ctx, Buffer.alloc(0)));
              break;
            }
            const result = extractCipFromCPF(pktData, true);
            if (result) {
              const reply = handleCipRequest(result.cipData);
              socket.write(sendUnitDataReply(session, ctx, reply, result.connId, result.seqNum));
            }
            break;
          }

          // ListIdentity (0x0063)
          case 0x0063:
            socket.write(enipPacket(0x0063, 0, ctx, buildListIdentity()));
            break;

          default:
            console.log(`  Unknown ENIP cmd: 0x${cmd.toString(16)}`);
        }
      } catch (err) {
        console.error(`  Error: ${err.message}`);
      }
    }
  });

  socket.on("close", () => console.log(`[-] Client disconnected: ${addr}`));
  socket.on("error", (err) => console.error(`[!] Socket error (${addr}): ${err.message}`));
});

/**
 * Extract CIP data from CPF items.
 * @param {Buffer} data - everything after the ENIP header
 * @param {boolean} connected - true for SendUnitData, false for SendRRData
 * @returns {Buffer|{cipData:Buffer,connId:number,seqNum:number}|null}
 */
function extractCipFromCPF(data, connected) {
  if (data.length < 8) return null;
  const itemCount = data.readUInt16LE(6);
  let offset = 8;
  let connId = 0;
  let seqNum = 0;

  for (let i = 0; i < itemCount && offset + 4 <= data.length; i++) {
    const typeId = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    offset += 4;

    if (typeId === 0x00b2) {
      // UCMM data
      return data.slice(offset, offset + length);
    }
    if (typeId === 0x00a1 && length >= 4) {
      connId = data.readUInt32LE(offset);
    }
    if (typeId === 0x00b1 && length >= 2) {
      seqNum = data.readUInt16LE(offset);
      const cipData = data.slice(offset + 2, offset + length);
      if (connected) return { cipData, connId, seqNum };
    }
    offset += length;
  }
  return null;
}

/**
 * Build ListIdentity CPF response.
 * @returns {Buffer}
 */
function buildListIdentity() {
  const name = profile.name;
  const identityLen = 33 + name.length;
  const buf = Buffer.alloc(4 + identityLen);
  buf.writeUInt16LE(1, 0);           // item count
  buf.writeUInt16LE(0x000c, 2);      // identity type
  let off = 4;
  buf.writeUInt16LE(1, off); off += 2;                          // encap version
  buf.writeUInt16BE(2, off); off += 2;                          // sin_family
  buf.writeUInt16BE(PORT, off); off += 2;                       // sin_port
  buf.writeUInt32BE(0, off); off += 4;                          // sin_addr
  buf.fill(0, off, off + 8); off += 8;                         // sin_zero
  buf.writeUInt16LE(profile.vendor, off); off += 2;             // vendor
  buf.writeUInt16LE(profile.deviceType, off); off += 2;         // device type
  buf.writeUInt16LE(profile.productCode, off); off += 2;        // product code
  buf.writeUInt8(profile.majorRevision, off); off += 1;         // major rev
  buf.writeUInt8(profile.minorRevision, off); off += 1;         // minor rev
  buf.writeUInt16LE(0, off); off += 2;                          // status
  buf.writeUInt32LE(profile.serial, off); off += 4;             // serial
  buf.writeUInt8(name.length, off); off += 1;
  buf.write(name, off, "ascii");
  return buf;
}

// ─── Start ──────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log("===========================================");
  console.log("  CIP PLC Simulator");
  console.log(`  Profile:  ${profile.name}`);
  console.log(`  Vendor:   0x${profile.vendor.toString(16).padStart(4, "0")} | DevType: 0x${profile.deviceType.toString(16).padStart(4, "0")} | ProdCode: 0x${profile.productCode.toString(16).padStart(4, "0")}`);
  console.log(`  Revision: ${profile.majorRevision}.${profile.minorRevision} | Serial: 0x${profile.serial.toString(16)}`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Tags:     ${tags.size}`);
  console.log("-------------------------------------------");
  console.log("  Capabilities:");
  console.log(`    ForwardOpen:       ${profile.supportsForwardOpen ? "yes" : "NO"}`);
  console.log(`    Connected msg:     ${profile.supportsConnectedMessaging ? "yes" : "NO"}`);
  console.log(`    Tag browse:        ${profile.supportsTagBrowse ? "yes" : "NO"}`);
  console.log(`    PCCC:              ${profile.supportsPCCC ? "yes" : "NO"}`);
  console.log(`    ControllerProps:   ${profile.supportsReadControllerProps ? "yes" : "NO"}`);
  console.log(`    Implicit I/O:      ${profile.supportsImplicitIO ? "yes (UDP " + IO_UDP_PORT + ")" : "NO"}`);
  console.log("-------------------------------------------");
  for (const [name, tag] of tags) {
    console.log(`  ${name} (${tag.typeName}) = ${tag.value}`);
  }
  console.log("===========================================");

  // Drive profiles serve cyclic Class 1 I/O over UDP.
  if (profile.supportsImplicitIO) startIoUdpServer();
});
