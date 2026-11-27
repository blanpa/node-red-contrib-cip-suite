import { buildWritePlan } from "../src/write-plan";

const env: Record<string, string> = { TAG: "EnvTag", LEVEL: "7" };
const evalProp = (value: string, type: string, msg?: any): any => {
  if (type === "env") return env[value];
  if (type === "num") return Number(value);
  if (type === "bool") return value === "true";
  if (type === "json") return JSON.parse(value);
  if (type === "msg") return value.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), msg);
  return value;
};

const plan = (config: any) => buildWritePlan(config, evalProp)!;
const row = (tagName: string, extra: Record<string, any> = {}) => ({ tagName, tagNameType: "str", ...extra });
const items = (request: any) => request.items.map((i: any) => [i.name, i.value]);

describe("buildWritePlan", () => {
  it("returns null for a node that has not been upgraded", () => {
    expect(buildWritePlan({ tagName: "A" }, evalProp)).toBeNull();
  });

  describe("one row", () => {
    it("writes msg.payload to the tag as it is, an array and an object included", () => {
      const p = plan({ mode: "ui", output: "result", tagList: [row("Arr", { dataType: "REAL" })], value: "payload", valueType: "msg" });

      expect(p.resolve({ payload: 5 })).toEqual({ kind: "write", source: "tag list", items: [{ name: "Arr", value: 5, dataType: "REAL" }] });
      expect(items(p.resolve({ payload: [1, 2, 3] }))).toEqual([["Arr", [1, 2, 3]]]);
      expect(items(p.resolve({ payload: { Speed: 50 } }))).toEqual([["Arr", { Speed: 50 }]]);
    });

    it("takes a fixed value, as a string, number, boolean or json", () => {
      const one = (value: string, valueType: string) =>
        items(plan({ mode: "ui", output: "result", tagList: [row("A")], value, valueType }).resolve({}));

      expect(one("text", "str")).toEqual([["A", "text"]]);
      expect(one("12", "num")).toEqual([["A", 12]]);
      expect(one("true", "bool")).toEqual([["A", true]]);
      expect(one("[1,2]", "json")).toEqual([["A", [1, 2]]]);
      expect(one("LEVEL", "env")).toEqual([["A", "7"]]);
    });

    it("takes the value from the message property it names", () => {
      const p = plan({ mode: "ui", output: "result", tagList: [row("A")], value: "payload.level", valueType: "msg" });

      expect(items(p.resolve({ payload: { level: 9 } }))).toEqual([["A", 9]]);
    });

    it("fails when there is no value", () => {
      const p = plan({ mode: "ui", output: "result", tagList: [row("A")], value: "payload", valueType: "msg" });

      expect(p.resolve({})).toEqual({ kind: "error", error: "No value to write" });
      expect(p.resolve({ payload: null }).kind).toBe("error");
    });

    it("takes the tag from an environment variable or a message property, with its alias", () => {
      const env1 = plan({ mode: "ui", output: "result", tagList: [{ tagName: "TAG", tagNameType: "env", alias: "x" }], value: "payload" });
      const msg1 = plan({ mode: "ui", output: "result", tagList: [{ tagName: "which", tagNameType: "msg" }], value: "payload" });

      expect(env1.resolve({ payload: 1 })).toMatchObject({ items: [{ name: "EnvTag", alias: "x", value: 1 }] });
      expect(msg1.resolve({ which: "FromMsg", payload: 1 })).toMatchObject({ items: [{ name: "FromMsg" }] });
    });

    it("does nothing for a list nobody has filled in", () => {
      expect(plan({ mode: "ui", output: "result", tagList: [row("")] }).resolve({ payload: 1 }).kind).toBe("none");
    });
  });

  describe("several rows", () => {
    const rows = [row("MyDint", { alias: "speed" }), row("MyInt"), row("MyArray[0..1]")];
    const config = (extra: Record<string, any> = {}) => ({ mode: "ui", output: "array", tagList: rows, value: "payload", valueType: "msg", ...extra });

    it("writes an array of values by position", () => {
      const request = plan(config()).resolve({ payload: [1, 2, [3, 4]] });

      expect(items(request)).toEqual([["MyDint", 1], ["MyInt", 2], ["MyArray[0..1]", [3, 4]]]);
      expect((request as any).items[0].alias).toBe("speed");
    });

    it("writes an object keyed by alias or by the tag as written, in the order of the list", () => {
      const request = plan(config()).resolve({ payload: { "MyArray[0..1]": [3, 4], MyInt: 2, speed: 1 } });

      expect(items(request)).toEqual([["MyDint", 1], ["MyInt", 2], ["MyArray[0..1]", [3, 4]]]);
    });

    it("accepts the tag as well as the alias for a row that has one", () => {
      const request = plan(config()).resolve({ payload: { MyDint: 1, MyInt: 2, "MyArray[0..1]": [3, 4] } });

      expect(items(request)[0]).toEqual(["MyDint", 1]);
    });

    it("accepts the entries a read or a subscribe sends, ignoring their extras", () => {
      const request = plan(config()).resolve({
        payload: [
          { tagName: "MyInt", value: 2, type: "INT" },
          { name: "MyDint", value: 1, changed: true },
          { alias: "x", tagName: "MyArray[0..1]", value: [3, 4], type: "DINT" },
        ],
      });

      expect(items(request)).toEqual([["MyDint", 1], ["MyInt", 2], ["MyArray[0..1]", [3, 4]]]);
    });

    it("tells entries by their name, not by a value key, so a UDT with a member called value is an array of values", () => {
      const p = plan({ mode: "ui", output: "array", tagList: [row("U1"), row("U2")], value: "payload" });

      const request = p.resolve({ payload: [{ value: 1 }, { value: 2 }] });

      expect(items(request)).toEqual([["U1", { value: 1 }], ["U2", { value: 2 }]]);
    });

    it("accepts the Key Result pairs of a read, taking each result's value", () => {
      const request = plan(config()).resolve({
        payload: {
          speed: { tagName: "MyDint", value: 1, type: "DINT" },
          MyInt: { tagName: "MyInt", value: 2, type: "INT" },
          "MyArray[0..1]": { tagName: "MyArray[0..1]", value: [3, 4], type: "DINT" },
        },
      });

      expect(items(request)).toEqual([["MyDint", 1], ["MyInt", 2], ["MyArray[0..1]", [3, 4]]]);
    });

    it("writes an object as a UDT value when it only has a member called value", () => {
      const p = plan({ mode: "ui", output: "array", tagList: [row("U1"), row("U2")], value: "payload" });

      const request = p.resolve({ payload: { U1: { value: 1 }, U2: { name: "x", value: 2 } } });

      expect(items(request)).toEqual([["U1", { value: 1 }], ["U2", { name: "x", value: 2 }]]);
    });

    it("refuses an array with the wrong number of values", () => {
      expect((plan(config()).resolve({ payload: [1, 2] }) as any).error).toMatch(/3 tags but there are 2 values/);
      expect((plan(config()).resolve({ payload: [1, 2, 3, 4] }) as any).error).toMatch(/3 tags but there are 4 values/);
    });

    it("refuses a missing value, naming every tag without one", () => {
      const request = plan(config()).resolve({ payload: { speed: 1 } }) as any;

      expect(request.error).toMatch(/No value for "MyInt", "MyArray\[0\.\.1\]", nothing was written/);
      expect((plan(config()).resolve({ payload: [1, null, 3] }) as any).error).toMatch(/No value for "MyInt"/);
    });

    it("refuses a name that is not a tag, which catches a typo", () => {
      const request = plan(config()).resolve({ payload: { speed: 1, MyInt: 2, "MyArray[0..1]": [1, 2], Typo: 3 } }) as any;

      expect(request.error).toMatch(/"Typo" is not one of the tags/);
    });

    it("refuses a tag given twice", () => {
      const request = plan(config()).resolve({
        payload: [{ name: "MyInt", value: 1 }, { name: "MyInt", value: 2 }, { name: "speed", value: 3 }],
      }) as any;

      expect(request.error).toMatch(/"MyInt" is given twice/);
    });

    it("cannot match by name when two rows are the same tag, but an array works", () => {
      const p = plan({ mode: "ui", output: "array", tagList: [row("A"), row("A")], value: "payload" });

      expect((p.resolve({ payload: { A: 1 } }) as any).error).toMatch(/more than one of the tags/);
      expect(items(p.resolve({ payload: [1, 2] }))).toEqual([["A", 1], ["A", 2]]);
    });

    it("refuses a plain value", () => {
      expect((plan(config()).resolve({ payload: 5 }) as any).error).toMatch(/Expected an array or an object/);
      expect((plan(config()).resolve({}) as any).error).toMatch(/No values to write/);
    });

    it("takes a row's tag from a message property and still matches by alias", () => {
      const p = plan({
        mode: "ui",
        output: "array",
        tagList: [{ tagName: "payload.tag1", tagNameType: "msg", alias: "a" }, row("B")],
        value: "values",
        valueType: "msg",
      });

      const request = p.resolve({ payload: { tag1: "FromDb" }, values: { a: 1, B: 2 } });

      expect(items(request)).toEqual([["FromDb", 1], ["B", 2]]);
    });

    it("is a configuration error for several tags to take a fixed string, number or boolean", () => {
      expect(plan(config({ valueType: "num", value: "1" })).error).toMatch(/message property, json or an environment variable/);
      expect(plan(config({ valueType: "json", value: "[1,2,3]" })).error).toBeUndefined();
    });

    it("is a configuration error to give two rows the same alias", () => {
      expect(plan(config({ tagList: [row("A", { alias: "x" }), row("B", { alias: "x" })] })).error).toMatch(/alias "x"/);
    });

    it("names the row whose tag cannot be worked out", () => {
      const p = plan({ mode: "ui", output: "array", tagList: [row("A"), { tagName: "payload.nope", tagNameType: "msg" }], value: "values" });

      expect((p.resolve({ payload: {}, values: [1, 2] }) as any).error).toMatch(/row 2: the tag name is empty/);
    });
  });

  describe("Key Result pairs output", () => {
    it("refuses rows that would share a key", () => {
      const p = plan({ mode: "ui", output: "keyresult", tagList: [row("A"), row("A")], value: "payload" });

      expect((p.resolve({ payload: [1, 2] }) as any).error).toMatch(/key "A"/);
      expect(plan({ mode: "ui", output: "array", tagList: [row("A"), row("A")], value: "payload" }).resolve({ payload: [1, 2] }).kind).toBe("write");
    });

    it("refuses a message whose tags would share a key in dynamic mode", () => {
      const p = plan({ mode: "dynamic", output: "keyresult" });

      expect((p.resolve({ tags: [{ name: "A", value: 1 }, { name: "A", value: 2 }] }) as any).error).toMatch(/key "A"/);
    });
  });

  describe("Result output", () => {
    it("is not a configuration error for an empty list, which has nothing to write", () => {
      const p = plan({ mode: "ui", output: "result", tagList: [] });

      expect(p.error).toBeUndefined();
      expect(p.resolve({})).toEqual({ kind: "none", reason: "No tags configured" });
    });

    it("is a configuration error with several tags or in dynamic mode", () => {
      expect(plan({ mode: "ui", output: "result", tagList: [row("A"), row("B")] }).error).toMatch(/exactly one tag/);
      expect(plan({ mode: "dynamic", output: "result" }).error).toMatch(/exactly one tag/);
    });
  });

  describe("dynamic mode", () => {
    it("writes an array of entries, by name or tagName, with alias and data type", () => {
      const request = plan({ mode: "dynamic", output: "array" }).resolve({
        tags: [{ name: "A", value: 1, alias: "a", dataType: "DINT" }, { tagName: "B", value: 2, type: "INT", changed: true }],
      });

      expect(request).toEqual({
        kind: "write",
        source: "msg.tags",
        items: [{ name: "A", value: 1, alias: "a", dataType: "DINT" }, { name: "B", value: 2 }],
      });
    });

    it("writes the Key Result pairs of a read, the key becoming the alias", () => {
      const request = plan({ mode: "dynamic", output: "array" }).resolve({
        tags: { speed: { tagName: "MyDint", value: 1, type: "DINT" }, MyInt: { tagName: "MyInt", value: 2 } },
      });

      expect(request).toEqual({
        kind: "write",
        source: "msg.tags",
        items: [{ name: "MyDint", value: 1, alias: "speed" }, { name: "MyInt", value: 2 }],
      });
    });

    it("writes an object of values by tag name", () => {
      const request = plan({ mode: "dynamic", output: "array" }).resolve({ tags: { MyDint: 1, "MyArray[0..2]": [1, 2, 3] } });

      expect(items(request)).toEqual([["MyDint", 1], ["MyArray[0..2]", [1, 2, 3]]]);
    });

    it("reads the property it names, and ignores msg.tags", () => {
      const p = plan({ mode: "dynamic", output: "array", tagsProp: "payload.list" });

      expect(items(p.resolve({ payload: { list: { A: 1 } }, tags: { X: 9 } }))).toEqual([["A", 1]]);
    });

    it("refuses an entry that is not valid, naming each by position, and writes nothing", () => {
      const request = plan({ mode: "dynamic", output: "array" }).resolve({
        tags: [{ name: "A", value: 1 }, 5, { value: 1 }, { name: "B" }],
      }) as any;

      expect(request.error).toMatch(/^Invalid msg\.tags, nothing was written/);
      expect(request.error).toMatch(/msg\.tags\[1\].*got number/);
      expect(request.error).toMatch(/msg\.tags\[2\].*"name" or "tagName"/);
      expect(request.error).toMatch(/msg\.tags\[3\].*no value for "B"/);
    });

    it("does nothing without tags, and refuses something that is not a list", () => {
      const p = plan({ mode: "dynamic", output: "array" });

      expect(p.resolve({}).kind).toBe("none");
      expect(p.resolve({ tags: [] }).kind).toBe("none");
      expect(p.resolve({ tags: 5 }).kind).toBe("error");
    });
  });

  describe("message properties it does not read", () => {
    it("lists msg.tags for a UI node, but not for one that reads it", () => {
      expect(plan({ mode: "ui", tagList: [row("A")] }).unusedProps({ tags: [] })).toEqual(["tags"]);
      expect(plan({ mode: "dynamic" }).unusedProps({ tags: [] })).toEqual([]);
    });

    it("does not list msg.tags when a Value reads it", () => {
      expect(plan({ mode: "ui", tagList: [row("A"), row("B")], value: "tags", valueType: "msg" }).unusedProps({ tags: [] })).toEqual([]);
    });
  });
});
