/**
 * Forward_Open parsing + strict validation, modelling how a PowerFlex 525 drive
 * accepts or rejects a Class 1 (implicit) I/O connection request.
 *
 * This is intentionally strict: it reproduces the real PF525 firmware behaviour
 * that rejected earlier builds of cip-io-scanner with CIP general status 0x01.
 * It is a pure function (Buffer in → result out) so it can be unit-tested without
 * any sockets.
 *
 * @module forward-open
 */

// CIP connection-related extended status codes (general status 0x01)
const EXT = {
  TRANSPORT_NOT_SUPPORTED: 0x0103, // Transport Class and Trigger combination not supported
  NOT_CONFIGURED: 0x0110,          // Connection (target) not configured / unknown path
  INVALID_OT_SIZE: 0x0127,         // Invalid Originator→Target connection size
  INVALID_TO_SIZE: 0x0128,         // Invalid Target→Originator connection size
  INVALID_OT_APP_PATH: 0x012a,     // Invalid Originator→Target application path
  INVALID_TO_APP_PATH: 0x012b,     // Invalid Target→Originator application path
};

/**
 * Parse the Forward_Open service data (everything after CIP service + path).
 * @param {Buffer} data
 * @returns {object} parsed fields, including a decoded connection path
 */
function parseForwardOpen(data) {
  if (data.length < 36) throw new Error("Forward_Open too short");

  const fixed = {
    priorityTick: data.readUInt8(0),
    timeoutTicks: data.readUInt8(1),
    otConnId: data.readUInt32LE(2),
    toConnId: data.readUInt32LE(6),
    connSerial: data.readUInt16LE(10),
    vendorId: data.readUInt16LE(12),
    origSerial: data.readUInt32LE(14),
    timeoutMult: data.readUInt8(18),
    otRpi: data.readUInt32LE(22),
    otParams: data.readUInt16LE(26),
    toRpi: data.readUInt32LE(28),
    toParams: data.readUInt16LE(32),
    transport: data.readUInt8(34),
    pathSizeWords: data.readUInt8(35),
  };

  const path = data.slice(36, 36 + fixed.pathSizeWords * 2);

  // Decode connection path into ordered segments.
  const segments = [];
  let i = 0;
  while (i < path.length) {
    const b = path[i];
    if (b === 0x34) {
      // Electronic Key segment: 0x34, keyFormat(1)=0x04, vendor(2), devType(2),
      // prodCode(2), majorRev(1, bit7=compat), minorRev(1)
      segments.push({
        type: "key",
        vendorId: path.readUInt16LE(i + 2),
        deviceType: path.readUInt16LE(i + 4),
        productCode: path.readUInt16LE(i + 6),
        majorRev: path[i + 8] & 0x7f,
        compatibility: (path[i + 8] & 0x80) !== 0,
        minorRev: path[i + 9],
      });
      i += 10;
    } else if (b === 0x20) {
      // 8-bit logical Class segment, immediately followed by an 8-bit logical
      // Instance (0x24) or Connection Point (0x2c) segment.
      const classId = path[i + 1];
      const subType = path[i + 2];
      const value = path[i + 3];
      const kind = subType === 0x24 ? "instance" : subType === 0x2c ? "connpoint" : "0x" + subType.toString(16);
      segments.push({ type: "app", classId, kind, value });
      i += 4;
    } else {
      segments.push({ type: "unknown", byte: b });
      i += 1;
    }
  }

  return { ...fixed, path, segments };
}

/**
 * Validate a parsed Forward_Open the way a strict AC drive (PF525) does.
 * @param {Buffer} data - Forward_Open service data
 * @param {object} ioConfig - expected assemblies { configInstance, outputInstance, inputInstance }
 * @returns {{ok:true, parsed:object} | {ok:false, status:number, extended:number, reason:string, parsed?:object}}
 */
function validateDriveForwardOpen(data, ioConfig) {
  let parsed;
  try {
    parsed = parseForwardOpen(data);
  } catch (err) {
    return { ok: false, status: 0x01, extended: EXT.NOT_CONFIGURED, reason: err.message };
  }

  // 1) Transport Type/Trigger: the target produces on T→O, so it must be the
  //    SERVER end (bit 7 set) of a Class 1 connection. A bare 0x01 (client) is
  //    rejected by real drive firmware.
  const isServer = (parsed.transport & 0x80) !== 0;
  const transportClass = parsed.transport & 0x0f;
  if (!isServer || transportClass !== 1) {
    return {
      ok: false, status: 0x01, extended: EXT.TRANSPORT_NOT_SUPPORTED, parsed,
      reason: `transport 0x${parsed.transport.toString(16)} invalid (expected 0x81: Server + Class 1)`,
    };
  }

  // 2) Connection path must carry the application paths. Order: [key?] config,
  //    output, input. Config uses an Instance segment; the produced/consumed
  //    assemblies (output/input) MUST use Connection Point segments (0x2c).
  const apps = parsed.segments.filter((s) => s.type === "app" && s.classId === 0x04);
  if (apps.length < 3) {
    return {
      ok: false, status: 0x01, extended: EXT.NOT_CONFIGURED, parsed,
      reason: `expected 3 Assembly app-path segments (config, output, input), got ${apps.length}`,
    };
  }
  const [cfg, out, inp] = apps;

  if (out.kind !== "connpoint") {
    return {
      ok: false, status: 0x01, extended: EXT.INVALID_OT_APP_PATH, parsed,
      reason: `output assembly used an ${out.kind} segment; a Connection Point segment (0x2c) is required`,
    };
  }
  if (inp.kind !== "connpoint") {
    return {
      ok: false, status: 0x01, extended: EXT.INVALID_TO_APP_PATH, parsed,
      reason: `input assembly used an ${inp.kind} segment; a Connection Point segment (0x2c) is required`,
    };
  }

  // 3) Instances must match the drive's native assemblies.
  if (cfg.value !== ioConfig.configInstance ||
      out.value !== ioConfig.outputInstance ||
      inp.value !== ioConfig.inputInstance) {
    return {
      ok: false, status: 0x01, extended: EXT.NOT_CONFIGURED, parsed,
      reason: `assembly instances cfg=${cfg.value}/out=${out.value}/in=${inp.value} do not match ` +
        `drive (cfg=${ioConfig.configInstance}/out=${ioConfig.outputInstance}/in=${ioConfig.inputInstance})`,
    };
  }

  return { ok: true, parsed };
}

module.exports = { parseForwardOpen, validateDriveForwardOpen, EXT };
