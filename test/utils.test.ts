import {
  parseTagName,
  getBit,
  setBit,
  buildBitMasks,
  cipStatusText,
  cipTypeName,
  parseTagList,
  withTiming,
  debounce,
} from "../src/utils";

// ── parseTagName ──

describe("parseTagName", () => {
  it("parses a simple tag name", () => {
    const r = parseTagName("MyTag");
    expect(r.baseName).toBe("MyTag");
    expect(r.bitIndex).toBeNull();
    expect(r.arrayIndex).toBeNull();
    expect(r.isRange).toBe(false);
  });

  it("parses bit access: MyDint.5", () => {
    const r = parseTagName("MyDint.5");
    expect(r.baseName).toBe("MyDint");
    expect(r.bitIndex).toBe(5);
    expect(r.arrayIndex).toBeNull();
  });

  it("parses bit 0: MyDint.0", () => {
    const r = parseTagName("MyDint.0");
    expect(r.baseName).toBe("MyDint");
    expect(r.bitIndex).toBe(0);
  });

  it("parses multi-digit bit: MyDint.31", () => {
    const r = parseTagName("MyDint.31");
    expect(r.baseName).toBe("MyDint");
    expect(r.bitIndex).toBe(31);
  });

  it("does NOT treat program-scoped tags as bit access", () => {
    const r = parseTagName("Program:MainProgram.MyTag");
    expect(r.baseName).toBe("Program:MainProgram.MyTag");
    expect(r.bitIndex).toBeNull();
  });

  it("parses array element: MyArray[3]", () => {
    const r = parseTagName("MyArray[3]");
    expect(r.baseName).toBe("MyArray");
    expect(r.arrayIndex).toBe(3);
    expect(r.bitIndex).toBeNull();
  });

  it("parses array element 0: MyArray[0]", () => {
    const r = parseTagName("MyArray[0]");
    expect(r.baseName).toBe("MyArray");
    expect(r.arrayIndex).toBe(0);
  });

  it("parses array range: MyArray[0..9]", () => {
    const r = parseTagName("MyArray[0..9]");
    expect(r.baseName).toBe("MyArray");
    expect(r.arrayStart).toBe(0);
    expect(r.arrayEnd).toBe(9);
    expect(r.isRange).toBe(true);
  });

  it("parses array range with offset: MyArray[5..15]", () => {
    const r = parseTagName("MyArray[5..15]");
    expect(r.baseName).toBe("MyArray");
    expect(r.arrayStart).toBe(5);
    expect(r.arrayEnd).toBe(15);
    expect(r.isRange).toBe(true);
  });
});

// ── getBit / setBit ──

describe("getBit", () => {
  it("extracts bit 0 from 1", () => {
    expect(getBit(1, 0)).toBe(true);
  });

  it("extracts bit 1 from 1", () => {
    expect(getBit(1, 1)).toBe(false);
  });

  it("extracts bit 5 from 0x20", () => {
    expect(getBit(0x20, 5)).toBe(true);
  });

  it("extracts bit 31 from 0x80000000", () => {
    expect(getBit(0x80000000, 31)).toBe(true);
  });

  it("extracts bit 0 from 0", () => {
    expect(getBit(0, 0)).toBe(false);
  });
});

describe("setBit", () => {
  it("sets bit 0 on 0", () => {
    expect(setBit(0, 0, true)).toBe(1);
  });

  it("clears bit 0 on 1", () => {
    expect(setBit(1, 0, false)).toBe(0);
  });

  it("sets bit 5 on 0", () => {
    expect(setBit(0, 5, true)).toBe(0x20);
  });

  it("preserves other bits when setting", () => {
    expect(setBit(0xff, 8, true)).toBe(0x1ff);
  });

  it("preserves other bits when clearing", () => {
    expect(setBit(0xff, 3, false)).toBe(0xf7);
  });
});

// ── buildBitMasks ──

describe("buildBitMasks", () => {
  it("builds masks to set bit 0 in 2-byte value", () => {
    const { orMask, andMask } = buildBitMasks(2, 0, true);
    expect(orMask[0]).toBe(0x01);
    expect(orMask[1]).toBe(0x00);
    expect(andMask[0]).toBe(0xff);
    expect(andMask[1]).toBe(0xff);
  });

  it("builds masks to clear bit 0 in 2-byte value", () => {
    const { orMask, andMask } = buildBitMasks(2, 0, false);
    expect(orMask[0]).toBe(0x00);
    expect(andMask[0]).toBe(0xfe);
  });

  it("builds masks for bit 12 in 4-byte value", () => {
    const { orMask, andMask } = buildBitMasks(4, 12, true);
    expect(orMask[1]).toBe(0x10); // byte 1, bit 4
    expect(orMask[0]).toBe(0x00);
    expect(andMask[1]).toBe(0xff);
  });
});

// ── cipStatusText / cipTypeName ──

describe("cipStatusText", () => {
  it("returns text for known status 0x00", () => {
    expect(cipStatusText(0)).toContain("Success");
  });

  it("returns hex for unknown status", () => {
    expect(cipStatusText(0xfe)).toMatch(/0xfe/i);
  });
});

describe("cipTypeName", () => {
  it("returns BOOL for 0xc1", () => {
    expect(cipTypeName(0xc1)).toBe("BOOL");
  });

  it("returns DINT for 0xc4", () => {
    expect(cipTypeName(0xc4)).toBe("DINT");
  });

  it("returns REAL for 0xca", () => {
    expect(cipTypeName(0xca)).toBe("REAL");
  });

  it("returns hex for unknown type", () => {
    expect(cipTypeName(0xff)).toBe("0xff");
  });
});

// ── parseTagList ──

describe("parseTagList", () => {
  it("parses comma-separated tags", () => {
    expect(parseTagList("Tag1, Tag2, Tag3")).toEqual(["Tag1", "Tag2", "Tag3"]);
  });

  it("parses JSON array", () => {
    expect(parseTagList('["Tag1","Tag2"]')).toEqual(["Tag1", "Tag2"]);
  });

  it("filters empty entries", () => {
    expect(parseTagList("Tag1,,Tag2,")).toEqual(["Tag1", "Tag2"]);
  });

  it("handles single tag", () => {
    expect(parseTagList("MyTag")).toEqual(["MyTag"]);
  });

  it("handles empty string", () => {
    expect(parseTagList("")).toEqual([]);
  });

  it("trims whitespace", () => {
    expect(parseTagList("  Tag1 , Tag2  ")).toEqual(["Tag1", "Tag2"]);
  });
});

// ── withTiming ──

describe("withTiming", () => {
  it("returns result and elapsed time", async () => {
    const { result, elapsed } = await withTiming(async () => 42);
    expect(result).toBe(42);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("propagates errors", async () => {
    await expect(
      withTiming(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});

// ── debounce ──

describe("debounce", () => {
  jest.useFakeTimers();

  it("delays execution", () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets timer on repeated calls", () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);
    debounced();
    jest.advanceTimersByTime(50);
    debounced();
    jest.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
