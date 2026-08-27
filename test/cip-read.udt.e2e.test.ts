/**
 * End-to-end test for issue #4: the real cip-read node against a simulated
 * ControlLogix that holds arrays both as plain tags and inside nested UDTs.
 *
 * The reported symptoms were a UDT read coming back as a raw `Buffer` and an
 * array read coming back as its element `[0]`, so every assertion here is about
 * getting the *whole* value back.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const READ_NODE = path.join(__dirname, "..", "nodes", "cip-read.js");
// st-ethernet-ip always dials the standard EtherNet/IP port, so the simulator
// has to listen on it for this suite.
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

/** A cip-read node wired to the live controller, plus a promise-returning read. */
function makeReadNode(config: Record<string, any>) {
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
  require(READ_NODE)(RED);

  const handlers: Record<string, any> = {};
  const node: any = Object.create(RED._ctor.prototype);
  node.status = () => {};
  node.log = () => {};
  node.warn = () => {};
  node.error = (m: string) => {
    if (node._reject) node._reject(new Error(m));
  };
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.send = (msg: any) => {
    if (node._resolve) node._resolve(msg);
  };

  RED._ctor.call(node, { endpoint: "ep", ...config });

  const read = (msg: Record<string, any> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      node._resolve = resolve;
      node._reject = reject;
      handlers.input(msg);
    });

  return { node, read, close: () => handlers.close && handlers.close(() => {}) };
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

describe("array tags", () => {
  test("auto-detect reads every element, not just [0]", async () => {
    const { read, close } = makeReadNode({ tagName: "MyIntArray", dataType: "auto" });
    const msg = await read();
    close();
    expect(msg.payload).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
  });

  test("explicit ARRAY reads every element", async () => {
    const { read, close } = makeReadNode({ tagName: "MyRealArray", dataType: "ARRAY" });
    const msg = await read();
    close();
    expect(msg.payload).toHaveLength(5);
    expect(msg.payload[0]).toBeCloseTo(1.1, 5);
    expect(msg.payload[4]).toBeCloseTo(5.5, 5);
  });

  test("msg.arraySize overrides the resolved length", async () => {
    const { read, close } = makeReadNode({ tagName: "MyIntArray", dataType: "auto" });
    const msg = await read({ arraySize: 3 });
    close();
    expect(msg.payload).toEqual([100, 200, 300]);
  });

  test("a program-scoped array reads in full", async () => {
    const { read, close } = makeReadNode({
      tagName: "Program:MainProgram.Recipe",
      dataType: "auto",
    });
    const msg = await read();
    close();
    expect(msg.payload).toEqual([11, 22, 33, 44, 55, 66, 77, 88]);
  });

  test("a program-scoped scalar reads its value", async () => {
    const { read, close } = makeReadNode({
      tagName: "Program:MainProgram.Speed",
      dataType: "auto",
    });
    const msg = await read();
    close();
    expect(msg.payload).toBeCloseTo(60, 5);
  });

  test("a subscripted path still reads the single element", async () => {
    const { read, close } = makeReadNode({ tagName: "MyIntArray[2]", dataType: "auto" });
    const msg = await read();
    close();
    expect(msg.payload).toBe(300);
    expect(msg.arrayIndex).toBe(2);
  });
});

describe("UDT tags", () => {
  test("a nested UDT decodes into an object, not a raw buffer", async () => {
    const { read, close } = makeReadNode({ tagName: "FIS_Stn[0].Local", dataType: "auto" });
    const msg = await read();
    close();

    expect(Buffer.isBuffer(msg.payload)).toBe(false);
    expect(msg.dataType).toBe("STRUCT");
    expect(msg.payload.FBCONTROL).toEqual([0, 7]);
    expect(msg.payload.FBRESULT).toEqual([11, 22]);
    expect(msg.payload.FBFACTUAL).toHaveLength(102);
    expect(msg.payload.FBFACTUAL[101]).toBeCloseTo(101, 5);
    expect(msg.payload.FBCOMPARE).toHaveLength(102);
  });

  test("the tag path is matched case-insensitively, as Logix does", async () => {
    const { read, close } = makeReadNode({ tagName: "fis_stn[1].local", dataType: "auto" });
    const msg = await read();
    close();

    expect(Buffer.isBuffer(msg.payload)).toBe(false);
    expect(msg.payload.FBCONTROL).toEqual([1, 7]);
    expect(msg.payload.FBFACTUAL[0]).toBeCloseTo(1000, 5);
  });

  test("an array member of a UDT reads its full length", async () => {
    const { read, close } = makeReadNode({
      tagName: "FIS_Stn[2].Local.FBFACTUAL",
      dataType: "ARRAY",
    });
    const msg = await read();
    close();

    expect(Array.isArray(msg.payload)).toBe(true);
    expect(msg.payload).toHaveLength(102);
    expect(msg.payload[0]).toBeCloseTo(2000, 5);
    expect(msg.payload[101]).toBeCloseTo(2101, 5);
  });

  test("auto-detect finds a UDT array member without being told", async () => {
    const { read, close } = makeReadNode({
      tagName: "FIS_Stn[3].Local.FBCOMPARE",
      dataType: "auto",
    });
    const msg = await read();
    close();

    expect(msg.payload).toHaveLength(102);
    expect(msg.payload[0]).toBeCloseTo(-1, 5);
    expect(msg.payload[101]).toBeCloseTo(-102, 5);
  });

  test("a range reads just that slice of a UDT array member", async () => {
    const { read, close } = makeReadNode({
      tagName: "FIS_Stn[0].Local.FBFACTUAL[10..19]",
      dataType: "auto",
    });
    const msg = await read();
    close();

    expect(msg.payload).toHaveLength(10);
    expect(msg.payload[0]).toBeCloseTo(10, 5);
    expect(msg.payload[9]).toBeCloseTo(19, 5);
  });

  test("a single element of a UDT array member reads as a scalar", async () => {
    const { read, close } = makeReadNode({
      tagName: "FIS_Stn[0].Local.FBFACTUAL[7]",
      dataType: "auto",
    });
    const msg = await read();
    close();
    expect(msg.payload).toBeCloseTo(7, 5);
  });

  test("an array of UDTs reads as one object per element", async () => {
    const { read, close } = makeReadNode({ tagName: "FIS_Stn", dataType: "auto" });
    const msg = await read();
    close();

    expect(Array.isArray(msg.payload)).toBe(true);
    expect(msg.payload).toHaveLength(5);
    expect(msg.payload[0].Local.FBCONTROL).toEqual([0, 7]);
    expect(msg.payload[4].Local.FBCONTROL).toEqual([4, 7]);
  });

  test("batch mode returns whole arrays and structs too", async () => {
    const { read, close } = makeReadNode({ tagName: "", dataType: "auto" });
    const msg = await read({ tags: ["MyDint", "MyIntArray", "FIS_Stn[0].Local.FBRESULT"] });
    close();

    const byName = Object.fromEntries(msg.payload.map((r: any) => [r.tagName, r.value]));
    expect(byName.MyDint).toBe(42);
    expect(byName.MyIntArray).toHaveLength(10);
    expect(byName["FIS_Stn[0].Local.FBRESULT"]).toEqual([11, 22]);
  });
});
