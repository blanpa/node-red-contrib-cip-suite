import { buildSubscribePlan } from "../src/subscribe-plan";

const env: Record<string, string> = { RATE: "250", BADRATE: "soon", BAND: "0.5", BADBAND: "-1", TAG: "EnvTag" };
const evalProp = (value: string, type: string, msg?: any): any => {
  if (type === "env") return env[value];
  if (type === "msg") return value.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), msg);
  return value;
};

const plan = (config: any) => buildSubscribePlan(config, evalProp)!;
const row = (tagName: string, extra: Record<string, any> = {}) => ({ tagName, tagNameType: "str", ...extra });

describe("buildSubscribePlan", () => {
  it("returns null for a node that has not been upgraded", () => {
    expect(buildSubscribePlan({ tags: "A, B", scanRate: 500 }, evalProp)).toBeNull();
  });

  describe("UI mode", () => {
    it("scans the rows, with their aliases", () => {
      const p = plan({ mode: "ui", output: "keyvalue", tagList: [row("A", { alias: "a" }), row("TAG", { tagNameType: "env" }), row("MyArray[0..2]")] });

      expect(p.error).toBeUndefined();
      expect(p.tags).toEqual([{ name: "A", alias: "a" }, { name: "EnvTag" }, { name: "MyArray[0..2]" }]);
    });

    it("has no tags for a list nobody has filled in, and no error", () => {
      const p = plan({ mode: "ui", output: "keyvalue", tagList: [row("")] });

      expect(p.tags).toEqual([]);
      expect(p.error).toBeUndefined();
    });

    it("names a row with an empty tag, or an environment variable that is not set", () => {
      expect(plan({ mode: "ui", output: "array", tagList: [row("A"), row("")] }).error).toMatch(/row 2.*tag name is empty/);
      expect(plan({ mode: "ui", output: "array", tagList: [row("NOPE", { tagNameType: "env" })] }).error).toMatch(/row 1.*empty/);
    });

    it("is an error to give two rows the same alias, or an object two tags with one key", () => {
      expect(plan({ mode: "ui", output: "array", tagList: [row("A", { alias: "x" }), row("B", { alias: "x" })] }).error).toMatch(/alias "x"/);
      expect(plan({ mode: "ui", output: "keyvalue", tagList: [row("A"), row("A")] }).error).toMatch(/key "A"/);
      expect(plan({ mode: "ui", output: "keyresult", tagList: [row("A"), row("A")] }).error).toMatch(/key "A"/);
      expect(plan({ mode: "ui", output: "array", tagList: [row("A"), row("A")] }).error).toBeUndefined();
    });

    it("keeps two ranges of one array as two keys", () => {
      expect(plan({ mode: "ui", output: "keyvalue", tagList: [row("Arr[0..2]"), row("Arr[5..7]")] }).error).toBeUndefined();
    });

    it("is not an error for the Value output to have an empty list", () => {
      expect(plan({ mode: "ui", output: "value", tagList: [] }).error).toBeUndefined();
    });

    it("is an error for the Value output to have more than one tag, or Dynamic mode", () => {
      expect(plan({ mode: "ui", output: "value", tagList: [row("A"), row("B")] }).error).toMatch(/exactly one tag/);
      expect(plan({ mode: "dynamic", output: "value" }).error).toMatch(/exactly one tag/);
      expect(plan({ mode: "ui", output: "value", tagList: [row("A")] }).error).toBeUndefined();
    });
  });

  describe("scan rate and deadband", () => {
    it("defaults the scan rate to 1000 and the deadband to none", () => {
      const p = plan({ mode: "ui", tagList: [row("A")], scanRate: "", scanRateType: "num" });

      expect(p.scanRate).toBe(1000);
      expect(p.deadband).toBe(0);
    });

    it("takes a number or an environment variable", () => {
      expect(plan({ mode: "ui", tagList: [row("A")], scanRate: 300, scanRateType: "num" }).scanRate).toBe(300);
      expect(plan({ mode: "ui", tagList: [row("A")], scanRate: "RATE", scanRateType: "env" }).scanRate).toBe(250);
      expect(plan({ mode: "ui", tagList: [row("A")], deadband: 2, deadbandType: "num" }).deadband).toBe(2);
      expect(plan({ mode: "ui", tagList: [row("A")], deadband: "BAND", deadbandType: "env" }).deadband).toBe(0.5);
      expect(plan({ mode: "ui", tagList: [row("A")], deadband: 9, deadbandType: "none" }).deadband).toBe(0);
    });

    it("names a value that cannot be used", () => {
      expect(plan({ mode: "ui", tagList: [row("A")], scanRate: "BADRATE", scanRateType: "env" }).error).toContain('"soon"');
      expect(plan({ mode: "ui", tagList: [row("A")], scanRate: "UNSET", scanRateType: "env" }).error).toMatch(/not set/);
      expect(plan({ mode: "ui", tagList: [row("A")], deadband: "BADBAND", deadbandType: "env" }).error).toMatch(/is not negative/);
    });
  });

  describe("dynamic mode", () => {
    it("reads msg.tags by default, with aliases", () => {
      const p = plan({ mode: "dynamic", output: "keyvalue" });

      expect(p.resolveTags({ tags: [{ name: "A", alias: "a" }, "B"] })).toEqual({
        kind: "tags",
        tags: [{ name: "A", alias: "a" }, { name: "B" }],
      });
      expect(p.tags).toEqual([]);
    });

    it("reads the property it names, and a comma separated string", () => {
      const p = plan({ mode: "dynamic", output: "array", tagsProp: "payload.list" });

      expect(p.resolveTags({ payload: { list: "A, B[1,2]" }, tags: ["X"] })).toEqual({
        kind: "tags",
        tags: [{ name: "A" }, { name: "B[1,2]" }],
      });
    });

    it("keeps the list when a message has none, and rejects one that is not valid", () => {
      const p = plan({ mode: "dynamic", output: "array" });

      expect(p.resolveTags({})).toMatchObject({ kind: "none", absent: true });
      expect(p.resolveTags({ tags: [] })).toEqual({ kind: "none", reason: "No tags in msg.tags" });
      expect((p.resolveTags({ tags: ["A", 5] }) as any).error).toMatch(/the tags were not changed/);
      expect(p.resolveTags({ tags: 5 }).kind).toBe("error");
    });

    it("rejects tags that share a key for an object result", () => {
      expect(plan({ mode: "dynamic", output: "keyvalue" }).resolveTags({ tags: ["A", "A"] }).kind).toBe("error");
      expect(plan({ mode: "dynamic", output: "array" }).resolveTags({ tags: ["A", "A"] }).kind).toBe("tags");
    });
  });

  describe("message properties it does not read", () => {
    it("lists msg.tags and msg.scanRate for a UI node, and only msg.scanRate for a Dynamic one", () => {
      expect(plan({ mode: "ui", tagList: [row("A")] }).unusedProps({ tags: [], scanRate: 5 })).toEqual(["tags", "scanRate"]);
      expect(plan({ mode: "dynamic" }).unusedProps({ tags: [], scanRate: 5 })).toEqual(["scanRate"]);
    });
  });
});
