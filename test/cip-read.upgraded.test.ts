import { EventEmitter } from "events";

jest.mock("st-ethernet-ip", () => {
  class FakeTag {
    name: string;
    program: string | null;
    value: any = 0;
    type = 0x00ca;
    constructor(name: string, program: string | null = null) {
      this.name = name;
      this.program = program;
    }
  }
  class FakeTagGroup {
    tags: any[] = [];
    add(tag: any) {
      this.tags.push(tag);
    }
    get length() {
      return this.tags.length;
    }
  }
  return { Tag: FakeTag, TagGroup: FakeTagGroup, Structure: class {} };
});

/** Every tag reads 60, except those named in `missing`, which the PLC rejects. */
function makeController(missing: string[] = []) {
  const built: string[] = [];
  const reject = () => Promise.reject({ generalStatusCode: 5, extendedStatus: [] });
  return {
    built,
    state: { tagList: { tags: [] } },
    newTag(name: string, program: string | null) {
      built.push(name);
      return { name, program, value: 60, type: 0x00ca };
    },
    readTag(tag: any) {
      return missing.includes(tag.name) ? reject() : Promise.resolve();
    },
    readTagGroup(group: any) {
      return group.tags.some((t: any) => missing.includes(t.name)) ? reject() : Promise.resolve();
    },
  };
}

let readCtor: any;
const endpoints: Record<string, any> = {};
const testEnv: Record<string, string> = { TAG: "EnvTag" };

function loadModule() {
  const RED: any = {
    nodes: {
      createNode(node: any, cfg: any) {
        node.id = cfg.id;
        node.name = cfg.name;
        node.type = "cip-read";
      },
      registerType(type: string, ctor: any) {
        if (type === "cip-read") readCtor = ctor;
      },
      getNode: (id: string) => endpoints[id] || null,
      eachNode: () => undefined,
    },
    util: {
      evaluateNodeProperty: (value: string, type: string, _node: any, msg: any) =>
        type === "msg"
          ? value.split(".").reduce((o: any, k: string) => (o == null ? undefined : o[k]), msg)
          : type === "env"
            ? testEnv[value]
            : value,
    },
    httpAdmin: { get: () => undefined },
    auth: { needsPermission: () => () => undefined },
    log: { info: () => undefined },
  };
  jest.isolateModules(() => {
    require("../src/cip-read")(RED);
  });
}

function makeReadNode(controller: any, config: Record<string, any> = {}) {
  endpoints.ep1 = {
    id: "ep1",
    name: "PLC1",
    type: "cip-endpoint",
    connected: true,
    connecting: false,
    allowDynamic: false,
    getController: () => controller,
    register: () => undefined,
    deregister: () => undefined,
  };
  const node: any = new EventEmitter();
  node.log = jest.fn();
  node.warn = jest.fn();
  node.error = jest.fn();
  node.status = jest.fn();
  node.send = jest.fn();
  readCtor.call(node, { id: "read1", name: "r", endpoint: "ep1", ...config });
  return node;
}

/** Send a message and resolve with whatever the node passed to done(). */
const read = (node: any, msg: any) =>
  new Promise<Error | undefined>((resolve) => node.emit("input", msg, node.send, (err?: Error) => resolve(err)));
const sent = (node: any) => node.send.mock.calls[0][0];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => loadModule());

describe("an upgraded cip-read node", () => {
  describe("Value output", () => {
    it("sends the value as the payload, with the tag and type, for the one row", async () => {
      const node = makeReadNode(makeController(), {
        mode: "ui",
        output: "value",
        tagList: [{ tagName: "Alpha", tagNameType: "str" }],
      });

      await read(node, { tagName: "Ignored", tags: ["Ignored"] });

      expect(sent(node)).toMatchObject({ payload: 60, tagName: "Alpha", dataType: "REAL" });
    });

    it("fails for a tag the PLC rejects, so a Catch node sees it", async () => {
      const node = makeReadNode(makeController(["Missing"]), {
        mode: "ui",
        output: "value",
        tagList: [{ tagName: "Missing" }],
      });

      const err = await read(node, {});

      expect(err?.message).toMatch(/Read failed/);
      expect(node.send).not.toHaveBeenCalled();
    });

    it("reports a configuration with more than one row and reads nothing", async () => {
      const controller = makeController();
      const node = makeReadNode(controller, {
        mode: "ui",
        output: "value",
        tagList: [{ tagName: "A" }, { tagName: "B" }],
      });

      const err = await read(node, {});

      expect(err?.message).toMatch(/exactly one tag/);
      expect(controller.built).toEqual([]);
      expect(node.error).toHaveBeenCalledTimes(1);
    });
  });

  describe("Key Value pairs output", () => {
    const config = {
      mode: "ui",
      output: "keyvalue",
      tagList: [
        { tagName: "_IO_EM_DI_00", alias: "start" },
        { tagName: "MyUdt.Member" },
        { tagName: "TAG", tagNameType: "env", alias: "fromEnv" },
      ],
    };

    it("keys each value by its alias, else the tag exactly as written", async () => {
      const node = makeReadNode(makeController(), config);

      await read(node, {});

      expect(sent(node).payload).toEqual({ start: 60, "MyUdt.Member": 60, fromEnv: 60 });
    });

    it("sends nothing when any tag fails, and says which", async () => {
      const node = makeReadNode(makeController(["MyUdt.Member"]), config);

      const err = await read(node, {});

      expect(node.send).not.toHaveBeenCalled();
      expect(err?.message).toMatch(/Read failed for 1 of 3 tags.*MyUdt\.Member/);
    });

    it("takes a tag from a message property and still uses the alias as the key", async () => {
      const node = makeReadNode(makeController(), {
        mode: "ui",
        output: "keyvalue",
        tagList: [
          { tagName: "payload.tag1", tagNameType: "msg", alias: "first" },
          { tagName: "payload.tag2", tagNameType: "msg", alias: "second" },
        ],
      });

      await read(node, { payload: { tag1: "FromDbOne", tag2: "FromDbTwo" } });

      expect(sent(node).payload).toEqual({ first: 60, second: 60 });
    });

    it("keeps two ranges of one array as two keys", async () => {
      const node = makeReadNode(makeController(), {
        mode: "ui",
        output: "keyvalue",
        tagList: [{ tagName: "MyArray[0..2]" }, { tagName: "MyArray[5..7]" }],
      });

      await read(node, {});

      expect(Object.keys(sent(node).payload)).toEqual(["MyArray[0..2]", "MyArray[5..7]"]);
    });

    it("refuses tags that share a key before reading", async () => {
      const controller = makeController();
      const node = makeReadNode(controller, {
        mode: "ui",
        output: "keyvalue",
        tagList: [{ tagName: "A" }, { tagName: "which", tagNameType: "msg" }],
      });

      const err = await read(node, { which: "A" });

      expect(err?.message).toMatch(/key "A"/);
      expect(controller.built).toEqual([]);
    });

    it("treats an alias of __proto__ as a key, not as the prototype", async () => {
      const node = makeReadNode(makeController(), {
        mode: "ui",
        output: "keyvalue",
        tagList: [{ tagName: "A", alias: "__proto__" }],
      });

      await read(node, {});

      const payload = sent(node).payload;
      expect(Object.keys(payload)).toEqual(["__proto__"]);
      expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    });
  });

  describe("Key Result pairs output", () => {
    it("has a result under each key, and keeps a failed tag's error in place", async () => {
      const node = makeReadNode(makeController(["Missing"]), {
        mode: "ui",
        output: "keyresult",
        tagList: [{ tagName: "Alpha", alias: "a" }, { tagName: "Missing", alias: "m" }, { tagName: "MyUdt.Member" }],
      });

      const err = await read(node, {});

      expect(err).toBeUndefined();
      const payload = sent(node).payload;
      expect(Object.keys(payload)).toEqual(["a", "m", "MyUdt.Member"]);
      expect(payload.a).toMatchObject({ tagName: "Alpha", value: 60, type: "REAL" });
      expect(payload.m).toMatchObject({ tagName: "Missing", value: null });
      expect(payload.m.error).toMatch(/Path destination unknown/);
      expect(payload["MyUdt.Member"]).toMatchObject({ value: 60 });
      expect(node.status).toHaveBeenLastCalledWith(expect.objectContaining({ fill: "yellow", text: expect.stringMatching(/2 of 3/) }));
    });

    it("refuses tags that share a key before reading", async () => {
      const controller = makeController();
      const node = makeReadNode(controller, {
        mode: "ui",
        output: "keyresult",
        tagList: [{ tagName: "A" }, { tagName: "which", tagNameType: "msg" }],
      });

      const err = await read(node, { which: "A" });

      expect(err?.message).toMatch(/key "A"/);
      expect(controller.built).toEqual([]);
    });
  });

  describe("Array output", () => {
    it("has the alias beside the value, and keeps a failed tag's error in place", async () => {
      const node = makeReadNode(makeController(["Missing"]), {
        mode: "ui",
        output: "array",
        tagList: [{ tagName: "Alpha", alias: "a" }, { tagName: "Missing", alias: "m" }, { tagName: "Gamma" }],
      });

      const err = await read(node, {});

      expect(err).toBeUndefined();
      const payload = sent(node).payload;
      expect(payload).toHaveLength(3);
      expect(payload[0]).toMatchObject({ alias: "a", tagName: "Alpha", value: 60 });
      expect(payload[1]).toMatchObject({ alias: "m", tagName: "Missing", value: null });
      expect(payload[1].error).toMatch(/Path destination unknown/);
      expect(payload[2]).toMatchObject({ tagName: "Gamma", value: 60 });
      expect(payload[2]).not.toHaveProperty("alias");
      expect(node.status).toHaveBeenLastCalledWith(expect.objectContaining({ fill: "yellow", text: expect.stringMatching(/2 of 3/) }));
    });
  });

  describe("Dynamic mode", () => {
    it("reads msg.tags, with aliases, into an object", async () => {
      const node = makeReadNode(makeController(), { mode: "dynamic", output: "keyvalue" });

      await read(node, { tags: [{ name: "_IO_EM_DI_00", alias: "start" }, "B"] });

      expect(sent(node).payload).toEqual({ start: 60, B: 60 });
    });

    it("reads the property it names", async () => {
      const node = makeReadNode(makeController(), { mode: "dynamic", output: "array", tagsProp: "payload.list" });

      await read(node, { payload: { list: ["Alpha"] }, tags: ["Ignored"] });

      expect(sent(node).payload.map((r: any) => r.tagName)).toEqual(["Alpha"]);
    });

    it("refuses an invalid entry, reading nothing", async () => {
      const controller = makeController();
      const node = makeReadNode(controller, { mode: "dynamic", output: "array" });

      const err = await read(node, { tags: ["Alpha", 5] });

      expect(err?.message).toMatch(/^Invalid msg\.tags, nothing was read/);
      expect(controller.built).toEqual([]);
    });
  });

  describe("message properties it does not read", () => {
    it("warns once about msg.tags on a UI node", async () => {
      const node = makeReadNode(makeController(), { mode: "ui", output: "value", tagList: [{ tagName: "A" }] });

      await read(node, { tags: ["Other"] });
      await read(node, { tags: ["Other"] });

      const found = node.warn.mock.calls.map((c: any[]) => c[0]).filter((w: string) => w.startsWith("Ignoring msg.tags"));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/Dynamic/);
    });

    it("does not warn a Dynamic node that reads it", async () => {
      const node = makeReadNode(makeController(), { mode: "dynamic", output: "array" });

      await read(node, { tags: ["A"] });

      expect(node.warn).not.toHaveBeenCalled();
    });
  });

  describe("polling", () => {
    it("polls at the interval from an environment variable", () => {
      testEnv.RATE = "3000";
      const node = makeReadNode(makeController(), {
        mode: "ui",
        output: "value",
        tagList: [{ tagName: "A" }],
        pollIntervalType: "env",
        pollInterval: "RATE",
      });

      expect(node.pollInterval).toBe(3000);
    });

    it("does not poll when a message supplies a tag, and warns", () => {
      const node = makeReadNode(makeController(), {
        mode: "ui",
        output: "keyvalue",
        tagList: [{ tagName: "which", tagNameType: "msg", alias: "x" }],
        pollIntervalType: "num",
        pollInterval: 1000,
      });

      expect(node.pollInterval).toBe(0);
      expect(node.warn.mock.calls[0][0]).toMatch(/Poll interval ignored/);
    });

    it("keeps polling a failing object read but reports it once", async () => {
      const controller = makeController(["Missing"]);
      const node = makeReadNode(controller, {
        mode: "ui",
        output: "keyvalue",
        tagList: [{ tagName: "Alpha" }, { tagName: "Missing" }],
        pollIntervalType: "num",
        pollInterval: 20,
      });

      node.emit("cip:connected");
      await wait(150);

      expect(node.error).toHaveBeenCalledTimes(1);
      expect(node._pollTimer).not.toBeNull();
      node.emit("cip:disconnected");
    });

    it("reports a failing poll every time on a legacy node", async () => {
      const controller = makeController(["Missing"]);
      const node = makeReadNode(controller, { tagName: "Missing", pollInterval: 20 });

      node.emit("cip:connected");
      await wait(150);

      node.emit("cip:disconnected");
      expect(node.error.mock.calls.length).toBeGreaterThan(2);
    });

    it("says no tags are configured, not a Value output error, for an empty list", async () => {
      const node = makeReadNode(makeController(), { mode: "ui", output: "value", tagList: [] });

      const err = await read(node, {});

      expect(err).toBeUndefined();
      expect(node.error).not.toHaveBeenCalled();
      expect(node.warn.mock.calls[0][0]).toMatch(/No tags configured/);
    });

    it("does not poll a configuration that cannot work", () => {
      const node = makeReadNode(makeController(), {
        mode: "ui",
        output: "value",
        tagList: [{ tagName: "A" }, { tagName: "B" }],
        pollIntervalType: "num",
        pollInterval: 1000,
      });

      expect(node.pollInterval).toBe(0);
      expect(node.error).toHaveBeenCalledTimes(1);
    });
  });
});

describe("a cip-read node that has not been upgraded", () => {
  it("still lets msg.tagName and msg.tags override it, with the old output shapes", async () => {
    const node = makeReadNode(makeController(), { tagName: "Configured", dataType: "auto" });

    await read(node, { tagName: "FromMsg" });
    await read(node, { tags: ["A", "B"] });

    expect(node.send.mock.calls[0][0]).toMatchObject({ payload: 60, tagName: "FromMsg" });
    expect(node.send.mock.calls[1][0].payload.map((r: any) => r.tagName)).toEqual(["A", "B"]);
    expect(node.warn).not.toHaveBeenCalled();
  });
});
