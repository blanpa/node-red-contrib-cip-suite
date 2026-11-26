import { buildReadPlan, resolvePoll, EvalProp } from "../src/read-plan";

const env: Record<string, string> = { PROG: "Main", TAG: "Env.Tag", SIZE: "4", RATE: "2500", BADRATE: "fast" };

/** msg values are looked up by property name, env by variable name. */
const evalProp: EvalProp = (value, type, msg) => {
  if (type === "msg") return msg ? msg[value] : undefined;
  if (type === "env") return env[value];
  return value;
};

const plan = (config: any) => {
  const p = buildReadPlan(config, evalProp);
  if (!p) throw new Error("expected a plan");
  return p;
};

describe("buildReadPlan", () => {
  it("returns null for a node saved before modes existed", () => {
    expect(buildReadPlan({ tagName: "A", dataType: "auto", pollInterval: 500 }, evalProp)).toBeNull();
  });

  it("returns null for an unknown mode", () => {
    expect(buildReadPlan({ mode: "bogus" }, evalProp)).toBeNull();
  });
});

describe("single mode", () => {
  it("reads a str tag and ignores every message property", () => {
    const p = plan({ mode: "single", tagName: "Fixed", tagNameType: "str" });
    const request = p.resolve({ tagName: "FromMsg", tags: ["X"], dataType: "ARRAY", arraySize: 9 });
    expect(request).toEqual({ kind: "single", tag: "Fixed", dataType: "auto", arraySize: undefined });
  });

  it("takes the tag from the named message property", () => {
    const p = plan({ mode: "single", tagName: "myTag", tagNameType: "msg" });
    expect(p.resolve({ myTag: "Tag1" })).toMatchObject({ kind: "single", tag: "Tag1" });
  });

  it("takes the tag from an environment variable", () => {
    const p = plan({ mode: "single", tagName: "TAG", tagNameType: "env" });
    expect(p.resolve({})).toMatchObject({ kind: "single", tag: "Env.Tag" });
  });

  it("reports an empty tag name without failing the message", () => {
    const p = plan({ mode: "single", tagName: "tagName", tagNameType: "msg" });
    expect(p.resolve({})).toEqual({ kind: "none", reason: "No tag name specified" });
    expect(plan({ mode: "single", tagName: "  ", tagNameType: "str" }).resolve({})).toEqual({
      kind: "none",
      reason: "No tag name specified",
    });
  });

  it("uses the configured data type", () => {
    const p = plan({ mode: "single", tagName: "A", dataType: "STRUCT" });
    expect(p.resolve({})).toMatchObject({ dataType: "STRUCT" });
  });

  it("takes the data type from a message, and passes any value through", () => {
    const p = plan({ mode: "single", tagName: "A", dataType: "dataType", dataTypeType: "msg" });
    expect(p.resolve({ dataType: "ARRAY" })).toMatchObject({ dataType: "ARRAY" });
    // A cip-subscribe wired in sends the type it read, which is not an error
    expect(p.resolve({ dataType: "DINT" })).toMatchObject({ kind: "single", dataType: "DINT" });
    expect(p.resolve({})).toMatchObject({ dataType: "auto" });
  });

  it("applies an array size only to ARRAY", () => {
    const num = { mode: "single", tagName: "A", arraySizeType: "num", arraySize: 5 };
    expect(plan({ ...num, dataType: "ARRAY" }).resolve({})).toMatchObject({ arraySize: 5 });
    expect(plan({ ...num, dataType: "auto" }).resolve({})).toMatchObject({ arraySize: undefined });
    expect(plan({ ...num, dataType: "STRUCT" }).resolve({})).toMatchObject({ arraySize: undefined });
  });

  it("is auto when the array size type is auto, or a message omits the property", () => {
    const base = { mode: "single", tagName: "A", dataType: "ARRAY" };
    expect(plan({ ...base, arraySizeType: "auto" }).resolve({ arraySize: 7 })).toMatchObject({ arraySize: undefined });
    const fromMsg = plan({ ...base, arraySizeType: "msg", arraySize: "size" });
    expect(fromMsg.resolve({})).toMatchObject({ kind: "single", arraySize: undefined });
    expect(fromMsg.resolve({ size: "6" })).toMatchObject({ arraySize: 6 });
  });

  it("takes the array size from an environment variable", () => {
    const p = plan({ mode: "single", tagName: "A", dataType: "ARRAY", arraySizeType: "env", arraySize: "SIZE" });
    expect(p.resolve({})).toMatchObject({ arraySize: 4 });
  });

  it("names an array size that is not a positive whole number", () => {
    const p = plan({ mode: "single", tagName: "A", dataType: "ARRAY", arraySizeType: "msg", arraySize: "size" });
    for (const bad of [0, -2, 1.5, "abc"]) {
      const request = p.resolve({ size: bad });
      expect(request.kind).toBe("error");
      expect((request as any).error).toContain(JSON.stringify(bad));
      expect((request as any).error).toContain('"A"');
    }
  });

  it("does not validate an array size that does not apply", () => {
    const p = plan({ mode: "single", tagName: "A", dataType: "auto", arraySizeType: "msg", arraySize: "size" });
    expect(p.resolve({ size: -3 })).toMatchObject({ kind: "single", arraySize: undefined });
  });

  it("turns a failed lookup into an error", () => {
    const throwing: EvalProp = () => {
      throw new Error("boom");
    };
    const p = buildReadPlan({ mode: "single", tagName: "x", tagNameType: "msg" }, throwing)!;
    const request = p.resolve({});
    expect(request.kind).toBe("error");
    expect((request as any).error).toContain("boom");
  });
});

describe("multiple mode", () => {
  it("reads the configured rows in order", () => {
    const p = plan({
      mode: "multiple",
      tagList: [
        { tagName: "A", tagNameType: "str", dataType: "auto" },
        { tagName: "Arr", tagNameType: "str", dataType: "ARRAY", arraySize: 10 },
        { tagName: "S", tagNameType: "str", dataType: "STRUCT" },
      ],
    });
    expect(p.resolve({ tags: ["Ignored"], tagName: "Ignored" })).toEqual({
      kind: "batch",
      source: "tag list",
      entries: [
        { name: "A" },
        { name: "Arr", dataType: "ARRAY", arraySize: 10 },
        { name: "S", dataType: "STRUCT" },
      ],
    });
  });

  it("takes a row tag from an environment variable", () => {
    const p = plan({ mode: "multiple", tagList: [{ tagName: "TAG", tagNameType: "env", dataType: "auto" }] });
    expect(p.resolve({})).toMatchObject({ entries: [{ name: "Env.Tag" }] });
  });

  it("marks an empty row as invalid, naming its position", () => {
    const p = plan({
      mode: "multiple",
      tagList: [{ tagName: "A" }, { tagName: "  " }, { tagName: "C" }],
    });
    const request: any = p.resolve({});
    expect(request.entries.map((e: any) => e.name)).toEqual(["A", "tags[1]", "C"]);
    expect(request.entries[1].error).toMatch(/tags\[1\].*empty/);
  });

  it("marks a bad row array size as invalid", () => {
    const p = plan({ mode: "multiple", tagList: [{ tagName: "Arr", dataType: "ARRAY", arraySize: 0 }] });
    const request: any = p.resolve({});
    expect(request.entries[0].error).toMatch(/arraySize for "Arr"/);
  });

  it("ignores an array size on a row that is not ARRAY", () => {
    const p = plan({ mode: "multiple", tagList: [{ tagName: "A", dataType: "auto", arraySize: 5 }] });
    expect(p.resolve({})).toMatchObject({ entries: [{ name: "A" }] });
  });

  it("reports an empty list without failing the message", () => {
    expect(plan({ mode: "multiple", tagList: [] }).resolve({})).toEqual({ kind: "none", reason: "No tags configured" });
    expect(plan({ mode: "multiple" }).resolve({})).toEqual({ kind: "none", reason: "No tags configured" });
  });
});

describe("multiple from msg mode", () => {
  it("defaults to msg.tags", () => {
    const p = plan({ mode: "multiple-msg" });
    expect(p.resolve({ tags: ["A", { tagName: "B" }] })).toEqual({
      kind: "batch",
      source: "msg.tags",
      entries: [{ name: "A" }, { name: "B" }],
    });
  });

  it("reads the property it names and ignores msg.tags", () => {
    const p = plan({ mode: "multiple-msg", tagsProp: "list", tagsPropType: "msg" });
    expect(p.resolve({ list: "X, Y", tags: ["Ignored"] })).toMatchObject({
      source: "msg.list",
      entries: [{ name: "X" }, { name: "Y" }],
    });
  });

  it("reports a missing property or blank string without failing the message", () => {
    const p = plan({ mode: "multiple-msg" });
    expect(p.resolve({})).toEqual({ kind: "none", reason: "No tags in msg.tags" });
    expect(p.resolve({ tags: "  " })).toEqual({ kind: "none", reason: "No tags in msg.tags" });
  });

  it("fails a value that is neither an array nor a string", () => {
    const request: any = plan({ mode: "multiple-msg" }).resolve({ tags: 42 });
    expect(request.kind).toBe("error");
    expect(request.error).toMatch(/msg\.tags must be an array or a comma separated string, got number/);
  });

  it("passes malformed entries on for the caller to refuse", () => {
    const request: any = plan({ mode: "multiple-msg" }).resolve({ tags: ["A", 1] });
    expect(request.kind).toBe("batch");
    expect(request.entries[1].error).toBeDefined();
  });
});

describe("dynamic", () => {
  it("is true when a message supplies a value", () => {
    expect(plan({ mode: "single", tagNameType: "msg" }).dynamic).toBe(true);
    expect(plan({ mode: "single", dataTypeType: "msg" }).dynamic).toBe(true);
    expect(plan({ mode: "single", arraySizeType: "msg" }).dynamic).toBe(true);
    expect(plan({ mode: "multiple-msg" }).dynamic).toBe(true);
  });

  it("is false for str, env, num and auto sources, and for the list", () => {
    expect(plan({ mode: "single", tagNameType: "env", dataTypeType: "env", arraySizeType: "num" }).dynamic).toBe(false);
    expect(plan({ mode: "single" }).dynamic).toBe(false);
    expect(plan({ mode: "multiple" }).dynamic).toBe(false);
  });
});

describe("resolvePoll", () => {
  it("is none for type none, whatever the stored value", () => {
    expect(resolvePoll({ pollIntervalType: "none", pollInterval: 500 }, evalProp)).toEqual({ interval: 0 });
  });

  it("reads a missing type as num, so a deployed interval keeps working", () => {
    expect(resolvePoll({ pollInterval: 750 }, evalProp)).toEqual({ interval: 750 });
    expect(resolvePoll({ pollInterval: "750" }, evalProp)).toEqual({ interval: 750 });
  });

  it("treats 0 or empty as trigger only", () => {
    expect(resolvePoll({ pollIntervalType: "num", pollInterval: 0 }, evalProp)).toEqual({ interval: 0 });
    expect(resolvePoll({ pollIntervalType: "num", pollInterval: "" }, evalProp)).toEqual({ interval: 0 });
    expect(resolvePoll({}, evalProp)).toEqual({ interval: 0 });
  });

  it("takes the interval from an environment variable", () => {
    expect(resolvePoll({ pollIntervalType: "env", pollInterval: "RATE" }, evalProp)).toEqual({ interval: 2500 });
  });

  it("names an interval that is not a positive whole number, and does not poll", () => {
    for (const bad of [-5, 1.5, "abc"]) {
      const poll = resolvePoll({ pollIntervalType: "num", pollInterval: bad }, evalProp);
      expect(poll.interval).toBe(0);
      expect(poll.error).toContain(JSON.stringify(bad));
    }
    const fromEnv = resolvePoll({ pollIntervalType: "env", pollInterval: "BADRATE" }, evalProp);
    expect(fromEnv.interval).toBe(0);
    expect(fromEnv.error).toContain('"fast"');
  });

  it("names an environment variable that is not set", () => {
    const poll = resolvePoll({ pollIntervalType: "env", pollInterval: "NOPE" }, evalProp);
    expect(poll.interval).toBe(0);
    expect(poll.error).toContain("NOPE");
  });
});

describe("unusedProps", () => {
  it("reports msg.tags and msg.arraySize on a node that does not read them", () => {
    const p = plan({ mode: "single", tagName: "A", tagNameType: "str" });
    expect(p.unusedProps({ tags: ["X"], arraySize: 4 })).toEqual(["tags", "arraySize"]);
    expect(p.unusedProps({ tags: ["X"] })).toEqual(["tags"]);
    expect(p.unusedProps({ arraySize: 4 })).toEqual(["arraySize"]);
  });

  it("never reports tagName or dataType, which cip-read stamps on its own output", () => {
    const p = plan({ mode: "single", tagName: "A", tagNameType: "str" });
    expect(p.unusedProps({ tagName: "X", dataType: "DINT", payload: 1 })).toEqual([]);
  });

  it("reports nothing for a message without them", () => {
    expect(plan({ mode: "multiple" }).unusedProps({})).toEqual([]);
    expect(plan({ mode: "multiple" }).unusedProps(undefined)).toEqual([]);
  });

  it("does not report msg.tags when multiple from msg reads it", () => {
    expect(plan({ mode: "multiple-msg" }).unusedProps({ tags: ["A"] })).toEqual([]);
    expect(plan({ mode: "multiple-msg", tagsProp: "tags.list" }).unusedProps({ tags: { list: ["A"] } })).toEqual([]);
  });

  it("reports msg.tags when multiple from msg reads a different property", () => {
    const p = plan({ mode: "multiple-msg", tagsProp: "list" });
    expect(p.unusedProps({ list: ["A"], tags: ["Other"] })).toEqual(["tags"]);
  });

  it("does not report msg.arraySize when the array size is read from it", () => {
    const p = plan({ mode: "single", tagName: "A", dataType: "ARRAY", arraySizeType: "msg", arraySize: "arraySize" });
    expect(p.unusedProps({ arraySize: 4 })).toEqual([]);
  });

  it("reports msg.arraySize when the array size is read from another property", () => {
    const p = plan({ mode: "single", tagName: "A", dataType: "ARRAY", arraySizeType: "msg", arraySize: "size" });
    expect(p.unusedProps({ arraySize: 4, size: 4 })).toEqual(["arraySize"]);
  });

  it("does not mistake a property that merely starts with the same letters", () => {
    const p = plan({ mode: "single", tagName: "tagsList", tagNameType: "msg" });
    expect(p.unusedProps({ tags: ["A"], tagsList: "B" })).toEqual(["tags"]);
  });
});
