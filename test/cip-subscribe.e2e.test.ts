/**
 * End-to-end test for the cip-subscribe node against the simulator: array ranges such as
 * "MyIntArray[0..2]", and change detection on array values.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const SUBSCRIBE_NODE = path.join(__dirname, "..", "nodes", "cip-subscribe.js");
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

/** A cip-subscribe node on the live controller. `connect()` starts it, as the endpoint would. */
function makeSubscribeNode(config: Record<string, any>) {
  const endpoint = {
    connected: true,
    getController: () => plc,
    register: () => {},
    deregister: (_node: any, done?: () => void) => done && done(),
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
  require(SUBSCRIBE_NODE)(RED);

  const handlers: Record<string, any> = {};
  const sent: any[] = [];
  const warnings: string[] = [];
  const node: any = Object.create(RED._ctor.prototype);
  node.status = () => {};
  node.log = () => {};
  node.warn = (m: string) => warnings.push(String(m));
  node.error = () => {};
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.send = (msg: any) => sent.push(msg);

  RED._ctor.call(node, { endpoint: "ep", scanRate: 100, deadband: 0, diffOnly: true, ...config });

  return {
    sent,
    warnings,
    connect: () => handlers["cip:connected"](),
    close: () => new Promise<void>((resolve) => handlers.close(false, resolve)),
  };
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function writeElement(name: string, value: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Tag } = require("st-ethernet-ip");
  const tag = new Tag(name);
  await plc.readTag(tag);
  tag.value = value;
  await plc.writeTag(tag);
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

describe("cip-subscribe array ranges", () => {
  it("reads a range as an array, under the name it was configured with", async () => {
    const sub = makeSubscribeNode({ tags: "MyIntArray[0..2]" });
    sub.connect();
    await until(() => sub.sent.length > 0);
    await sub.close();

    expect(sub.warnings).toEqual([]);
    const msg = sub.sent[0];
    expect(msg.tagName).toBe("MyIntArray[0..2]");
    expect(msg.payload).toEqual([100, 200, 300]);
    expect(msg.dataType).toBe("INT");
  });

  it("puts a range among other tags", async () => {
    const sub = makeSubscribeNode({ tags: "MyDint,MyIntArray[1..3],MyRealArray[0..1]" });
    sub.connect();
    await until(() => sub.sent.length > 0);
    await sub.close();

    expect(sub.warnings).toEqual([]);
    const { payload, tags } = sub.sent[0];
    expect(payload["MyDint"]).toBe(42);
    expect(payload["MyIntArray[1..3]"]).toEqual([200, 300, 400]);
    expect(payload["MyRealArray[0..1]"]).toHaveLength(2);
    // The type is a name, not "0x" and the name
    expect(tags.map((t: any) => t.type)).toEqual(["DINT", "INT", "REAL"]);
  });

  it("does not send again while nothing changes", async () => {
    const sub = makeSubscribeNode({ tags: "MyIntArray[4..6]" });
    sub.connect();
    await until(() => sub.sent.length > 0);
    await new Promise((r) => setTimeout(r, 600));
    await sub.close();
    expect(sub.sent).toHaveLength(1);
  });

  it("sends when one element of a range changes", async () => {
    const sub = makeSubscribeNode({ tags: "MyIntArray[7..9]" });
    sub.connect();
    await until(() => sub.sent.length > 0);
    expect(sub.sent[0].payload).toEqual([800, 900, 1000]);

    await writeElement("MyIntArray[8]", 901);
    await until(() => sub.sent.length > 1);
    await sub.close();

    expect(sub.sent[1].payload).toEqual([800, 901, 1000]);
    expect(sub.sent[1].changed).toBe(true);
    await writeElement("MyIntArray[8]", 900);
  });

  it("refuses a backwards range, and still reads the other tags", async () => {
    const sub = makeSubscribeNode({ tags: "MyDint,MyIntArray[3..1]" });
    sub.connect();
    await until(() => sub.sent.length > 0);
    await sub.close();

    expect(sub.warnings).toHaveLength(1);
    expect(sub.warnings[0]).toMatch(/MyIntArray\[3\.\.1\].*ends before it starts/);
    expect(sub.sent[0].payload).toBe(42);
  });
});
