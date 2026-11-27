import {
  parseTagName,
  parseProgramScope,
  resolveMemberInfo,
  canonicalizeTagName,
  getBit,
  setBit,
  buildBitMasks,
  cipStatusText,
  cipTypeName,
  parseTagList,
  describeTagType,
  parseBatchTags,
  withTiming,
  debounce,
  mergeMembers,
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

  it("parses nested array range: Struct.Member[0..101]", () => {
    const r = parseTagName("FIS_Stn[0].Local.FBCACTUAL[0..101]");
    expect(r.baseName).toBe("FIS_Stn[0].Local.FBCACTUAL");
    expect(r.arrayStart).toBe(0);
    expect(r.arrayEnd).toBe(101);
    expect(r.isRange).toBe(true);
  });
});

describe("parseProgramScope", () => {
  it("returns null program for controller-scoped tags", () => {
    expect(parseProgramScope("FIS_Stn[0].Local")).toEqual({
      program: null,
      name: "FIS_Stn[0].Local",
    });
  });

  it("splits program-scoped tags", () => {
    expect(parseProgramScope("Program:MainProgram.MyTag")).toEqual({
      program: "MainProgram",
      name: "MyTag",
    });
  });
});

describe("resolveMemberInfo", () => {
  const tagList = {
    tags: [
      {
        name: "FIS_Stn",
        program: null,
        type: { code: 0xabcd, structure: true, arrayDims: 1 },
      },
    ],
    templates: {
      0xabcd: {
        _members: [
          {
            name: "Local",
            type: { code: 0xef01, structure: true, arrayDims: 0 },
          },
        ],
      },
      0xef01: {
        _members: [
          {
            name: "FBCACTUAL",
            type: { code: 0xc4, structure: false, arrayDims: 1 },
            info: 102,
          },
        ],
      },
    },
  };

  it("detects nested struct members", () => {
    expect(resolveMemberInfo("FIS_Stn[0].Local", tagList)).toEqual({
      arraySize: 1,
      isStruct: true,
      isArray: false,
    });
  });

  it("detects nested array member length", () => {
    expect(resolveMemberInfo("FIS_Stn[0].Local.FBCACTUAL", tagList)).toEqual({
      arraySize: 102,
      isStruct: false,
      isArray: true,
    });
  });

  it("flags a controller-scoped array root with unknown size", () => {
    const list = {
      tags: [
        { name: "MyArray", program: null, type: { code: 0xc4, structure: false, arrayDims: 1 } },
      ],
      templates: {},
    };
    expect(resolveMemberInfo("MyArray", list)).toEqual({
      arraySize: null,
      isStruct: false,
      isArray: true,
    });
  });

  it("returns empty info when the tag list is unavailable", () => {
    expect(resolveMemberInfo("Whatever", null)).toEqual({
      arraySize: null,
      isStruct: false,
      isArray: false,
    });
  });

  it("matches tag and member names case-insensitively, as Logix does", () => {
    expect(resolveMemberInfo("fis_stn[0].local.fbcactual", tagList)).toEqual({
      arraySize: 102,
      isStruct: false,
      isArray: true,
    });
  });

  it("treats a subscripted member as a single element, not an array", () => {
    expect(resolveMemberInfo("FIS_Stn[0].Local.FBCACTUAL[7]", tagList)).toEqual({
      arraySize: 1,
      isStruct: false,
      isArray: false,
    });
  });

  it("treats a subscripted array root as a single element", () => {
    const list = {
      tags: [
        { name: "MyArray", program: null, type: { code: 0xc4, structure: false, arrayDims: 1 } },
      ],
      templates: {},
    };
    expect(resolveMemberInfo("MyArray[3]", list)).toEqual({
      arraySize: 1,
      isStruct: false,
      isArray: false,
    });
  });
});

describe("canonicalizeTagName", () => {
  const tagList = {
    tags: [
      { name: "FIS_Stn", program: null, type: { code: 0xabcd, structure: true, arrayDims: 1 } },
      { name: "Speed", program: "MainProgram", type: { code: 0xca, structure: false, arrayDims: 0 } },
    ],
    templates: {
      0xabcd: {
        _members: [{ name: "Local", type: { code: 0xef01, structure: true, arrayDims: 0 } }],
      },
      0xef01: {
        _members: [
          { name: "FBCACTUAL", type: { code: 0xc4, structure: false, arrayDims: 1 }, info: 102 },
        ],
      },
    },
  };

  it("restores the controller's casing for every path segment", () => {
    expect(canonicalizeTagName("fis_stn[0].local.fbcactual", tagList)).toBe(
      "FIS_Stn[0].Local.FBCACTUAL"
    );
  });

  it("keeps subscripts, including ranges", () => {
    expect(canonicalizeTagName("FIS_STN[2].LOCAL.FBCACTUAL[0..9]", tagList)).toBe(
      "FIS_Stn[2].Local.FBCACTUAL[0..9]"
    );
  });

  it("leaves an unresolvable trailing segment alone", () => {
    expect(canonicalizeTagName("fis_stn[0].local.5", tagList)).toBe("FIS_Stn[0].Local.5");
  });

  it("resolves within the named program scope", () => {
    expect(canonicalizeTagName("speed", tagList, "MainProgram")).toBe("Speed");
  });

  it("passes unknown tags through untouched", () => {
    expect(canonicalizeTagName("SomeOtherTag.Member", tagList)).toBe("SomeOtherTag.Member");
  });

  it("passes everything through when there is no tag list", () => {
    expect(canonicalizeTagName("Whatever", null)).toBe("Whatever");
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

  // Sign-bit wrap: a JS bitwise op always yields a signed 32-bit result, so setting
  // the top bit of a narrower signed type must wrap back to that type's own range.
  it("wraps the INT sign bit (15) when setting", () => {
    expect(setBit(576, 15, true, 16)).toBe(-32192);
  });

  it("wraps the INT sign bit (15) on an all-zero value", () => {
    expect(setBit(0, 15, true, 16)).toBe(-32768);
  });

  it("wraps the INT sign bit (15) when clearing an already-negative value", () => {
    expect(setBit(-30584, 15, false, 16)).toBe(2184);
  });

  it("sets a non-sign INT bit without wrapping", () => {
    expect(setBit(0, 14, true, 16)).toBe(16384);
  });

  it("wraps the SINT sign bit (7) when setting", () => {
    expect(setBit(5, 7, true, 8)).toBe(-123);
  });

  it("wraps the SINT sign bit (7) when clearing a negative value", () => {
    expect(setBit(-100, 7, false, 8)).toBe(28);
  });

  it("wraps the DINT sign bit (31) when setting", () => {
    expect(setBit(5, 31, true, 32)).toBe(-2147483643);
  });

  it("does not sign-wrap when the width is explicitly unsigned", () => {
    expect(setBit(0, 15, true, 16, false)).toBe(32768);
  });

  // A bit index past the tag's width used to be silently accepted (wrapToWidth masked it
  // away), so e.g. MyInt.16 reported success and left the value unchanged.
  it("throws when the bit index is past a 16-bit value's width", () => {
    expect(() => setBit(0, 16, true, 16)).toThrow(RangeError);
  });

  it("throws when the bit index is past an 8-bit value's width", () => {
    expect(() => setBit(0, 8, true, 8)).toThrow(RangeError);
  });

  it("throws when the bit index is past a 32-bit value's width", () => {
    expect(() => setBit(0, 32, true, 32)).toThrow(RangeError);
  });

  it("throws on a negative bit index", () => {
    expect(() => setBit(0, -1, true, 16)).toThrow(RangeError);
  });

  it("still allows the highest valid bit index (boundary)", () => {
    expect(setBit(0, 15, true, 16)).toBe(-32768);
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

  it("throws when the bit index is past the value width", () => {
    expect(() => buildBitMasks(2, 16, true)).toThrow(RangeError);
    expect(() => buildBitMasks(2, 20, false)).toThrow(RangeError);
  });

  it("throws for a negative or non-integer bit index", () => {
    expect(() => buildBitMasks(2, -1, true)).toThrow(RangeError);
    expect(() => buildBitMasks(2, 1.5, true)).toThrow(RangeError);
  });

  it("still allows the highest valid bit index (boundary)", () => {
    const { orMask } = buildBitMasks(2, 15, true);
    expect(orMask[1]).toBe(0x80);
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

// ── describeTagType ──

describe("describeTagType", () => {
  it("uses the type name the library resolved", () => {
    expect(describeTagType({ code: 0xc4, typeName: "DINT" })).toBe("DINT");
    expect(describeTagType({ code: 0x8123, typeName: "MyUDT" })).toBe("MyUDT");
  });

  it("falls back to our name for the code when the library has none", () => {
    // The library leaves typeName null for a code it does not know, which printed [object Object]
    expect(describeTagType({ code: 0xd4, typeName: null })).toBe("LWORD");
  });

  it("falls back to the code in hex for a code nobody has a name for", () => {
    expect(describeTagType({ code: 0x1234, typeName: null })).toBe("0x1234");
  });

  it("accepts a plain string or number", () => {
    expect(describeTagType("REAL")).toBe("REAL");
    expect(describeTagType(0xca)).toBe("REAL");
  });

  it("never renders an object as text", () => {
    expect(describeTagType({})).toBe("");
    expect(describeTagType({ typeName: null })).toBe("");
    expect(describeTagType(null)).toBe("");
    expect(describeTagType(undefined)).toBe("");
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

  it("keeps a comma inside brackets in the tag name", () => {
    expect(parseTagList("Arr[1,2],MyInt")).toEqual(["Arr[1,2]", "MyInt"]);
  });

  it("splits on top level commas only", () => {
    expect(parseTagList("A[0,1] , B , C[2,3,4]")).toEqual(["A[0,1]", "B", "C[2,3,4]"]);
  });

  it("does not hang on an unbalanced bracket", () => {
    expect(parseTagList("A],B")).toEqual(["A]", "B"]);
    expect(parseTagList("A[1,2")).toEqual(["A[1,2"]);
  });
});

// ── parseBatchTags ──

describe("parseBatchTags", () => {
  it("parses a comma separated string through parseTagList", () => {
    expect(parseBatchTags("Arr[1,2], MyInt")).toEqual([{ name: "Arr[1,2]" }, { name: "MyInt" }]);
  });

  it("accepts names, name objects and tagName objects", () => {
    expect(parseBatchTags([" A ", { name: "B", value: 1 }, { tagName: "C" }])).toEqual([
      { name: "A" },
      { name: "B" },
      { name: "C" },
    ]);
  });

  it("carries dataType and arraySize per entry", () => {
    expect(parseBatchTags([{ name: "A", dataType: "ARRAY", arraySize: "5" }])).toEqual([
      { name: "A", dataType: "ARRAY", arraySize: 5 },
    ]);
  });

  it("flags an entry that has no usable name", () => {
    const [entry] = parseBatchTags([{ value: 1 }]);
    expect(entry.name).toBe("tags[0]");
    expect(entry.error).toMatch(/needs a "name" or "tagName"/);
  });

  it("flags a bad arraySize against the tag", () => {
    const [entry] = parseBatchTags([{ name: "A", arraySize: 1.5 }]);
    expect(entry.name).toBe("A");
    expect(entry.error).toMatch(/Invalid arraySize 1.5 for "A"/);
  });

  it("flags entries that are neither a string nor an object", () => {
    const entries = parseBatchTags([1, null]);
    expect(entries[0].error).toMatch(/got number/);
    expect(entries[1].error).toMatch(/got null/);
  });

  it("flags a blank array entry as invalid and names its position", () => {
    const entries = parseBatchTags(["A", "", "C"]);
    expect(entries.map((e) => e.name)).toEqual(["A", "tags[1]", "C"]);
    expect(entries[1].error).toMatch(/tags\[1\].*empty/);
  });

  it("flags an empty segment of a comma separated string and names its position", () => {
    const entries = parseBatchTags("A,,C");
    expect(entries.map((e) => e.name)).toEqual(["A", "tags[1]", "C"]);
    expect(entries[1].error).toMatch(/tags\[1\].*empty/);
  });

  it("flags a trailing comma", () => {
    const entries = parseBatchTags("A,B,");
    expect(entries.map((e) => e.name)).toEqual(["A", "B", "tags[2]"]);
    expect(entries[2].error).toMatch(/empty/);
  });

  it("treats a JSON array string like an array", () => {
    expect(parseBatchTags('["A", "B"]')).toEqual([{ name: "A" }, { name: "B" }]);
    expect(parseBatchTags('["A", 1]')[1].error).toMatch(/got number/);
  });

  it("returns nothing for a blank string", () => {
    expect(parseBatchTags("   ")).toEqual([]);
  });

  it("returns nothing for other input", () => {
    expect(parseBatchTags(undefined)).toEqual([]);
    expect(parseBatchTags(5)).toEqual([]);
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

describe("mergeMembers", () => {
  const udt = { A: 1, Arr: [1, 2, 3], Sub: { X: 1, Y: 2 } };

  it("changes only the members named, case-insensitively", () => {
    expect(mergeMembers(udt, { a: 9, sub: { y: 7 } })).toEqual({
      A: 9,
      Arr: [1, 2, 3],
      Sub: { X: 1, Y: 7 },
    });
  });

  it("replaces array elements by index and keeps the length", () => {
    expect(mergeMembers(udt, { Arr: [5] }).Arr).toEqual([5, 2, 3]);
  });

  it("does not modify the value it was given", () => {
    mergeMembers(udt, { A: 2, Sub: { X: 3 } });
    expect(udt).toEqual({ A: 1, Arr: [1, 2, 3], Sub: { X: 1, Y: 2 } });
  });

  it("rejects an unknown member with its full path", () => {
    expect(() => mergeMembers(udt, { Sub: { Z: 1 } })).toThrow("Sub.Z is not a member of the UDT");
  });

  it("rejects an array longer than the member", () => {
    expect(() => mergeMembers(udt, { Arr: [1, 2, 3, 4] })).toThrow("Arr has 3 elements, got 4");
  });
});
