/**
 * End-to-end test for #18: the real cip-endpoint and st-ethernet-ip against simulators on
 * ports other than 44818. The library takes no port, so this is what notices if a library
 * update changes how eip-port supplies it.
 */
import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const PORT_A = 44900;
const PORT_B = 44901;

const sims: ChildProcess[] = [];
const endpoints: any[] = [];
let endpointCtor: any;

function startSim(port: number, udpPort: number): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [SIM], {
    env: { ...process.env, PLC_TYPE: "controllogix", EIP_PORT: String(port), IO_UDP_PORT: String(udpPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  sims.push(proc);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`simulator on ${port} did not start in time`)), 8000);
    proc.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("CIP PLC Simulator")) {
        clearTimeout(t);
        resolve(proc);
      }
    });
    proc.on("error", reject);
  });
}

function stopSim(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGKILL");
  });
}

function loadModule() {
  const RED: any = {
    nodes: {
      createNode(node: any, cfg: any) {
        node.id = cfg.id;
        node.name = cfg.name;
        node.type = "cip-endpoint";
      },
      registerType(type: string, ctor: any) {
        if (type === "cip-endpoint") endpointCtor = ctor;
      },
      getNode: () => null,
      eachNode: () => undefined,
    },
    httpAdmin: { get() {} },
    auth: { needsPermission: () => (_r: any, _s: any, next: any) => next && next() },
    log: { info() {}, warn() {}, error() {} },
  };
  require("../src/cip-endpoint")(RED);
}

function makeEndpoint(id: string, port: number) {
  const node: any = new EventEmitter();
  node.log = () => {};
  node.warn = () => {};
  node.error = () => {};
  node.status = () => {};
  endpointCtor.call(node, {
    id,
    name: id,
    address: "127.0.0.1",
    port,
    slot: 0,
    connTimeout: 2000,
    retryInterval: 200,
    maxRetryInterval: 500,
    keepAlive: 0,
    useMicro800: false,
    routingPath: "",
    autoConnect: true,
    allowDynamic: false,
  });
  endpoints.push(node);
  return node;
}

const connect = (node: any): Promise<Error | null> =>
  new Promise((resolve) => node.connect((err: Error | null) => resolve(err)));

async function readDint(node: any, name: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Tag } = require("st-ethernet-ip");
  const tag = new Tag(name);
  await node.plc.readTag(tag);
  return tag.value;
}

beforeAll(async () => {
  loadModule();
  await Promise.all([startSim(PORT_A, 22900), startSim(PORT_B, 22901)]);
}, 30000);

afterAll(async () => {
  for (const ep of endpoints) await ep.disconnect().catch(() => {});
  await Promise.all(sims.map(stopSim));
});

describe("cip-endpoint on a port other than 44818 (#18)", () => {
  it("connects on the configured port", async () => {
    const ep = makeEndpoint("a", PORT_A);
    expect(await connect(ep)).toBeNull();
    expect(ep.plc.remotePort).toBe(PORT_A);
    expect(await readDint(ep, "MyDint")).toBe(42);
    await ep.disconnect();
  }, 20000);

  it("keeps two endpoints on different ports apart when they connect together", async () => {
    const a = makeEndpoint("a2", PORT_A);
    const b = makeEndpoint("b2", PORT_B);
    expect(await Promise.all([connect(a), connect(b)])).toEqual([null, null]);
    expect(a.plc.remotePort).toBe(PORT_A);
    expect(b.plc.remotePort).toBe(PORT_B);
    await Promise.all([a.disconnect(), b.disconnect()]);
  }, 20000);

  it("reconnects on the configured port after the controller goes away", async () => {
    const ep = makeEndpoint("a3", PORT_A);
    expect(await connect(ep)).toBeNull();
    const user: any = new EventEmitter();
    ep.register(user);

    const dropped = new Promise<void>((resolve) => user.once("cip:disconnected", () => resolve()));
    await stopSim(sims[0]);
    await dropped;

    // While it retries, another endpoint connects on the other port.
    const other = makeEndpoint("b3", PORT_B);
    const otherConnected = connect(other);

    const reconnected = new Promise<void>((resolve) => user.once("cip:connected", () => resolve()));
    sims[0] = await startSim(PORT_A, 22900);
    await reconnected;

    expect(await otherConnected).toBeNull();
    expect(ep.plc.remotePort).toBe(PORT_A);
    expect(other.plc.remotePort).toBe(PORT_B);
    expect(await readDint(ep, "MyDint")).toBe(42);
  }, 30000);
});
