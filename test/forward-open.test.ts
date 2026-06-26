/**
 * Unit tests for the simulator's strict (PowerFlex 525) Forward_Open validator.
 * These reproduce, at the byte level, why the drive rejected the earlier
 * cip-io-scanner framing and why the fixed framing is accepted.
 */
const { validateDriveForwardOpen, parseForwardOpen, EXT } = require("../simulator/forward-open");

const IO = { configInstance: 6, outputInstance: 2, inputInstance: 1, inputSize: 8 };

/** Build a Forward_Open service-data buffer with the given transport + path. */
function buildForwardOpen(transport: number, path: Buffer): Buffer {
  const fixed = Buffer.alloc(36);
  fixed.writeUInt8(0x0a, 0);              // priority/tick
  fixed.writeUInt8(0xf0, 1);             // timeout ticks
  fixed.writeUInt32LE(0x20000001, 2);    // O→T conn id
  fixed.writeUInt32LE(0x30000001, 6);    // T→O conn id
  fixed.writeUInt16LE(0x1234, 10);       // conn serial
  fixed.writeUInt16LE(0x0001, 12);       // vendor
  fixed.writeUInt32LE(0x12345678, 14);   // orig serial
  fixed.writeUInt8(0x03, 18);            // timeout mult
  fixed.writeUInt32LE(100000, 22);       // O→T RPI
  fixed.writeUInt16LE(0x4008, 26);       // O→T params (size 8, fixed, class 1)
  fixed.writeUInt32LE(100000, 28);       // T→O RPI
  fixed.writeUInt16LE(0x4008, 32);       // T→O params
  fixed.writeUInt8(transport, 34);       // transport type/trigger
  fixed.writeUInt8(path.length / 2, 35); // path size in words
  return Buffer.concat([fixed, path]);
}

const seg = (sub: number, instance: number) => Buffer.from([0x20, 0x04, sub, instance]);
const CONFIG = seg(0x24, 6);          // Instance segment
const OUT_CP = seg(0x2c, 2);          // Connection Point segment (correct)
const IN_CP = seg(0x2c, 1);           // Connection Point segment (correct)
const OUT_INST = seg(0x24, 2);        // Instance segment (the old bug)

describe("strict drive Forward_Open validation (PowerFlex 525)", () => {
  test("accepts the fixed framing (transport 0x81, Connection Point segments)", () => {
    const fo = buildForwardOpen(0x81, Buffer.concat([CONFIG, OUT_CP, IN_CP]));
    const r = validateDriveForwardOpen(fo, IO);
    expect(r.ok).toBe(true);
  });

  test("rejects transport 0x01 (Client) with 0x01 / ext 0x0103", () => {
    const fo = buildForwardOpen(0x01, Buffer.concat([CONFIG, OUT_CP, IN_CP]));
    const r = validateDriveForwardOpen(fo, IO);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0x01);
    expect(r.extended).toBe(EXT.TRANSPORT_NOT_SUPPORTED);
  });

  test("rejects Instance segment for the output assembly with 0x01 / ext 0x012a", () => {
    const fo = buildForwardOpen(0x81, Buffer.concat([CONFIG, OUT_INST, IN_CP]));
    const r = validateDriveForwardOpen(fo, IO);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0x01);
    expect(r.extended).toBe(EXT.INVALID_OT_APP_PATH);
  });

  test("rejects wrong assembly instances with 0x01 / ext 0x0110", () => {
    const fo = buildForwardOpen(0x81, Buffer.concat([seg(0x24, 6), seg(0x2c, 20), seg(0x2c, 70)]));
    const r = validateDriveForwardOpen(fo, IO);
    expect(r.ok).toBe(false);
    expect(r.extended).toBe(EXT.NOT_CONFIGURED);
  });

  test("parses an optional electronic key segment", () => {
    const key = Buffer.from([0x34, 0x04, 0x01, 0x00, 0x96, 0x00, 0x09, 0x00, 0x85, 0x01]);
    const fo = buildForwardOpen(0x81, Buffer.concat([key, CONFIG, OUT_CP, IN_CP]));
    const parsed = parseForwardOpen(fo);
    const keySeg = parsed.segments.find((s: any) => s.type === "key");
    expect(keySeg).toMatchObject({ vendorId: 1, deviceType: 0x96, productCode: 9, majorRev: 5, minorRev: 1, compatibility: true });
    expect(validateDriveForwardOpen(fo, IO).ok).toBe(true);
  });
});
