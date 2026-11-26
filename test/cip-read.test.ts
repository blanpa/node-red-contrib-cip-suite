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
    httpAdmin: { get: () => undefined },
    auth: { needsPermission: () => () => undefined },
    log: { info: () => undefined },
  };
  jest.isolateModules(() => {
    require("../src/cip-read")(RED);
  });
}

const endpoints: Record<string, any> = {};

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
