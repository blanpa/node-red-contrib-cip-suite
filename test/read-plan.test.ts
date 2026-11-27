import { buildReadPlan, duplicateKeyError, entryKey } from "../src/read-plan";

const env: Record<string, string> = { TAG: "EnvTag", RATE: "3000", BADRATE: "soon" };
const evalProp = (value: string, type: string, msg?: any): any => {
  if (type === "env") return env[value];
  if (type === "msg") {
    // dotted paths, as RED.util.getMessageProperty does
    return value.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), msg);
  }
  return value;
};

const plan = (config: any) => buildReadPlan(config, evalProp)!;

describe("buildReadPlan", () => {
  it("returns null for a node that has not been upgraded", () => {
    expect(buildReadPlan({ tagName: "A" }, evalProp)).toBeNull();
    expect(buildReadPlan({ mode: "" }, evalProp)).toBeNull();
  });

  describe("UI mode", () => {
    it("reads the rows in order with their alias, type and size", () => {
      const p = plan({
        mode: "ui",
        output: "keyvalue",
        tagList: [
          { tagName: "Alpha", alias: "start" },
          { tagName: "Arr", dataType: "ARRAY", arraySize: "4" },
          { tagName: "Udt", dataType: "STRUCT" },
        ],
      });

      const request = p.resolve({});

      expect(request).toEqual({
        kind: "batch",
        source: "tag list",
        entries: [
          { name: "Alpha", alias: "start" },
          { name: "Arr", dataType: "ARRAY", arraySize: 4 },
          { name: "Udt", dataType: "STRUCT" },
        ],
      });
    });

    it("ignores msg.tags and msg.tagName", () => {
      const p = plan({ mode: "ui", output: "array", tagList: [{ tagName: "Alpha" }] });

      const request = p.resolve({ tags: ["Other"], tagName: "Other" });

      expect((request as any).entries.map((e: any) => e.name)).toEqual(["Alpha"]);
    });

    it("takes a row's tag from an environment variable or a message property", () => {
      const p = plan({
        mode: "ui",
        output: "keyvalue",
        tagList: [
          { tagName: "TAG", tagNameType: "env", alias: "a" },
          { tagName: "payload.tag1", tagNameType: "msg", alias: "b" },
        ],
      });

      const request = p.resolve({ payload: { tag1: "FromDb" } });

      expect((request as any).entries.map((e: any) => e.name)).toEqual(["EnvTag", "FromDb"]);
      expect(p.dynamic).toBe(true);
    });

    it("reports a row whose message property is empty, by position", () => {
      const p = plan({
        mode: "ui",
        output: "array",
        tagList: [{ tagName: "Alpha" }, { tagName: "payload.nope", tagNameType: "msg" }],
      });

      const request = p.resolve({ payload: {} });

      expect((request as any).entries[1].error).toMatch(/row 2.*tag name is empty/);
    });

    it("does nothing for a list nobody has filled in", () => {
      expect(plan({ mode: "ui", output: "keyvalue", tagList: [{ tagName: "" }] }).resolve({})).toEqual({
        kind: "none",
        reason: "No tags configured",
      });
      expect(plan({ mode: "ui", output: "keyvalue", tagList: [] }).resolve({}).kind).toBe("none");
    });

    it("is not dynamic when every tag is a string or an environment variable", () => {
      expect(plan({ mode: "ui", tagList: [{ tagName: "A" }, { tagName: "TAG", tagNameType: "env" }] }).dynamic).toBe(false);
    });

    it("refuses an array size that is not a positive whole number", () => {
      const p = plan({ mode: "ui", output: "array", tagList: [{ tagName: "Arr", dataType: "ARRAY", arraySize: "0" }] });

      const request = p.resolve({}) as any;

      expect(request.entries[0].error).toMatch(/array size for "Arr"/);
    });
  });

  describe("value output", () => {
    it("is a single read of the one row", () => {
      const p = plan({ mode: "ui", output: "value", tagList: [{ tagName: "Arr", dataType: "ARRAY", arraySize: "3" }] });

      expect(p.error).toBeUndefined();
      expect(p.resolve({})).toEqual({ kind: "single", tag: "Arr", dataType: "ARRAY", arraySize: 3 });
    });

    it("is not a configuration error with an empty list, which has nothing to read", () => {
      const p = plan({ mode: "ui", output: "value", tagList: [] });

      expect(p.error).toBeUndefined();
      expect(p.resolve({})).toEqual({ kind: "none", reason: "No tags configured" });
    });

    it("is a configuration error with more than one row", () => {
      const p = plan({ mode: "ui", output: "value", tagList: [{ tagName: "A" }, { tagName: "B" }] });

      expect(p.error).toMatch(/exactly one tag/);
      expect(p.resolve({})).toEqual({ kind: "error", error: p.error });
    });

    it("is a configuration error in dynamic mode", () => {
      expect(plan({ mode: "dynamic", output: "value" }).error).toMatch(/exactly one tag/);
    });
  });

  describe("aliases and keys", () => {
    it("uses the alias, else the tag as written, as the key", () => {
      expect(entryKey({ name: "MyUdt.Member" })).toBe("MyUdt.Member");
      expect(entryKey({ name: "MyArray[0..2]" })).toBe("MyArray[0..2]");
      expect(entryKey({ name: "_IO_EM_DI_00", alias: "start" })).toBe("start");
    });

    it("keeps two ranges of one array apart", () => {
      expect(duplicateKeyError([{ name: "MyArray[0..2]" }, { name: "MyArray[5..7]" }])).toBeUndefined();
    });

    it("names a key two tags share", () => {
      expect(duplicateKeyError([{ name: "A", alias: "x" }, { name: "B", alias: "x" }])).toMatch(/"x"/);
      expect(duplicateKeyError([{ name: "A" }, { name: "A" }])).toMatch(/"A"/);
    });

    it("is a configuration error to give two rows the same alias", () => {
      const p = plan({
        mode: "ui",
        output: "array",
        tagList: [{ tagName: "A", alias: "x" }, { tagName: "B", alias: "x" }],
      });

      expect(p.error).toMatch(/alias "x"/);
    });

    it("refuses tags that share a key for a keyed result, but not for an array", () => {
      const rows = [{ tagName: "A" }, { tagName: "A" }];

      expect(plan({ mode: "ui", output: "keyvalue", tagList: rows }).resolve({}).kind).toBe("error");
      expect(plan({ mode: "ui", output: "keyresult", tagList: rows }).resolve({}).kind).toBe("error");
      expect(plan({ mode: "ui", output: "array", tagList: rows }).resolve({}).kind).toBe("batch");
    });

    it("refuses a clash that only appears once a message supplies the tag", () => {
      const p = plan({
        mode: "ui",
        output: "keyvalue",
        tagList: [{ tagName: "A" }, { tagName: "which", tagNameType: "msg" }],
      });

      expect(p.resolve({ which: "A" }).kind).toBe("error");
      expect(p.resolve({ which: "B" }).kind).toBe("batch");
    });
  });

  describe("dynamic mode", () => {
    it("reads msg.tags by default, with aliases", () => {
      const p = plan({ mode: "dynamic", output: "keyvalue" });

      const request = p.resolve({ tags: [{ name: "_IO_EM_DI_00", alias: "start" }, "B"] });

      expect(request).toEqual({
        kind: "batch",
        source: "msg.tags",
        entries: [{ name: "_IO_EM_DI_00", alias: "start" }, { name: "B" }],
      });
      expect(p.dynamic).toBe(true);
    });

    it("reads the property it names, and ignores msg.tags", () => {
      const p = plan({ mode: "dynamic", output: "array", tagsProp: "payload.list" });

      const request = p.resolve({ payload: { list: "A, B" }, tags: ["X"] }) as any;

      expect(request.source).toBe("msg.payload.list");
      expect(request.entries.map((e: any) => e.name)).toEqual(["A", "B"]);
    });

    it("does nothing without tags, and refuses something that is not a list", () => {
      const p = plan({ mode: "dynamic", output: "array" });

      expect(p.resolve({})).toEqual({ kind: "none", reason: "No tags in msg.tags" });
      expect(p.resolve({ tags: 5 }).kind).toBe("error");
    });

    it("refuses an object result whose tags share a key", () => {
      const p = plan({ mode: "dynamic", output: "keyvalue" });

      expect(p.resolve({ tags: ["A", "A"] }).kind).toBe("error");
    });
  });

  describe("polling", () => {
    it("is a number, an environment variable, or none", () => {
      expect(plan({ mode: "ui", pollIntervalType: "num", pollInterval: 500 }).poll.interval).toBe(500);
      expect(plan({ mode: "ui", pollIntervalType: "env", pollInterval: "RATE" }).poll.interval).toBe(3000);
      expect(plan({ mode: "ui", pollIntervalType: "none", pollInterval: 500 }).poll.interval).toBe(0);
    });

    it("names an interval that is not usable", () => {
      const poll = plan({ mode: "ui", pollIntervalType: "env", pollInterval: "BADRATE" }).poll;

      expect(poll.interval).toBe(0);
      expect(poll.error).toContain('"soon"');
    });
  });

  describe("message properties it does not read", () => {
    it("lists msg.tags for a UI node, but not for one that reads it", () => {
      expect(plan({ mode: "ui", tagList: [{ tagName: "A" }] }).unusedProps({ tags: [] })).toEqual(["tags"]);
      expect(plan({ mode: "dynamic" }).unusedProps({ tags: [] })).toEqual([]);
      expect(plan({ mode: "dynamic", tagsProp: "tags.list" }).unusedProps({ tags: {} })).toEqual([]);
    });

    it("leaves tagName and dataType alone, since cip-read stamps them on its own output", () => {
      expect(plan({ mode: "ui", tagList: [{ tagName: "A" }] }).unusedProps({ tagName: "X", dataType: "DINT" })).toEqual([]);
    });
  });
});
