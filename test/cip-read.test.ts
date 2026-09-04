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
  return { Tag: FakeTag, TagGroup: class {}, Structure: class {} };
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
