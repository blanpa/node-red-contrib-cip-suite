/**
 * The real cip-write node against the simulator, once upgraded: where the values come from,
 * how several tags are matched to values, and that a bad message writes nothing.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const WRITE_NODE = path.join(__dirname, "..", "nodes", "cip-write.js");
const TCP_PORT = 44818;

let sim: ChildProcess;
let plc: any;

function waitForSimReady(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("simulator did not start in time")), timeoutMs);
    proc.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("CIP PLC Simulator")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on("error", reject);
  });
}

const row = (tagName: string, extra: Record<string, any> = {}) => ({ tagName, tagNameType: "str", dataType: "auto", ...extra });

/** A cip-write node wired to the live controller. write() resolves with what the node sent. */
function makeWriteNode(config: Record<string, any>) {
  const endpoint = {
    connected: true,
    getController: () => plc,
    register: () => {},
    deregister: () => {},
  };
  const RED: any = {
    nodes: {
      createNode() {},
      getNode: () => endpoint,
      registerType(_name: string, ctor: any) {
        RED._ctor = ctor;
      },
    },
    util: {
      evaluateNodeProperty: (value: string, type: string, _node: any, msg: any) => {
        if (type === "msg") return value.split(".").reduce((o: any, k: string) => (o == null ? undefined : o[k]), msg);
        if (type === "num") return Number(value);
        if (type === "bool") return value === "true";
        if (type === "json") return JSON.parse(value);
        return value;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(WRITE_NODE)(RED);

  const handlers: Record<string, any> = {};
  const node: any = Object.create(RED._ctor.prototype);
  node.status = jest.fn();
  node.log = () => {};
  node.warn = jest.fn();
  node.error = jest.fn();
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.send = jest.fn();
  RED._ctor.call(node, { endpoint: "ep", ...config });

  /** Send a message and wait for the node to finish. `error` is what it passed to done(). */
  const write = async (msg: Record<string, any>): Promise<{ sent?: any; error?: Error }> => {
    node.send.mockClear();
    node.error.mockClear();
    let error: Error | undefined;
    await handlers.input(msg, node.send, (err?: Error) => {
      error = err;
    });
    return { sent: node.send.mock.calls.length ? node.send.mock.calls[0][0] : undefined, error };
  };
  return { node, write };
}

async function readValue(name: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Tag } = require("st-ethernet-ip");
  const tag = new Tag(name);
  await plc.readTag(tag);
  return tag.value;
}

beforeAll(async () => {
  sim = spawn(process.execPath, [SIM], {
    env: { ...process.env, PLC_TYPE: "controllogix", EIP_PORT: String(TCP_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForSimReady(sim, 8000);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Controller } = require("st-ethernet-ip");
  plc = new Controller(true);
  plc.timeout_sp = 4000;
  await plc.connect("127.0.0.1", 0, true);
}, 30000);

afterAll(async () => {
  if (plc) await plc.disconnect().catch(() => {});
  if (sim && !sim.killed) sim.kill("SIGKILL");
});

describe("an upgraded cip-write node with one tag", () => {
  const one = (extra: Record<string, any> = {}) => ({
    mode: "ui",
    output: "result",
    tagList: [row("MyDint")],
    value: "payload",
    valueType: "msg",
    ...extra,
  });

  it("writes msg.payload and ignores msg.tagName and msg.tags", async () => {
    const { node, write } = makeWriteNode(one());

    const { sent } = await write({ payload: 31, tagName: "MyInt", tags: [{ name: "MyInt", value: 1 }] });

    expect(sent.payload).toMatchObject({ success: true, tagName: "MyDint", value: 31 });
    expect(await readValue("MyDint")).toBe(31);
    expect(node.warn.mock.calls[0][0]).toMatch(/Ignoring msg\.tags/);
  });

  it.each([
    ["num", "88", 88],
    ["str", "89", 89],
    ["json", "90", 90],
  ])("writes a fixed %s value, not msg.payload", async (valueType, value, expected) => {
    const { write } = makeWriteNode(one({ value, valueType }));

    const { sent } = await write({ payload: 1 });

    expect(sent.payload.success).toBe(true);
    expect(await readValue("MyDint")).toBe(expected);
  });

  it("takes the tag from the message when the row says msg", async () => {
    const { write } = makeWriteNode(one({ tagList: [{ tagName: "which", tagNameType: "msg" }] }));

    const { sent } = await write({ which: "MyInt", payload: 7 });

    expect(sent.payload.tagName).toBe("MyInt");
    expect(await readValue("MyInt")).toBe(7);
  });

  it("checks the row's data type, and sends the failed result with an error", async () => {
    const { write } = makeWriteNode(one({ tagList: [row("MyDint", { dataType: "REAL" })] }));

    const { sent, error } = await write({ payload: 1.5 });

    expect(sent.payload.success).toBe(false);
    expect(sent.payload.error).toBe("MyDint is DINT, but the node's Data Type is REAL");
    expect(error?.message).toMatch(/Write failed for MyDint/);
  });

  it("fails without a value", async () => {
    const { error, sent } = await write1({});

    expect(sent).toBeUndefined();
    expect(error?.message).toBe("No value to write");

    function write1(msg: any) {
      return makeWriteNode(one()).write(msg);
    }
  });
});

describe("an upgraded cip-write node with several tags", () => {
  const several = (extra: Record<string, any> = {}) => ({
    mode: "ui",
    output: "array",
    tagList: [row("MyDint", { alias: "speed" }), row("MyInt"), row("MyBool")],
    value: "payload",
    valueType: "msg",
    ...extra,
  });

  it("writes an array of values by position, with the alias in each result", async () => {
    const { write } = makeWriteNode(several());

    const { sent } = await write({ payload: [41, 42, true] });

    expect(sent.payload.map((r: any) => [r.alias, r.tagName, r.success])).toEqual([
      ["speed", "MyDint", true],
      [undefined, "MyInt", true],
      [undefined, "MyBool", true],
    ]);
    expect(await readValue("MyDint")).toBe(41);
    expect(await readValue("MyInt")).toBe(42);
    expect(await readValue("MyBool")).toBe(true);
  });

  it("writes an object keyed by alias or tag", async () => {
    const { write } = makeWriteNode(several());

    await write({ payload: { MyBool: false, speed: 51, MyInt: 52 } });

    expect(await readValue("MyDint")).toBe(51);
    expect(await readValue("MyInt")).toBe(52);
    expect(await readValue("MyBool")).toBe(false);
  });

  it("writes the entries a cip-read sends, ignoring the extras", async () => {
    const { write } = makeWriteNode(several());

    await write({
      payload: [
        { tagName: "MyInt", value: 62, type: "INT" },
        { alias: "speed", tagName: "MyDint", value: 61, type: "DINT" },
        { tagName: "MyBool", value: true, type: "BOOL" },
      ],
    });

    expect(await readValue("MyDint")).toBe(61);
    expect(await readValue("MyInt")).toBe(62);
  });

  it("writes nothing when a value is missing, or the name is wrong", async () => {
    await makeWriteNode(several()).write({ payload: [1, 1, true] });
    const { write } = makeWriteNode(several());

    const missing = await write({ payload: { speed: 99, MyInt: 99 } });
    const typo = await write({ payload: { speed: 99, MyInt: 99, MyBool: true, Typo: 1 } });

    expect(missing.sent).toBeUndefined();
    expect(missing.error?.message).toMatch(/No value for "MyBool", nothing was written/);
    expect(typo.error?.message).toMatch(/"Typo" is not one of the tags/);
    expect(await readValue("MyDint")).toBe(1);
    expect(await readValue("MyInt")).toBe(1);
  });

  it("writes the other tags when one is refused by the PLC, and reports it in the results", async () => {
    const { write } = makeWriteNode(several({ tagList: [row("MyDint"), row("NoSuchTag"), row("MyInt")] }));

    const { sent, error } = await write({ payload: [71, 72, 73] });

    expect(error).toBeUndefined();
    expect(sent.payload.map((r: any) => r.success)).toEqual([true, false, true]);
    expect(sent.payload[1].error).toBeTruthy();
    expect(await readValue("MyDint")).toBe(71);
    expect(await readValue("MyInt")).toBe(73);
  });

  it("sends Key Result pairs, and writes the Key Result pairs of a read", async () => {
    const { write } = makeWriteNode(several({ output: "keyresult" }));

    const { sent } = await write({
      payload: {
        speed: { tagName: "MyDint", value: 111, type: "DINT" },
        MyInt: { tagName: "MyInt", value: 112, type: "INT" },
        MyBool: { tagName: "MyBool", value: true, type: "BOOL" },
      },
    });

    expect(Object.keys(sent.payload)).toEqual(["speed", "MyInt", "MyBool"]);
    expect(sent.payload.speed).toMatchObject({ success: true, tagName: "MyDint", value: 111 });
    expect(sent.payload.speed).not.toHaveProperty("alias");
    expect(await readValue("MyDint")).toBe(111);
    expect(await readValue("MyInt")).toBe(112);
  });

  it("takes the values from json fixed in the node", async () => {
    const { write } = makeWriteNode(several({ valueType: "json", value: "[81, 82, false]" }));

    await write({ payload: "ignored" });

    expect(await readValue("MyDint")).toBe(81);
    expect(await readValue("MyBool")).toBe(false);
  });
});

describe("an upgraded cip-write node in dynamic mode", () => {
  const dynamic = (extra: Record<string, any> = {}) => ({ mode: "dynamic", output: "array", ...extra });

  it("writes an array of entries and an object of values", async () => {
    const { write } = makeWriteNode(dynamic());

    const first = await write({ tags: [{ name: "MyDint", value: 91 }, { tagName: "MyInt", value: 92, type: "INT" }] });
    await write({ tags: { MyDint: 93 } });

    expect(first.sent.payload.map((r: any) => r.success)).toEqual([true, true]);
    expect(await readValue("MyInt")).toBe(92);
    expect(await readValue("MyDint")).toBe(93);
  });

  it("reads the property it names", async () => {
    const { write } = makeWriteNode(dynamic({ tagsProp: "payload.list" }));

    await write({ payload: { list: { MyDint: 94 } }, tags: { MyDint: 1 } });

    expect(await readValue("MyDint")).toBe(94);
  });

  it("writes nothing when an entry is invalid", async () => {
    const before = await readValue("MyDint");
    const { write } = makeWriteNode(dynamic());

    const { sent, error } = await write({ tags: [{ name: "MyDint", value: before + 1 }, { name: "MyInt" }] });

    expect(sent).toBeUndefined();
    expect(error?.message).toMatch(/^Invalid msg\.tags, nothing was written/);
    expect(await readValue("MyDint")).toBe(before);
  });
});

describe("a cip-write node that has not been upgraded", () => {
  it("still lets msg.tagName and msg.tags override it", async () => {
    const { write } = makeWriteNode({ tagName: "MyDint", dataType: "auto" });

    const single = await write({ payload: 101, tagName: "MyInt" });
    const batch = await write({ tags: [{ name: "MyDint", value: 102 }] });

    expect(single.sent.payload.tagName).toBe("MyInt");
    expect(batch.sent.payload[0].success).toBe(true);
    expect(await readValue("MyInt")).toBe(101);
    expect(await readValue("MyDint")).toBe(102);
  });
});
