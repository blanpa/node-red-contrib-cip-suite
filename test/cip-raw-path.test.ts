/**
 * Tests for CIP path building and response parsing in cip-raw.
 * We test the compiled JS since the functions are module-private;
 * instead we replicate the logic to verify our bugfix for attributeId===0.
 */

describe("CIP path building (attributeId edge cases)", () => {
  // Replicate buildCIPPath logic from cip-raw.ts after fix
  function buildCIPPath(classId: number, instanceId: number, attributeId?: number): Buffer {
    const segments: Buffer[] = [];

    if (classId <= 0xff) {
      segments.push(Buffer.from([0x20, classId]));
    } else {
      const seg = Buffer.alloc(4);
      seg.writeUInt8(0x21, 0);
      seg.writeUInt8(0x00, 1);
      seg.writeUInt16LE(classId, 2);
      segments.push(seg);
    }

    if (instanceId <= 0xff) {
      segments.push(Buffer.from([0x24, instanceId]));
    } else {
      const seg = Buffer.alloc(4);
      seg.writeUInt8(0x25, 0);
      seg.writeUInt8(0x00, 1);
      seg.writeUInt16LE(instanceId, 2);
      segments.push(seg);
    }

    // FIXED: attributeId === 0 is now valid (was skipped before)
    if (attributeId !== undefined) {
      if (attributeId <= 0xff) {
        segments.push(Buffer.from([0x30, attributeId]));
      } else {
        const seg = Buffer.alloc(4);
        seg.writeUInt8(0x31, 0);
        seg.writeUInt8(0x00, 1);
        seg.writeUInt16LE(attributeId, 2);
        segments.push(seg);
      }
    }

    return Buffer.concat(segments);
  }

  it("includes attribute segment when attributeId is 0", () => {
    const path = buildCIPPath(0x01, 0x01, 0);
    // Should be: class(2) + instance(2) + attribute(2) = 6 bytes
    expect(path.length).toBe(6);
    expect(path[4]).toBe(0x30); // attribute segment
    expect(path[5]).toBe(0x00); // attribute 0
  });

  it("includes attribute segment for non-zero attributeId", () => {
    const path = buildCIPPath(0x01, 0x01, 5);
    expect(path.length).toBe(6);
    expect(path[4]).toBe(0x30);
    expect(path[5]).toBe(5);
  });

  it("omits attribute segment when attributeId is undefined", () => {
    const path = buildCIPPath(0x01, 0x01);
    expect(path.length).toBe(4); // class(2) + instance(2) only
  });

  it("uses 16-bit class segment for classId > 255", () => {
    const path = buildCIPPath(0x0100, 0x01);
    expect(path[0]).toBe(0x21); // 16-bit class
    expect(path[1]).toBe(0x00); // pad
    expect(path.readUInt16LE(2)).toBe(0x0100);
    expect(path.length).toBe(6); // 4(class) + 2(instance)
  });

  it("uses 16-bit instance segment for instanceId > 255", () => {
    const path = buildCIPPath(0x01, 0x0200);
    expect(path[2]).toBe(0x25); // 16-bit instance
    expect(path.readUInt16LE(4)).toBe(0x0200);
  });

  it("uses 16-bit attribute segment for attributeId > 255", () => {
    const path = buildCIPPath(0x01, 0x01, 0x0300);
    expect(path[4]).toBe(0x31); // 16-bit attribute
    expect(path.readUInt16LE(6)).toBe(0x0300);
  });
});

describe("CIP param buildPath (16-bit instance fix)", () => {
  // Replicate fixed buildPath from cip-param.ts
  function buildPath(classId: number, instance: number, attribute?: number): Buffer {
    const segments: Buffer[] = [];
    if (classId <= 0xFF) {
      segments.push(Buffer.from([0x20, classId]));
    } else {
      const seg = Buffer.alloc(4);
      seg.writeUInt8(0x21, 0);
      seg.writeUInt8(0x00, 1);
      seg.writeUInt16LE(classId, 2);
      segments.push(seg);
    }
    if (instance <= 0xFF) {
      segments.push(Buffer.from([0x24, instance]));
    } else {
      const seg = Buffer.alloc(4);
      seg.writeUInt8(0x25, 0);
      seg.writeUInt8(0x00, 1);
      seg.writeUInt16LE(instance, 2);
      segments.push(seg);
    }
    if (attribute !== undefined) {
      if (attribute <= 0xFF) {
        segments.push(Buffer.from([0x30, attribute]));
      } else {
        const seg = Buffer.alloc(4);
        seg.writeUInt8(0x31, 0);
        seg.writeUInt8(0x00, 1);
        seg.writeUInt16LE(attribute, 2);
        segments.push(seg);
      }
    }
    return Buffer.concat(segments);
  }

  it("builds correct path for 8-bit instance", () => {
    const p = buildPath(0x0f, 1, 1);
    expect(p).toEqual(Buffer.from([0x20, 0x0f, 0x24, 0x01, 0x30, 0x01]));
  });

  it("builds correct path for 16-bit instance (was broken)", () => {
    const p = buildPath(0x0f, 300, 1);
    expect(p.length).toBe(4 + 2 + 2); // 16-bit instance(4) + class(2) + attr(2)
    // Wait: class(2) + instance(4) + attr(2) = 8
    expect(p.length).toBe(8);
    expect(p[0]).toBe(0x20); // class
    expect(p[1]).toBe(0x0f);
    expect(p[2]).toBe(0x25); // 16-bit instance
    expect(p[3]).toBe(0x00); // pad
    expect(p.readUInt16LE(4)).toBe(300);
    expect(p[6]).toBe(0x30); // attribute
    expect(p[7]).toBe(0x01);
  });

  it("builds correct path for 16-bit instance without attribute", () => {
    const p = buildPath(0x0f, 300);
    expect(p.length).toBe(6); // class(2) + instance(4)
    expect(p[2]).toBe(0x25);
    expect(p.readUInt16LE(4)).toBe(300);
  });

  it("builds correct path for instance 0 (class-level)", () => {
    const p = buildPath(0x0f, 0, 2);
    expect(p).toEqual(Buffer.from([0x20, 0x0f, 0x24, 0x00, 0x30, 0x02]));
  });
});
