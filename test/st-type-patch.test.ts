/**
 * Unit tests for the numeric types st-ethernet-ip cannot encode or decode (#42): buffers
 * are built and parsed by real Tag objects, no controller involved.
 */
import { installTypePatch } from "../src/st-type-patch";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Tag, EthernetIP } = require("st-ethernet-ip");
const { Types, TypeSizes } = EthernetIP.CIP.DataTypes;

const READ_MODIFY_WRITE = 0x4e;
const WRITE = 0x4d;
const WRITE_FRAGMENTED = 0x53;

/** The CIP data of a built request: everything after the service and the path. */
function dataOf(request: Buffer): Buffer {
  return request.slice(2 + request[1] * 2);
}

function tagOf(name: string, type: string, value?: any): any {
  const tag = new Tag(name);
  tag.type = type;
  if (value !== undefined) tag.value = value;
  return tag;
}

/** A read reply: the type code, then the raw value bytes. */
function reply(type: string, bytes: Buffer): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16LE(Types[type], 0);
  return Buffer.concat([head, bytes]);
}

function le(size: number, ...values: Array<number | bigint>): Buffer {
  const buf = Buffer.alloc(size * values.length);
  values.forEach((v, i) => {
    const at = i * size;
    if (size === 1) buf.writeUInt8(Number(v), at);
    else if (size === 2) buf.writeUInt16LE(Number(v), at);
    else if (size === 4) buf.writeUInt32LE(Number(v), at);
    else buf.writeBigUInt64LE(BigInt(v), at);
  });
  return buf;
}

function double(...values: number[]): Buffer {
  const buf = Buffer.alloc(8 * values.length);
  values.forEach((v, i) => buf.writeDoubleLE(v, i * 8));
  return buf;
}

/** Each type with the bytes of two sample values and the JS values they stand for. */
const CASES = [
  { type: "USINT", size: 1, values: [7, 250], bytes: le(1, 7, 250) },
  { type: "UINT", size: 2, values: [513, 65535], bytes: le(2, 513, 65535) },
  { type: "UDINT", size: 4, values: [70000, 4294967295], bytes: le(4, 70000, 4294967295) },
  {
    type: "ULINT",
    size: 8,
    values: [5000000000n, 18446744073709551615n],
    bytes: le(8, 5000000000n, 18446744073709551615n),
  },
  { type: "LREAL", size: 8, values: [1.5, -2.25e100], bytes: double(1.5, -2.25e100) },
  { type: "BYTE", size: 1, values: [7, 250], bytes: le(1, 7, 250) },
  { type: "WORD", size: 2, values: [513, 65535], bytes: le(2, 513, 65535) },
  {
    type: "LWORD",
    size: 8,
    values: [5000000000n, 18446744073709551615n],
    bytes: le(8, 5000000000n, 18446744073709551615n),
  },
];

/** The patched types the library has no case for in each method. */
const MISSING_READ = CASES.filter((c) => !["USINT", "UINT"].includes(c.type));
const MISSING_WRITE = CASES.filter((c) => c.type !== "USINT");
const BIT_TYPES = CASES.filter((c) => c.size <= 4 && c.type !== "LREAL");

describe("installTypePatch", () => {
  it("installs, and is safe to call again", () => {
    expect(installTypePatch()).toBe(true);
    expect(installTypePatch()).toBe(true);
  });

  it("names the codes the way the CIP spec does", () => {
    const name = EthernetIP.CIP.DataTypes.getTypeCodeString;
    expect(name(0xd1)).toBe("BYTE");
    expect(name(0xd2)).toBe("WORD");
    expect(name(0xd4)).toBe("LWORD");
    expect(Types.DWORD).toBe(0xd3);
    // A Logix BOOL array keeps the name the library gives it
    expect(name(0xd3)).toBe("BIT_STRING");
  });

  it("gives ULINT a type code and a size", () => {
    expect(Types.ULINT).toBe(0xc9);
    expect(EthernetIP.CIP.DataTypes.getTypeCodeString(0xc9)).toBe("ULINT");
    expect(TypeSizes[0xc9]).toBe(8);
  });
});

describe("read", () => {
  it.each(MISSING_READ.map((c) => [c.type, c]))("decodes a single %s", (_name, c: any) => {
    const tag = tagOf("T", c.type);
    tag.parseReadMessageResponse(reply(c.type, c.bytes.slice(0, c.size)));
    expect(tag.value).toBe(c.values[0]);
  });

  it.each(CASES.map((c) => [c.type, c]))("decodes a %s array", (_name, c: any) => {
    const tag = tagOf("T", c.type);
    tag.parseReadMessageResponse(reply(c.type, c.bytes));
    expect(tag.value).toEqual(c.values);
  });

  it("reads ULINT and LWORD as BigInt", () => {
    for (const type of ["ULINT", "LWORD"]) {
      const tag = tagOf("T", type);
      tag.parseReadMessageResponse(reply(type, le(8, 1n)));
      expect(typeof tag.value).toBe("bigint");
    }
  });

  it("leaves the types the library handles to it", () => {
    const dint = tagOf("T", "DINT");
    const head = Buffer.alloc(2);
    head.writeUInt16LE(Types.DINT, 0);
    const body = Buffer.alloc(4);
    body.writeInt32LE(-5, 0);
    dint.parseReadMessageResponse(Buffer.concat([head, body]));
    expect(dint.value).toBe(-5);
  });

  it("still refuses a type nobody handles", () => {
    const tag = tagOf("T", "TIME");
    expect(() => tag.parseReadMessageResponse(reply("TIME", le(4, 1)))).toThrow(/Unrecognized Type/);
  });
});

describe("write", () => {
  it.each(MISSING_WRITE.map((c) => [c.type, c]))("encodes a single %s", (_name, c: any) => {
    const tag = tagOf("T", c.type, c.values[0]);
    const request = tag.generateWriteMessageRequest();
    expect(request[0]).toBe(WRITE);
    expect(dataOf(request)).toEqual(
      Buffer.concat([le(2, Types[c.type]), le(2, 1), c.bytes.slice(0, c.size)])
    );
  });

  it.each(CASES.map((c) => [c.type, c]))("encodes a %s array", (_name, c: any) => {
    const tag = tagOf("T", c.type, c.values);
    expect(dataOf(tag.generateWriteMessageRequest())).toEqual(
      Buffer.concat([le(2, Types[c.type]), le(2, 2), c.bytes])
    );
  });

  it.each(CASES.map((c) => [c.type, c]))("encodes a %s fragment", (_name, c: any) => {
    const tag = tagOf("T", c.type, [...c.values, ...c.values]);
    const request = tag.generateWriteMessageRequestFrag(8, c.values, 1);
    expect(request[0]).toBe(WRITE_FRAGMENTED);
    expect(dataOf(request)).toEqual(
      Buffer.concat([le(2, Types[c.type]), le(2, 4), le(4, 8), c.bytes])
    );
  });

  it("takes ULINT and LWORD as BigInt, number or digit text", () => {
    for (const type of ["ULINT", "LWORD"]) {
      for (const value of [42n, 42, "42"]) {
        const tag = tagOf("T", type, value);
        expect(dataOf(tag.generateWriteMessageRequest()).slice(4)).toEqual(le(8, 42n));
      }
    }
  });

  it.each([
    ["UINT", 65536],
    ["UINT", -1],
    ["UDINT", 4294967296],
    ["UDINT", -1],
    ["BYTE", 256],
    ["WORD", 65536],
    ["ULINT", -1n],
    ["ULINT", 18446744073709551616n],
    ["LWORD", -1n],
  ])("refuses %s %s", (type, value) => {
    const tag = tagOf("T", type, value);
    expect(() => tag.generateWriteMessageRequest()).toThrow(/out of range/);
  });

  it("leaves the types the library handles to it", () => {
    const tag = tagOf("T", "DINT", -5);
    expect(dataOf(tag.generateWriteMessageRequest()).slice(4)).toEqual(
      (() => {
        const b = Buffer.alloc(4);
        b.writeInt32LE(-5, 0);
        return b;
      })()
    );
  });

  it("still refuses a type nobody handles", () => {
    const tag = tagOf("T", "TIME", 1);
    expect(() => tag.generateWriteMessageRequest()).toThrow(/Unrecognized Type/);
  });
});

describe("bit access", () => {
  it.each(BIT_TYPES.map((c) => [c.type, c]))("reads a bit of a %s", (_name, c: any) => {
    const set = tagOf("T.3", c.type);
    set.parseReadMessageResponse(reply(c.type, le(c.size, 0b1000)));
    expect(set.value).toBe(true);

    const clear = tagOf("T.2", c.type);
    clear.parseReadMessageResponse(reply(c.type, le(c.size, 0b1000)));
    expect(clear.value).toBe(false);
  });

  it.each(BIT_TYPES.map((c) => [c.type, c]))("reads the top bit of a %s", (_name, c: any) => {
    const top = c.size * 8 - 1;
    const tag = tagOf(`T.${top}`, c.type);
    tag.parseReadMessageResponse(reply(c.type, le(c.size, 2 ** top)));
    expect(tag.value).toBe(true);
  });

  it.each(BIT_TYPES.map((c) => [c.type, c]))("sets and clears a bit of a %s", (_name, c: any) => {
    const all = 2 ** (c.size * 8) - 1;

    const set = tagOf("T.3", c.type, true);
    const setRequest = set.generateWriteMessageRequest();
    expect(setRequest[0]).toBe(READ_MODIFY_WRITE);
    expect(dataOf(setRequest)).toEqual(Buffer.concat([le(2, c.size), le(c.size, 0b1000), le(c.size, all)]));

    const clear = tagOf("T.3", c.type, false);
    expect(dataOf(clear.generateWriteMessageRequest())).toEqual(
      Buffer.concat([le(2, c.size), le(c.size, 0), le(c.size, all - 0b1000)])
    );
  });

  it("sets the top bit of a UDINT", () => {
    const tag = tagOf("T.31", "UDINT", true);
    expect(dataOf(tag.generateWriteMessageRequest())).toEqual(
      Buffer.concat([le(2, 4), le(4, 0x80000000), le(4, 0xffffffff)])
    );
  });

  it.each(["ULINT", "LREAL", "LWORD"])("refuses bit access on %s", (type) => {
    const read = tagOf("T.1", type);
    expect(() => read.parseReadMessageResponse(reply(type, le(8, 1n)))).toThrow(/Bit access is not supported/);
    const write = tagOf("T.1", type, true);
    expect(() => write.generateWriteMessageRequest()).toThrow(/Bit access is not supported/);
  });
});
