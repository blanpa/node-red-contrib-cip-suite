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

/** Records the name and program every tag is built with. */
function makeController() {
  const built: Array<{ name: string; program: string | null }> = [];
  return {
    built,
    state: { tagList: { tags: [] } },
    newTag(name: string, program: string | null) {
      built.push({ name, program });
      return { name, program, value: 60, type: 0x00ca };
    },
    readTag() {
      return Promise.resolve();
    },
    readTagGroup() {
      return Promise.resolve();
    },
  };
}

let readCtor: any;

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
      // msg values are looked up by property name, env by variable name
      evaluateNodeProperty: (value: string, type: string, _node: any, msg: any) =>
        type === "msg" ? msg?.[value] : type === "env" ? testEnv[value] : value,
    },
    httpAdmin: { get: () => undefined },
    auth: { needsPermission: () => () => undefined },
    log: { info: () => undefined },
  };
  jest.isolateModules(() => {
    require("../src/cip-read")(RED);
  });
}

const endpoints: Record<string, any> = {};
const testEnv: Record<string, string> = { TAG: "EnvTag", RATE: "3000", BADRATE: "soon" };

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
  readCtor.call(node, { id: "read1", name: "r", endpoint: "ep1", dataType: "auto", ...config });
  return node;
}

const read = (node: any, msg: any) =>
  new Promise<void>((resolve) => node.emit("input", msg, node.send, () => resolve()));

/** Send a message and resolve with whatever the node passed to done(). */
const readError = (node: any, msg: any) =>
  new Promise<Error>((resolve) => node.emit("input", msg, node.send, (err: Error) => resolve(err)));

beforeAll(() => loadModule());

describe("tag name construction", () => {
  it("does not repeat the program scope in the tag name", async () => {
    const controller = makeController();
    const node = makeReadNode(controller);

    await read(node, { tagName: "Program:MainProgram.Speed" });

    // The scope belongs in the program argument, not in the name as well. Sending both
    // produced "Program:MainProgram.Program:MainProgram.Speed" on the wire.
    expect(controller.built).toEqual([{ name: "Speed", program: "MainProgram" }]);
  });

  it("leaves an ordinary tag name alone", async () => {
    const controller = makeController();
    const node = makeReadNode(controller);

    await read(node, { tagName: "Temperature" });

    expect(controller.built).toEqual([{ name: "Temperature", program: null }]);
  });

  it("keeps the array index on a program-scoped element read", async () => {
    const controller = makeController();
    const node = makeReadNode(controller);

    await read(node, { tagName: "Program:MainProgram.Speeds[3]" });

    expect(controller.built).toEqual([{ name: "Speeds[3]", program: "MainProgram" }]);
  });
});

describe("batch reads from msg.tags", () => {
  const payloadOf = (node: any) => node.send.mock.calls[0][0].payload;

  it("reads a comma separated string", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { tagName: "Configured" });

    await read(node, { tags: "Alpha, Beta" });

    expect(controller.built.map((b) => b.name)).toEqual(["Alpha", "Beta"]);
    expect(payloadOf(node).map((r: any) => r.tagName)).toEqual(["Alpha", "Beta"]);
  });

  it("accepts name and tagName objects, as cip-subscribe and cip-read emit", async () => {
    const controller = makeController();
    const node = makeReadNode(controller);

    await read(node, {
      tags: [
        { name: "Alpha", value: 1, type: "DINT", changed: true },
        { tagName: "Beta", value: 2, type: "DINT" },
      ],
    });

    expect(payloadOf(node).map((r: any) => r.tagName)).toEqual(["Alpha", "Beta"]);
  });

  it("fails before reading anything when an entry is malformed", async () => {
    const controller = makeController();
    const node = makeReadNode(controller);

    const err = await readError(node, { tags: ["Alpha", 42, { value: 1 }, null, "", "Beta"] });

    expect(node.send).not.toHaveBeenCalled();
    expect(controller.built).toEqual([]);
    // Every bad entry is named, with its position
    expect(err.message).toMatch(/nothing was read/);
    expect(err.message).toMatch(/tags\[1\].*got number/);
    expect(err.message).toMatch(/tags\[2\].*needs a "name" or "tagName"/);
    expect(err.message).toMatch(/tags\[3\].*got null/);
    expect(err.message).toMatch(/tags\[4\].*empty/);
  });

  it("fails before reading anything on an invalid arraySize", async () => {
    const controller = makeController();
    const node = makeReadNode(controller);

    const err = await readError(node, {
      tags: [{ name: "Arr", arraySize: 0 }, { name: "Arr2", arraySize: 4 }],
    });

    expect(node.send).not.toHaveBeenCalled();
    expect(err.message).toMatch(/Invalid arraySize 0 for "Arr"/);
  });

  it("gives a tag the controller rejects its own error and still reads the others", async () => {
    const controller = {
      ...makeController(),
      readTagGroup: () => Promise.reject({ generalStatusCode: 5, extendedStatus: [] }),
      readTag: (tag: any) =>
        tag.name === "Missing"
          ? Promise.reject({ generalStatusCode: 5, extendedStatus: [] })
          : Promise.resolve(),
    };
    const node = makeReadNode(controller);

    await read(node, { tags: ["Alpha", "Missing", "Beta"] });

    // payload[i] answers tags[i]
    const payload = payloadOf(node);
    expect(payload.map((r: any) => r.tagName)).toEqual(["Alpha", "Missing", "Beta"]);
    expect(payload[0]).toMatchObject({ value: 60 });
    expect(payload[0].error).toBeUndefined();
    expect(payload[1].value).toBeNull();
    expect(payload[1].error).toMatch(/0x05/);
    expect(payload[2]).toMatchObject({ value: 60 });
    const status = node.status.mock.calls[node.status.mock.calls.length - 1][0];
    expect(status.fill).toBe("yellow");
    expect(status.text).toMatch(/2 of 3 tags read/);
  });

  it("fails the batch when the group read fails without a CIP status", async () => {
    const controller = {
      ...makeController(),
      readTagGroup: () => Promise.reject(new Error("socket closed")),
    };
    const node = makeReadNode(controller);

    const err = await readError(node, { tags: ["Alpha", "Beta"] });

    expect(node.send).not.toHaveBeenCalled();
    expect(err.message).toMatch(/socket closed/);
  });

  it("msg.tags wins over the configured Tag Name", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { tagName: "Configured" });

    await read(node, { tags: ["Alpha"] });

    expect(controller.built.map((b) => b.name)).toEqual(["Alpha"]);
  });

  it("ignores an empty string and reads the configured tag", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { tagName: "Configured" });

    await read(node, { tags: "  " });

    expect(controller.built.map((b) => b.name)).toEqual(["Configured"]);
  });
});

describe("a node with a mode", () => {
  const payloadOf = (node: any) => node.send.mock.calls[0][0].payload;
  const builtNames = (controller: any) => controller.built.map((b: any) => b.name);

  it("ignores msg.tagName and msg.tags when the tag is a str", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { mode: "single", tagName: "Configured", tagNameType: "str" });

    await read(node, { tagName: "FromMsg", tags: ["Other"] });

    expect(builtNames(controller)).toEqual(["Configured"]);
  });

  it("still lets msg.tagName override a node that has no mode", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { tagName: "Configured" });

    await read(node, { tagName: "FromMsg" });

    expect(builtNames(controller)).toEqual(["FromMsg"]);
  });

  it("takes the tag from the message property it names", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { mode: "single", tagName: "which", tagNameType: "msg" });

    await read(node, { which: "Alpha", tagName: "Ignored" });

    expect(builtNames(controller)).toEqual(["Alpha"]);
  });

  it("takes the tag from an environment variable", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { mode: "single", tagName: "TAG", tagNameType: "env" });

    await read(node, {});

    expect(builtNames(controller)).toEqual(["EnvTag"]);
  });

  it("warns and sends nothing when the tag is empty", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { mode: "single", tagName: "tagName", tagNameType: "msg" });

    await read(node, {});

    expect(node.warn).toHaveBeenCalledWith("No tag name specified");
    expect(node.send).not.toHaveBeenCalled();
  });

  it("fails on an array size that is not a positive whole number", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, {
      mode: "single",
      tagName: "Arr",
      dataType: "ARRAY",
      arraySizeType: "msg",
      arraySize: "size",
    });

    const err = await readError(node, { size: 0 });

    expect(err.message).toMatch(/Invalid array size for "Arr" 0/);
    expect(node.send).not.toHaveBeenCalled();
    expect(controller.built).toEqual([]);
  });

  it("reads the configured list in order and ignores msg.tags", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, {
      mode: "multiple",
      tagList: [
        { tagName: "Alpha", tagNameType: "str", dataType: "auto" },
        { tagName: "TAG", tagNameType: "env", dataType: "auto" },
      ],
    });

    await read(node, { tags: ["Ignored"] });

    expect(payloadOf(node).map((r: any) => r.tagName)).toEqual(["Alpha", "EnvTag"]);
  });

  it("refuses an invalid list row before reading anything", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, {
      mode: "multiple",
      tagList: [{ tagName: "Alpha" }, { tagName: "" }],
    });

    const err = await readError(node, {});

    expect(err.message).toMatch(/^Invalid tag list, nothing was read/);
    expect(err.message).toMatch(/tags\[1\].*empty/);
    expect(node.send).not.toHaveBeenCalled();
  });

  it("reads msg.tags by default in multiple from msg", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { mode: "multiple-msg", tagName: "Configured" });

    await read(node, { tags: "Alpha, Beta", tagName: "Ignored" });

    expect(payloadOf(node).map((r: any) => r.tagName)).toEqual(["Alpha", "Beta"]);
  });

  it("reads the message property that multiple from msg names", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { mode: "multiple-msg", tagsProp: "list", tagsPropType: "msg" });

    await read(node, { list: ["Alpha"], tags: ["Ignored"] });

    expect(builtNames(controller)).toEqual(["Alpha"]);
  });

  it("refuses a malformed entry in multiple from msg, naming the property", async () => {
    const controller = makeController();
    const node = makeReadNode(controller, { mode: "multiple-msg", tagsProp: "list", tagsPropType: "msg" });

    const err = await readError(node, { list: ["Alpha", 1] });

    expect(err.message).toMatch(/^Invalid msg\.list, nothing was read/);
    expect(node.send).not.toHaveBeenCalled();
  });

  it("warns when multiple from msg has no tags", async () => {
    const node = makeReadNode(makeController(), { mode: "multiple-msg" });

    await read(node, {});

    expect(node.warn).toHaveBeenCalledWith("No tags in msg.tags");
    expect(node.send).not.toHaveBeenCalled();
  });
});

describe("warning about message properties a node with a mode ignores", () => {
  const warnings = (node: any) => node.warn.mock.calls.map((c: any[]) => c[0]);

  it("warns once about msg.tags on a node that reads its tag from its settings", async () => {
    const node = makeReadNode(makeController(), { mode: "single", tagName: "Configured", tagNameType: "str" });

    await read(node, { tags: ["Other"] });
    await read(node, { tags: ["Other"] });
    await read(node, { tags: ["Other"] });

    const found = warnings(node).filter((w: string) => w.startsWith("Ignoring msg.tags"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/Multiple from msg/);
  });

  it("warns once about msg.arraySize", async () => {
    const node = makeReadNode(makeController(), { mode: "single", tagName: "Arr", dataType: "ARRAY" });

    await read(node, { arraySize: 5 });
    await read(node, { arraySize: 5 });

    const found = warnings(node).filter((w: string) => w.startsWith("Ignoring msg.arraySize"));
    expect(found).toHaveLength(1);
  });

  it("warns about each property once, not once between them", async () => {
    const node = makeReadNode(makeController(), { mode: "single", tagName: "A" });

    await read(node, { tags: ["X"] });
    await read(node, { tags: ["X"], arraySize: 3 });

    expect(warnings(node).filter((w: string) => w.startsWith("Ignoring"))).toHaveLength(2);
  });

  it("does not warn about tagName or dataType, so a chain of cip-read nodes stays quiet", async () => {
    const node = makeReadNode(makeController(), { mode: "single", tagName: "Configured", tagNameType: "str" });

    await read(node, { tagName: "FromUpstream", dataType: "DINT", payload: 1 });

    expect(node.warn).not.toHaveBeenCalled();
  });

  it("does not warn when multiple from msg reads msg.tags", async () => {
    const node = makeReadNode(makeController(), { mode: "multiple-msg" });

    await read(node, { tags: ["A"] });

    expect(node.warn).not.toHaveBeenCalled();
  });

  it("does not warn when the array size is read from msg.arraySize", async () => {
    const node = makeReadNode(makeController(), {
      mode: "single",
      tagName: "Arr",
      dataType: "ARRAY",
      arraySizeType: "msg",
      arraySize: "arraySize",
    });

    await read(node, { arraySize: 5 });

    expect(node.warn).not.toHaveBeenCalled();
  });

  it("does not warn a node that has no mode, where msg.tags still wins", async () => {
    const node = makeReadNode(makeController(), { tagName: "Configured" });

    await read(node, { tags: ["Other"], arraySize: 5 });

    expect(node.warn).not.toHaveBeenCalled();
  });
});

describe("polling for a node with a mode", () => {
  it("polls at a num interval from a fixed source", () => {
    const node = makeReadNode(makeController(), {
      mode: "single",
      tagName: "A",
      pollIntervalType: "num",
      pollInterval: 2000,
    });
    expect(node.pollInterval).toBe(2000);
  });

  it("polls at an interval from an environment variable", () => {
    const node = makeReadNode(makeController(), {
      mode: "multiple",
      tagList: [{ tagName: "A" }],
      pollIntervalType: "env",
      pollInterval: "RATE",
    });
    expect(node.pollInterval).toBe(3000);
  });

  it("does not poll with type none", () => {
    const node = makeReadNode(makeController(), { mode: "single", tagName: "A", pollIntervalType: "none", pollInterval: 500 });
    expect(node.pollInterval).toBe(0);
  });

  it("does not poll when a message supplies the tag, and warns", () => {
    const node = makeReadNode(makeController(), {
      mode: "single",
      tagName: "which",
      tagNameType: "msg",
      pollIntervalType: "num",
      pollInterval: 2000,
    });
    expect(node.pollInterval).toBe(0);
    expect(node.warn).toHaveBeenCalledTimes(1);
    expect(node.warn.mock.calls[0][0]).toMatch(/Poll interval ignored/);
  });

  it("does not poll in multiple from msg, and warns", () => {
    const node = makeReadNode(makeController(), { mode: "multiple-msg", pollIntervalType: "num", pollInterval: 1000 });
    expect(node.pollInterval).toBe(0);
    expect(node.warn).toHaveBeenCalledTimes(1);
  });

  it("names an interval that is not usable and does not poll", () => {
    const node = makeReadNode(makeController(), {
      mode: "single",
      tagName: "A",
      pollIntervalType: "env",
      pollInterval: "BADRATE",
    });
    expect(node.pollInterval).toBe(0);
    expect(node.error).toHaveBeenCalledTimes(1);
    expect(node.error.mock.calls[0][0]).toContain('"soon"');
  });

  it("keeps the saved interval of a node with no mode", () => {
    const node = makeReadNode(makeController(), { tagName: "A", pollInterval: 500 });
    expect(node.pollInterval).toBe(500);
    expect(node.warn).not.toHaveBeenCalled();
  });
});

describe("polling an invalid configuration", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("reports an invalid tag list once and stops polling", async () => {
    const node = makeReadNode(makeController(), {
      mode: "multiple",
      tagList: [{ tagName: "Alpha" }, { tagName: "" }],
      pollIntervalType: "num",
      pollInterval: 20,
    });

    node.emit("cip:connected");
    await wait(150);

    expect(node.error).toHaveBeenCalledTimes(1);
    expect(node.error.mock.calls[0][0]).toMatch(/^Invalid tag list, nothing was read.*Polling stopped\.$/);
    expect(node._pollTimer).toBeNull();
    expect(node.send).not.toHaveBeenCalled();
  });

  it("polls again after the endpoint reconnects", async () => {
    const node = makeReadNode(makeController(), {
      mode: "multiple",
      tagList: [{ tagName: "" }],
      pollIntervalType: "num",
      pollInterval: 20,
    });

    node.emit("cip:connected");
    await wait(100);
    node.emit("cip:connected");
    await wait(100);

    expect(node.error).toHaveBeenCalledTimes(2);
    node.emit("cip:disconnected");
  });

  it("keeps polling a tag the PLC rejects but reports it once, and again after it recovers", async () => {
    const good = makeController();
    const controller: any = { ...good, readTag: () => Promise.reject({ generalStatusCode: 5, extendedStatus: [] }) };
    const node = makeReadNode(controller, {
      mode: "single",
      tagName: "Missing",
      pollIntervalType: "num",
      pollInterval: 20,
    });

    node.emit("cip:connected");
    await wait(150);
    expect(node.error).toHaveBeenCalledTimes(1);
    expect(node._pollTimer).not.toBeNull();

    controller.readTag = good.readTag;
    await wait(100);
    expect(node.send).toHaveBeenCalled();

    controller.readTag = () => Promise.reject({ generalStatusCode: 5, extendedStatus: [] });
    await wait(100);
    expect(node.error).toHaveBeenCalledTimes(2);
    node.emit("cip:disconnected");
  });

  it("leaves a message that fails alone, so it can be fixed and sent again", async () => {
    const node = makeReadNode(makeController(), {
      mode: "multiple-msg",
    });

    const err = await readError(node, { tags: ["Alpha", 5] });

    expect(err.message).not.toMatch(/Polling stopped/);
  });
});

describe("failure reporting", () => {
  it("renders a bare CIP rejection rather than passing undefined to node.status", async () => {
    const controller = {
      ...makeController(),
      readTag: () => Promise.reject({ generalStatusCode: 5, extendedStatus: [] }),
    };
    const node = makeReadNode(controller);

    await read(node, { tagName: "Nope" });

    const status = node.status.mock.calls[node.status.mock.calls.length - 1][0];
    // Node-RED calls .toString() on this whenever a Status node is attached.
    expect(typeof status.text).toBe("string");
    expect(status.text).toBe("Path destination unknown (CIP 0x05)");
  });
});
