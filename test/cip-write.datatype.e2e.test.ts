/**
 * End-to-end test for issue #19: the real cip-write node against the simulator, with the
 * Data Type option set. It used to parse the option name as hex, so BOOL/DINT failed in
 * the library and INT/REAL/STRING were silently ignored.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const WRITE_NODE = path.join(__dirname, "..", "nodes", "cip-write.js");
// st-ethernet-ip always dials the standard EtherNet/IP port.
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

  const write = (msg: Record<string, any>): Promise<any> =>
    new Promise((resolve) => {
      node._resolve = resolve;
      handlers.input(msg);
    });

  return { write };
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

describe("cip-write Data Type", () => {
  it.each([
    ["BOOL", "MyBool", true],
    ["INT", "MyInt", 4321],
    ["DINT", "MyDint", 77],
    ["REAL", "MyReal", 1.5],
  ])("%s writes a matching %s tag", async (dataType, tagName, value) => {
    const { write } = makeWriteNode({ tagName, dataType });
    const msg = await write({ payload: value });
    expect(msg.payload.success).toBe(true);
    expect(await readValue(tagName)).toBe(value);
  });

  it("refuses a tag of another type, naming both types", async () => {
    const before = await readValue("MyDint");
    const { write } = makeWriteNode({ tagName: "MyDint", dataType: "REAL" });
    const msg = await write({ payload: 2.5 });
    expect(msg.payload.success).toBe(false);
    expect(msg.payload.error).toBe("MyDint is DINT, but the node's Data Type is REAL");
    expect(await readValue("MyDint")).toBe(before);
  });

  it("checks each element of an array range", async () => {
    const { write } = makeWriteNode({ tagName: "MyIntArray[0..1]", dataType: "DINT" });
    const msg = await write({ payload: [1, 2] });
    expect(msg.payload.success).toBe(false);
    expect(msg.payload.error).toMatch(/is INT, but the node's Data Type is DINT/);
  });

  it("Auto-detect still writes without a check", async () => {
    const { write } = makeWriteNode({ tagName: "MyDint", dataType: "auto" });
    const msg = await write({ payload: 99 });
    expect(msg.payload.success).toBe(true);
    expect(await readValue("MyDint")).toBe(99);
  });
});

describe("cip-write bit access", () => {
  // Issue: writing the sign bit of a narrow signed type (INT bit 15, SINT bit 7) threw
  // "value out of range" because the software read-modify-write produced an out-of-range
  // signed 32-bit number instead of wrapping it back to the tag's own width.
  it("sets the INT sign bit (bit 15) without overflowing", async () => {
    const { write: setup } = makeWriteNode({ tagName: "MyInt", dataType: "INT" });
    await setup({ payload: 576 });

    const { write } = makeWriteNode({ tagName: "MyInt.15" });
    const msg = await write({ payload: true });
    expect(msg.payload.success).toBe(true);
    expect(await readValue("MyInt")).toBe(-32192);
  });

  it("clears an already-set INT sign bit without overflowing", async () => {
    const { write: setup } = makeWriteNode({ tagName: "MyInt", dataType: "INT" });
    await setup({ payload: -30584 });

    const { write } = makeWriteNode({ tagName: "MyInt.15" });
    const msg = await write({ payload: false });
    expect(msg.payload.success).toBe(true);
    expect(await readValue("MyInt")).toBe(2184);
  });

  // Issue #34: a bit index past the tag's width used to be silently accepted and left the
  // value unchanged while still reporting success.
  it("fails a bit index past the tag's width instead of silently doing nothing", async () => {
    const { write: setup } = makeWriteNode({ tagName: "MyInt", dataType: "INT" });
    await setup({ payload: 576 });

    const { write } = makeWriteNode({ tagName: "MyInt.16" });
    const msg = await write({ payload: true });
    expect(msg.payload.success).toBe(false);
    expect(msg.payload.error).toMatch(/out of range|bit/i);
    expect(await readValue("MyInt")).toBe(576);
  });

  // Issue #34: bit access on a non-integer tag used to fall back to treating it as a
  // 32-bit integer, corrupting the value (3.14 -> 11).
  it("fails bit access on a REAL tag instead of corrupting its value", async () => {
    const { write: setup } = makeWriteNode({ tagName: "MyReal", dataType: "REAL" });
    await setup({ payload: 3.14 });

    const { write } = makeWriteNode({ tagName: "MyReal.3" });
    const msg = await write({ payload: true });
    expect(msg.payload.success).toBe(false);
    expect(await readValue("MyReal")).toBeCloseTo(3.14, 5);
  });
});

describe("cip-write UDT", () => {
  async function readStruct(name: string): Promise<any> {
    const tag = plc.newTag(name, null, false);
    await plc.readTag(tag);
    return tag.value;
  }

  it("writes some members of a UDT and keeps the rest", async () => {
    const before = await readStruct("FIS_Stn[1].Local");
    const { write } = makeWriteNode({ tagName: "FIS_Stn[1].Local", dataType: "auto" });
    const msg = await write({ payload: { FBCONTROL: [11, 12] } });
    expect(msg.payload.success).toBe(true);

    const after = await readStruct("FIS_Stn[1].Local");
    expect(after.FBCONTROL).toEqual([11, 12]);
    expect(after.FBRESULT).toEqual(before.FBRESULT);
    expect(after.FBFACTUAL).toEqual(before.FBFACTUAL);
  });

  it("merges into a nested UDT through an array element", async () => {
    const before = await readStruct("FIS_Stn[2].Local");
    const { write } = makeWriteNode({ tagName: "FIS_Stn[2]", dataType: "auto" });
    const msg = await write({ payload: { local: { FBRESULT: [5] } } });
    expect(msg.payload.success).toBe(true);

    const after = await readStruct("FIS_Stn[2].Local");
    expect(after.FBRESULT).toEqual([5, before.FBRESULT[1]]);
    expect(after.FBCONTROL).toEqual(before.FBCONTROL);
  });

  it("refuses a member the UDT does not have", async () => {
    const { write } = makeWriteNode({ tagName: "FIS_Stn[3].Local", dataType: "auto" });
    const msg = await write({ payload: { Nope: 1 } });
    expect(msg.payload.success).toBe(false);
    expect(msg.payload.error).toBe("Nope is not a member of the UDT");
  });
});
