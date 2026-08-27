/**
 * Unit tests for array-length resolution.
 */
import {
  ArraySizeCache,
  parseArrayDimensions,
  probeArrayLength,
  resolveArrayLength,
} from "../src/tag-array";

function dims(...values: number[]): Buffer {
  const buf = Buffer.alloc(12);
  values.forEach((v, i) => buf.writeUInt32LE(v, i * 4));
  return buf;
}

describe("parseArrayDimensions", () => {
  it("reads a one-dimensional extent", () => {
    expect(parseArrayDimensions(dims(102, 0, 0))).toBe(102);
  });

  it("multiplies the extents of a multi-dimensional array", () => {
    expect(parseArrayDimensions(dims(4, 8, 0))).toBe(32);
    expect(parseArrayDimensions(dims(2, 3, 4))).toBe(24);
  });

  it("returns null when no dimension has an extent", () => {
    expect(parseArrayDimensions(dims(0, 0, 0))).toBeNull();
  });

  it("returns null for an unusable payload", () => {
    expect(parseArrayDimensions(null)).toBeNull();
    expect(parseArrayDimensions(Buffer.alloc(2))).toBeNull();
  });
});

/** A controller stub whose reads succeed only for indices below `length`. */
function stubController(length: number) {
  const reads: string[] = [];
  return {
    reads,
    removeAllListeners() {},
    async readTag(tag: { name: string }) {
      reads.push(tag.name);
      const index = parseInt(tag.name.slice(tag.name.lastIndexOf("[") + 1), 10);
      if (index >= length) throw new Error("beyond end of tag");
    },
  };
}

const makeTag = (name: string) => ({ name });

describe("probeArrayLength", () => {
  it.each([1, 2, 5, 10, 102, 1000])("finds a length of %i", async (length) => {
    const controller = stubController(length);
    expect(await probeArrayLength(controller, "MyArray", makeTag)).toBe(length);
  });

  it("stays logarithmic in the array length", async () => {
    const controller = stubController(1000);
    await probeArrayLength(controller, "MyArray", makeTag);
    // Doubling to 1024 plus the bisection is ~20 reads; the linear walk the
    // library does would be 1001.
    expect(controller.reads.length).toBeLessThan(30);
  });

  it("returns null when the tag has no element 0", async () => {
    const controller = stubController(0);
    expect(await probeArrayLength(controller, "NotAnArray", makeTag)).toBeNull();
  });

  it("gives up rather than probing past the ceiling", async () => {
    const controller = stubController(Number.MAX_SAFE_INTEGER);
    expect(await probeArrayLength(controller, "MyArray", makeTag, 64)).toBeNull();
  });
});

describe("ArraySizeCache", () => {
  it("keys on program scope and ignores tag-name casing", () => {
    const cache = new ArraySizeCache();
    cache.set("MyArray", null, 10);
    expect(cache.get("myarray", null)).toBe(10);
    expect(cache.get("MyArray", "MainProgram")).toBeUndefined();
  });

  it("empties on clear", () => {
    const cache = new ArraySizeCache();
    cache.set("MyArray", null, 10);
    cache.clear();
    expect(cache.get("MyArray", null)).toBeUndefined();
  });
});

describe("resolveArrayLength", () => {
  it("falls back to the probe when the tag is not in the tag list", async () => {
    const controller = { ...stubController(7), state: { tagList: { tags: [] } } };
    const result = await resolveArrayLength(
      controller,
      "MyArray",
      null,
      makeTag,
      new ArraySizeCache()
    );
    expect(result).toEqual({ size: 7, source: "probe" });
  });

  it("asks the controller only once per tag", async () => {
    const controller = { ...stubController(7), state: { tagList: { tags: [] } } };
    const cache = new ArraySizeCache();
    await resolveArrayLength(controller, "MyArray", null, makeTag, cache);
    const reads = controller.reads.length;
    await resolveArrayLength(controller, "MyArray", null, makeTag, cache);
    expect(controller.reads.length).toBe(reads);
  });

  it("returns null for a tag that is not an array at all", async () => {
    const controller = { ...stubController(0), state: { tagList: { tags: [] } } };
    const result = await resolveArrayLength(
      controller,
      "MyDint",
      null,
      makeTag,
      new ArraySizeCache()
    );
    expect(result).toBeNull();
  });
});
