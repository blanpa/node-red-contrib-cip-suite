/**
 * End-to-end test for #42: unsigned, LREAL and bit-string tags read and written through the
 * real cip-write node and the library's Controller against the simulator.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const WRITE_NODE = path.join(__dirname, "..", "nodes", "cip-write.js");
// The simulator listens on the standard EtherNet/IP port.
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

/** A cip-write node wired to the live controller; write() resolves with the sent msg. */
function makeWriteNode(config: Record<string, any>, endpointExtras: Record<string, any> = {}) {
  const endpoint = {
    connected: true,
    getController: () => plc,
    register: () => {},
    deregister: () => {},
    ...endpointExtras,
  };
  const RED: any = {
    nodes: {
      createNode() {},
      getNode: () => endpoint,
      registerType(_name: string, ctor: any) {
        RED._ctor = ctor;
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(WRITE_NODE)(RED);

  const handlers: Record<string, any> = {};
  const node: any = Object.create(RED._ctor.prototype);
  node.status = () => {};
  node.log = () => {};
  node.warn = () => {};
  node.error = () => {};
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.send = (msg: any) => {
    if (node._resolve) node._resolve(msg);
  };

  RED._ctor.call(node, { endpoint: "ep", ...config });

  return {
    write: (msg: Record<string, any>): Promise<any> =>
      new Promise((resolve) => {
        node._resolve = resolve;
        handlers.input(msg);
      }),
  };
}

async function readTag(name: string, count?: number): Promise<{ type: string; value: any }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Tag } = require("st-ethernet-ip");
  const tag = new Tag(name);
  if (count) tag.read_size = count;
  await plc.readTag(tag);
  return { type: tag.type, value: tag.value };
}

beforeAll(async () => {
  sim = spawn(process.execPath, [SIM], {
    env: { ...process.env, PLC_TYPE: "controllogix", EIP_PORT: String(TCP_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForSimReady(sim, 8000);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Controller } = require("st-ethernet-ip");
  // The nodes apply the patch when they load; the simulator is read before any is built.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("../src/st-type-patch");
  plc = new Controller(true);
  plc.timeout_sp = 4000;
  await plc.connect("127.0.0.1", 0, true);
}, 30000);

afterAll(async () => {
  if (plc) await plc.disconnect().catch(() => {});
  if (sim && !sim.killed) sim.kill("SIGKILL");
});

const SCALARS: Array<[string, string, any, any]> = [
  // [type, tag, value held by the simulator, value to write]
  ["USINT", "MyUsint", 200, 17],
  ["UINT", "MyUint", 65000, 65535],
  ["UDINT", "MyUdint", 4000000000, 4294967295],
  ["ULINT", "MyUlint", 18446744073709551615n, 5000000000n],
  ["LREAL", "MyLreal", 2.718281828459045, -123456.789012345],
  ["BYTE", "MyByte", 0xa5, 0x3c],
  ["WORD", "MyWord", 0xbeef, 0x1234],
  ["LWORD", "MyLword", 0xdeadbeefcafen, 0x123456789abcdefn],
];

describe("numeric types", () => {
  it.each(SCALARS)("reads a %s", async (type, tagName, held) => {
    expect(await readTag(tagName)).toEqual({ type, value: held });
  });

  it.each(SCALARS)("writes a %s", async (type, tagName, _held, next) => {
    const { write } = makeWriteNode({ tagName, dataType: "auto" });
    const msg = await write({ payload: next });
    expect(msg.payload.success).toBe(true);
    expect(await readTag(tagName)).toEqual({ type, value: next });
  });

  it("writes a ULINT from digit text, past the range of a double", async () => {
    const { write } = makeWriteNode({ tagName: "MyUlint", dataType: "auto" });
    const msg = await write({ payload: "18446744073709551615" });
    expect(msg.payload.success).toBe(true);
    expect((await readTag("MyUlint")).value).toBe(18446744073709551615n);
  });

  it.each([
    ["MyUint", 65536],
    ["MyUint", -1],
    ["MyUdint", 4294967296],
    ["MyUlint", -1],
    ["MyByte", 256],
    ["MyWord", 65536],
  ])("refuses %s = %s and leaves the tag alone", async (tagName, value) => {
    const before = await readTag(tagName);
    const { write } = makeWriteNode({ tagName, dataType: "auto" });
    const msg = await write({ payload: value });
    expect(msg.payload.success).toBe(false);
    expect(await readTag(tagName)).toEqual(before);
  });

  it.each(["MyUint", "MyUdint", "MyUlint", "MyLreal", "MyByte", "MyWord", "MyLword", "MyUsint"])(
    "refuses text for %s",
    async (tagName) => {
      const { write } = makeWriteNode({ tagName, dataType: "auto" });
      const msg = await write({ payload: "Continue" });
      expect(msg.payload.success).toBe(false);
      expect(msg.payload.error).toMatch(/cannot take text/);
    }
  );
});

describe("numeric type arrays", () => {
  it.each([
    ["MyUintArray", "UINT", [1, 2, 65535, 4]],
    ["MyUdintArray", "UDINT", [1, 2, 4294967295, 4]],
    ["MyUlintArray", "ULINT", [1n, 2n, 18446744073709551615n, 4n]],
    ["MyLrealArray", "LREAL", [1.5, -2.25, 3.125e50, 4]],
  ])("reads %s", async (tagName, type, held) => {
    expect(await readTag(tagName, 4)).toEqual({ type, value: held });
  });

  it.each([
    ["MyUintArray", [10, 20, 65534]],
    ["MyUdintArray", [10, 20, 4294967294]],
    ["MyUlintArray", [10n, 20n, 18446744073709551614n]],
    ["MyLrealArray", [10.5, -20.25, 3e-100]],
  ])("writes a range of %s", async (tagName, values) => {
    const { write } = makeWriteNode({ tagName: `${tagName}[1..3]`, dataType: "auto" });
    const msg = await write({ payload: values });
    expect(msg.payload.success).toBe(true);
    expect((await readTag(`${tagName}[1]`, 3)).value).toEqual(values);
  });

  it("refuses a range with one value out of range, writing none", async () => {
    const before = await readTag("MyUintArray[0]", 4);
    const { write } = makeWriteNode({ tagName: "MyUintArray[0..2]", dataType: "auto" });
    const msg = await write({ payload: [1, 2, 70000] });
    expect(msg.payload.success).toBe(false);
    expect(await readTag("MyUintArray[0]", 4)).toEqual(before);
  });
});

describe("bit access", () => {
  it.each(["MyUint", "MyUdint", "MyByte", "MyWord", "MyUsint"])("sets and clears a bit of %s", async (tagName) => {
    await makeWriteNode({ tagName, dataType: "auto" }).write({ payload: 0 });
    const bit = makeWriteNode({ tagName: `${tagName}.3`, dataType: "auto" });

    expect((await bit.write({ payload: true })).payload.success).toBe(true);
    expect((await readTag(tagName)).value).toBe(8);
    expect((await readTag(`${tagName}.3`)).value).toBe(true);

    expect((await bit.write({ payload: false })).payload.success).toBe(true);
    expect((await readTag(tagName)).value).toBe(0);
    expect((await readTag(`${tagName}.3`)).value).toBe(false);
  });

  it("sets the top bit of a UDINT without going negative", async () => {
    await makeWriteNode({ tagName: "MyUdint", dataType: "auto" }).write({ payload: 0 });
    const bit = makeWriteNode({ tagName: "MyUdint.31", dataType: "auto" });
    expect((await bit.write({ payload: true })).payload.success).toBe(true);
    expect((await readTag("MyUdint")).value).toBe(2147483648);
  });
});

describe("atomic bit write", () => {
  /** Run an atomic bit write and return the masks the endpoint was asked to apply. */
  async function atomicMasks(tagName: string, bit: number, value: boolean) {
    const calls: Array<{ name: string; orMask: Buffer; andMask: Buffer }> = [];
    const { write } = makeWriteNode(
      { tagName: `${tagName}.${bit}`, dataType: "auto", useAtomicBitWrite: true },
      {
        readModifyWriteTag: async (name: string, orMask: Buffer, andMask: Buffer) => {
          calls.push({ name, orMask, andMask });
        },
      }
    );
    const msg = await write({ payload: value });
    expect(msg.payload.success).toBe(true);
    expect(calls).toHaveLength(1);
    return calls[0];
  }

  it.each([
    ["MyUsint", 1],
    ["MyUint", 2],
    ["MyByte", 1],
    ["MyWord", 2],
    ["MyUdint", 4],
    ["MyDint", 4],
    ["MyInt", 2],
  ])("sizes the masks for %s at %i bytes", async (tagName, size) => {
    const { name, orMask, andMask } = await atomicMasks(tagName, 3, true);
    expect(name).toBe(tagName);
    expect(orMask.length).toBe(size);
    expect(andMask.length).toBe(size);
    expect(orMask[0]).toBe(0b1000);
  });

  it("clears a bit with the AND mask", async () => {
    const { orMask, andMask } = await atomicMasks("MyUint", 9, false);
    expect([...orMask]).toEqual([0, 0]);
    expect([...andMask]).toEqual([0xff, 0xfd]);
  });
});
