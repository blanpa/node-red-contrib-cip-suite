/**
 * The real cip-subscribe node against the simulator, once upgraded: the tag list and Dynamic
 * mode, aliases, the output options, and the scan rate and deadband as typed inputs.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const SUBSCRIBE_NODE = path.join(__dirname, "..", "nodes", "cip-subscribe.js");
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
    util: {
      evaluateNodeProperty: (value: string, type: string, _node: any, msg: any) =>
        type === "msg"
          ? value.split(".").reduce((o: any, k: string) => (o == null ? undefined : o[k]), msg)
          : type === "env"
            ? ({ RATE: "120" } as any)[value]
            : value,
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(SUBSCRIBE_NODE)(RED);

  const handlers: Record<string, any> = {};
  const sent: any[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const statuses: any[] = [];
  const node: any = Object.create(RED._ctor.prototype);
  node.status = (s: any) => statuses.push(s);
  node.log = () => {};
  node.warn = (m: string) => warnings.push(String(m));
  node.error = (m: any) => errors.push(String(m));
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.send = (msg: any) => sent.push(msg);
  RED._ctor.call(node, { endpoint: "ep", diffOnly: false, ...config });

  return {
    node,
    sent,
    warnings,
    errors,
    statuses,
    connect: () => handlers["cip:connected"](),
    input: (msg: any) => handlers.input(msg, () => {}, () => {}),
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

/** Run a node until it has sent a message, then close it. */
async function firstMessage(sub: ReturnType<typeof makeSubscribeNode>): Promise<any> {
  try {
    sub.connect();
    await until(() => sub.sent.length > 0);
  } finally {
    await sub.close();
  }
  return sub.sent[0];
}

const row = (tagName: string, extra: Record<string, any> = {}) => ({ tagName, tagNameType: "str", ...extra });

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

describe("an upgraded cip-subscribe node", () => {
  it("sends the value of the one tag with the Value output", async () => {
    const msg = await firstMessage(
      makeSubscribeNode({ mode: "ui", output: "value", tagList: [row("MyDint")], scanRate: 100, scanRateType: "num" })
    );

    expect(typeof msg.payload).toBe("number");
    expect(msg).toMatchObject({ tagName: "MyDint", dataType: "DINT", changed: true, scanRate: 100 });
  });

  it("sends an object keyed by alias, or by the tag as written", async () => {
    const msg = await firstMessage(
      makeSubscribeNode({
        mode: "ui",
        output: "keyvalue",
        tagList: [row("MyDint", { alias: "speed" }), row("MyInt")],
        scanRate: 100,
        scanRateType: "num",
      })
    );

    expect(Object.keys(msg.payload).sort()).toEqual(["MyInt", "speed"]);
    expect(msg.tags.map((t: any) => [t.name, t.alias])).toEqual([["MyDint", "speed"], ["MyInt", undefined]]);
  });

  it("sends an array of results with the alias beside each value", async () => {
    const msg = await firstMessage(
      makeSubscribeNode({
        mode: "ui",
        output: "array",
        tagList: [row("MyDint", { alias: "speed" }), row("MyInt")],
        scanRate: 100,
        scanRateType: "num",
      })
    );

    expect(msg.payload).toHaveLength(2);
    expect(msg.payload[0]).toMatchObject({ alias: "speed", tagName: "MyDint", type: "DINT", changed: true });
    expect(msg.payload[1]).not.toHaveProperty("alias");
  });

  it("sends Key Result pairs, each result naming its tag", async () => {
    const msg = await firstMessage(
      makeSubscribeNode({
        mode: "ui",
        output: "keyresult",
        tagList: [row("MyDint", { alias: "speed" }), row("MyInt")],
        scanRate: 100,
        scanRateType: "num",
      })
    );

    expect(Object.keys(msg.payload).sort()).toEqual(["MyInt", "speed"]);
    expect(msg.payload.speed).toMatchObject({ tagName: "MyDint", type: "DINT", changed: true });
    expect(msg.payload.speed).not.toHaveProperty("alias");
    expect(msg.payload.MyInt).toMatchObject({ tagName: "MyInt" });
  });

  it("reads the scan rate from an environment variable", async () => {
    const msg = await firstMessage(
      makeSubscribeNode({ mode: "ui", output: "value", tagList: [row("MyDint")], scanRate: "RATE", scanRateType: "env" })
    );

    expect(msg.scanRate).toBe(120);
  });

  it("does not scan, and reports once, when the configuration is not valid", async () => {
    const sub = makeSubscribeNode({
      mode: "ui",
      output: "keyvalue",
      tagList: [row("MyDint"), row("MyDint")],
      scanRate: 100,
      scanRateType: "num",
    });
    sub.connect();
    await new Promise((r) => setTimeout(r, 300));
    await sub.close();

    expect(sub.errors).toHaveLength(1);
    expect(sub.errors[0]).toMatch(/key "MyDint"/);
    expect(sub.sent).toHaveLength(0);
    expect(sub.statuses[sub.statuses.length - 1].text).toBe("invalid configuration");
  });

  it("ignores msg.tags and msg.scanRate in UI mode, and warns once about each", async () => {
    const sub = makeSubscribeNode({ mode: "ui", output: "value", tagList: [row("MyDint")], scanRate: 100, scanRateType: "num" });
    try {
      sub.connect();
      await until(() => sub.sent.length > 0);
      await sub.input({ tags: ["MyInt"], scanRate: 5000 });
      await sub.input({ tags: ["MyInt"], scanRate: 5000 });
      expect(sub.node.scanRate).toBe(100);
      expect(sub.node._tags).toEqual([{ name: "MyDint" }]);
    } finally {
      await sub.close();
    }

    expect(sub.warnings.filter((w) => w.startsWith("Ignoring msg.tags"))).toHaveLength(1);
    expect(sub.warnings.filter((w) => w.startsWith("Ignoring msg.scanRate"))).toHaveLength(1);
  });

  describe("in dynamic mode", () => {
    const dynamic = (extra: Record<string, any> = {}) =>
      makeSubscribeNode({ mode: "dynamic", output: "keyvalue", scanRate: 100, scanRateType: "num", ...extra });

    it("scans nothing until a message arrives, then scans its tags with their aliases", async () => {
      const sub = dynamic();
      try {
        // After the node's own initial status, which a real deploy has long since shown
        await new Promise((r) => setTimeout(r, 20));
        sub.connect();
        await new Promise((r) => setTimeout(r, 300));
        expect(sub.sent).toHaveLength(0);
        expect(sub.statuses[sub.statuses.length - 1].text).toBe("waiting for tags");

        await sub.input({ tags: [{ name: "MyDint", alias: "speed" }, "MyInt"] });
        await until(() => sub.sent.length > 0);
      } finally {
        await sub.close();
      }

      expect(Object.keys(sub.sent[0].payload).sort()).toEqual(["MyInt", "speed"]);
    });

    it("replaces the list on each message, and keeps it when one is not valid", async () => {
      const sub = dynamic();
      try {
        sub.connect();
        await sub.input({ tags: ["MyDint"] });
        await sub.input({ tags: ["MyInt"] });
        expect(sub.node._tags).toEqual([{ name: "MyInt" }]);

        await sub.input({ tags: ["MyDint", 5] });
        expect(sub.node._tags).toEqual([{ name: "MyInt" }]);
        expect(sub.errors[0]).toMatch(/the tags were not changed/);
      } finally {
        await sub.close();
      }
    });

    it("does not warn about msg.tags, which it reads", async () => {
      const sub = dynamic();
      try {
        sub.connect();
        await sub.input({ tags: ["MyDint"] });
      } finally {
        await sub.close();
      }

      expect(sub.warnings).toEqual([]);
    });
  });
});

describe("a cip-subscribe node that has not been upgraded", () => {
  it("scans its text, and still lets msg.tags and msg.scanRate replace them", async () => {
    const sub = makeSubscribeNode({ tags: "MyDint, MyInt", scanRate: 100, deadband: 0 });
    try {
      sub.connect();
      await until(() => sub.sent.length > 0);
      expect(Object.keys(sub.sent[0].payload).sort()).toEqual(["MyDint", "MyInt"]);

      await sub.input({ tags: ["MyBool"], scanRate: 150 });
      expect(sub.node._tags).toEqual([{ name: "MyBool" }]);
      expect(sub.node.scanRate).toBe(150);
    } finally {
      await sub.close();
    }

    expect(sub.warnings).toEqual([]);
  });
});
