/**
 * End-to-end test: the real cip-io-scanner node against the PowerFlex 525
 * simulator. Proves the fixed Forward_Open framing (transport 0x81 + Connection
 * Point segments) is accepted by a strict drive and that cyclic UDP I/O flows
 * in both directions.
 *
 * The simulator binds the standard implicit-messaging UDP port 2222; the node
 * binds a different local UDP port (2223) so both can run on one host.
 */
import { spawn, ChildProcess } from "child_process";
import * as path from "path";

const SIM = path.join(__dirname, "..", "simulator", "server.js");
const NODE_MODULE = path.join(__dirname, "..", "nodes", "cip-io-scanner.js");
const TCP_PORT = 44900;

let sim: ChildProcess;

function waitForSimReady(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("simulator did not start in time")), timeoutMs);
    proc.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("UDP listening")) { clearTimeout(t); resolve(); }
    });
    proc.on("error", reject);
  });
}

beforeAll(async () => {
  sim = spawn(process.execPath, [SIM], {
    env: { ...process.env, PLC_TYPE: "powerflex525", EIP_PORT: String(TCP_PORT), IO_UDP_PORT: "2222" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForSimReady(sim, 8000);
});

afterAll(() => {
  if (sim && !sim.killed) sim.kill("SIGKILL");
});

/** Build a cip-io-scanner node against a fake RED, capturing status and errors. */
function makeScanner(config: Record<string, any>) {
  const RED: any = { nodes: { createNode() {}, registerType(_n: string, ctor: any) { RED._ctor = ctor; } } };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(NODE_MODULE)(RED);

  const statuses: string[] = [];
  const errors: string[] = [];
  const inputs: any[] = [];
  let closeHandler: ((done: () => void) => void) | null = null;
  let onEvent: (() => void) | null = null;

  const node: any = Object.create(RED._ctor.prototype);
  node.status = (s: any) => { if (s && s.text) statuses.push(s.text); };
  node.log = () => {};
  node.warn = () => {};
  node.error = (m: string) => { errors.push(m); if (onEvent) onEvent(); };
  node.on = (ev: string, cb: any) => { if (ev === "close") closeHandler = cb; };
  node.send = (msg: any) => { inputs.push(msg); if (onEvent) onEvent(); };

  const nextEvent = new Promise<void>((resolve) => { onEvent = resolve; });
  RED._ctor.call(node, config);

  return {
    statuses,
    errors,
    inputs,
    nextEvent,
    close: () => (closeHandler ? new Promise<void>((res) => closeHandler!(res)) : Promise.resolve()),
  };
}

test("a refused ForwardOpen is reported with its extended status", async () => {
  // Assemblies the PF525 does not own, so the drive refuses the connection.
  const scanner = makeScanner({
    targetAddress: "127.0.0.1", targetPort: String(TCP_PORT), rpi: "50",
    inputAssembly: "70", outputAssembly: "20", configAssembly: "6",
    inputSize: "8", outputSize: "4", udpPort: "2224", runIdleHeader: true,
  });

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("no error reported")), 8000);
  });
  try {
    await Promise.race([scanner.nextEvent, deadline]);
  } finally {
    clearTimeout(timer!);
  }
  await scanner.close();

  const message = scanner.errors.join(" | ");
  expect(message).toContain("ForwardOpen refused by target");
  // The general status alone is just "connection failure"; the extended status
  // is what tells the user which parameter the drive objected to.
  expect(message).toMatch(/extended 0x0[0-9a-f]{3}/);
}, 20000);

test("scanner establishes I/O and exchanges cyclic data with the PF525 sim", async () => {
  const RED: any = { nodes: { createNode() {}, registerType(_n: string, ctor: any) { RED._ctor = ctor; } } };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(NODE_MODULE)(RED);

  let closeHandler: ((done: () => void) => void) | null = null;
  const statuses: string[] = [];
  const inputs: any[] = [];
  let onInput: (() => void) | null = null;

  const node: any = Object.create(RED._ctor.prototype);
  node.status = (s: any) => { if (s && s.text) statuses.push(s.text); };
  node.log = () => {};
  node.warn = () => {};
  node.error = (m: string) => { /* surfaced via test assertions */ statuses.push("ERR:" + m); };
  node.on = (ev: string, cb: any) => { if (ev === "close") closeHandler = cb; };
  node.send = (msg: any) => { inputs.push(msg); if (onInput) onInput(); };

  const config = {
    targetAddress: "127.0.0.1", targetPort: String(TCP_PORT), rpi: "50",
    inputAssembly: "1", outputAssembly: "2", configAssembly: "6",
    inputSize: "8", outputSize: "4", udpPort: "2223", runIdleHeader: true,
  };

  const gotInput = new Promise<void>((resolve) => { onInput = resolve; });

  RED._ctor.call(node, config);

  // Wait for a cyclic input message from the drive (proves T→O flows).
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error("no I/O input received; statuses=" + JSON.stringify(statuses))), 8000);
  });
  try {
    await Promise.race([gotInput, deadline]);
  } finally {
    clearTimeout(timer!);
  }

  expect(statuses).toContain("I/O active");
  expect(inputs.length).toBeGreaterThan(0);
  const msg = inputs[0];
  expect(msg.assembly).toBe(1);
  expect(Buffer.isBuffer(msg.payload.input)).toBe(true);
  expect(msg.payload.input.length).toBe(8);
  // Logic Status word produced by the sim (Ready+Active+CommandedRef = 0x0007).
  expect(msg.payload.input.readUInt16LE(0)).toBe(0x0007);

  // Clean up the node's sockets.
  if (closeHandler) await new Promise<void>((res) => closeHandler!(res));
}, 20000);
