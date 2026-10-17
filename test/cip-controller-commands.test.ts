/**
 * Issue #20: cip-controller's run/program/test wrote the Identity Status word, and
 * "reset" sent the Identity Reset service, which restarts the device. Both are now
 * refused without sending anything; getProps/getStatus read as documented.
 */
import * as path from "path";

const CONTROLLER_NODE = path.join(__dirname, "..", "nodes", "cip-controller.js");

/** Identity attribute values as a controller returns them, keyed by attribute id. */
function identityAttrs(o: {
  vendorId: number;
  deviceType: number;
  productCode: number;
  major: number;
  minor: number;
  status: number;
  serial: number;
  name: string;
  state?: number;
}): Record<number, Buffer> {
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const serial = Buffer.alloc(4);
  serial.writeUInt32LE(o.serial);
  const attrs: Record<number, Buffer> = {
    1: u16(o.vendorId),
    2: u16(o.deviceType),
    3: u16(o.productCode),
    4: Buffer.from([o.major, o.minor]),
    5: u16(o.status),
    6: serial,
    7: Buffer.concat([Buffer.from([o.name.length]), Buffer.from(o.name, "latin1")]),
  };
  if (o.state !== undefined) attrs[8] = Buffer.from([o.state]);
  return attrs;
}

const MICRO850 = identityAttrs({
  vendorId: 1,
  deviceType: 14,
  productCode: 299,
  major: 23,
  minor: 12,
  status: 0x0034,
  serial: 0x70c3b83c,
  name: "2080-L50E-24QBB",
  state: 3,
});

function makeControllerNode(
  opts: { identity?: Record<number, Buffer>; getAll?: boolean; props?: any; tags?: any[] } = {}
) {
  const sent: Buffer[] = [];
  const requests: Buffer[] = [];
  const identity = opts.identity || MICRO850;
  const plc = {
    state: { controller: opts.props || {}, tagList: { tags: opts.tags || [] } },
    get properties() {
      return this.state.controller;
    },
    get tagList() {
      return this.state.tagList.tags;
    },
    write_cip(data: Buffer, _c: any, _t: any, cb: any) {
      sent.push(data);
      if (cb) cb(null);
    },
  };
  // Answers the Identity object as a Micro800 does: Get_Attribute_All with service 0xD2,
  // then State; Get_Attribute_Single per attribute. Anything else is refused.
  const request = async (req: Buffer): Promise<Buffer> => {
    requests.push(req);
    const service = req.readUInt8(0);
    const refused = Buffer.from([service | 0x80, 0, 0x08, 0]);
    if (service === 0x01) {
      if (opts.getAll === false) return refused;
      const attrs = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => identity[id]).filter(Boolean);
      return Buffer.concat([Buffer.from([0xd2, 0, 0, 0]), ...attrs]);
    }
    const value = service === 0x0e ? identity[req.readUInt8(7)] : undefined;
    if (!value) return Buffer.from([service | 0x80, 0, 0x14, 0]);
    return Buffer.concat([Buffer.from([0x8e, 0, 0, 0]), value]);
  };
  const endpoint = {
    connected: true,
    getController: () => plc,
    request,
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
  require(CONTROLLER_NODE)(RED);

  const handlers: Record<string, any> = {};
  const node: any = Object.create(RED._ctor.prototype);
  const errors: string[] = [];
  const outputs: any[] = [];
  let settle: () => void = () => {};
  node.status = () => {};
  node.log = () => {};
  node.debug = () => {};
  node.warn = () => settle();
  node.error = (e: any) => {
    errors.push(e instanceof Error ? e.message : String(e));
    settle();
  };
  node.on = (ev: string, cb: any) => {
    handlers[ev] = cb;
  };
  node.send = (msg: any) => {
    outputs.push(msg);
    settle();
  };

  RED._ctor.call(node, { endpoint: "ep", pollInterval: 0 });

  const command = (cmd: string): Promise<void> =>
    new Promise((resolve) => {
      settle = resolve;
      handlers.input({ command: cmd });
    });

  return {
    command,
    sent,
    requests,
    errors,
    outputs,
    close: () => handlers.close?.(() => {}),
  };
}

describe("cip-controller commands", () => {
  it.each(["run", "program", "test"])("refuses %s without sending a request", async (cmd) => {
    const n = makeControllerNode();
    await n.command(cmd);
    expect(n.errors[0]).toMatch(/Changing the controller mode over CIP is not supported/);
    expect(n.sent).toHaveLength(0);
    expect(n.requests).toHaveLength(0);
    n.close();
  });

  it("refuses reset, which would restart the device", async () => {
    const n = makeControllerNode();
    await n.command("reset");
    expect(n.errors[0]).toMatch(/Fault reset over CIP is not supported/);
    expect(n.sent).toHaveLength(0);
    expect(n.requests).toHaveLength(0);
    n.close();
  });

  it.each(["getProps", "getStatus"])("%s reads the controller", async (cmd) => {
    const n = makeControllerNode();
    await n.command(cmd);
    expect(n.errors).toHaveLength(0);
    expect(n.outputs[0].payload.name).toBe("2080-L50E-24QBB");
    n.close();
  });
});

describe("cip-controller identity", () => {
  const logix = (status: number) =>
    identityAttrs({
      vendorId: 1,
      deviceType: 14,
      productCode: 166,
      major: 33,
      minor: 11,
      status,
      serial: 0x00c0ffee,
      name: "1756-L83E/B",
    });

  const micro850Payload = {
    name: "2080-L50E-24QBB",
    serial: "70C3B83C",
    firmware: { major: 23, minor: 12 },
    vendorId: 1,
    deviceType: 14,
    productCode: 299,
    status: {
      runMode: "run",
      faulted: false,
      majorFault: false,
      minorFault: false,
      ioFault: false,
    },
    keyswitch: "unknown",
  };

  it("reads a Micro800's identity with one Get_Attribute_All", async () => {
    const n = makeControllerNode({ tags: [{}, {}, {}] });
    await n.command("getStatus");
    expect(n.requests).toHaveLength(1);
    expect(n.requests[0].readUInt8(0)).toBe(0x01);
    expect(n.outputs[0].payload).toMatchObject({ ...micro850Payload, tagCount: 3 });
    n.close();
  });

  it("reads one attribute at a time when Get_Attribute_All is refused", async () => {
    const n = makeControllerNode({ getAll: false });
    await n.command("getStatus");
    expect(n.requests.slice(1).map((r) => r.readUInt8(7))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(n.outputs[0].payload).toMatchObject(micro850Payload);
    n.close();
  });

  it.each([
    [3, { runMode: "run", faulted: false }],
    [2, { runMode: "program", faulted: false }],
    [4, { majorFault: true, faulted: true }],
  ])("takes a Micro800's mode from State %s", async (state, expected) => {
    const n = makeControllerNode({
      identity: identityAttrs({
        vendorId: 1,
        deviceType: 14,
        productCode: 299,
        major: 23,
        minor: 12,
        status: 0x0034,
        serial: 0x70c3b83c,
        name: "2080-L50E-24QBB",
        state,
      }),
    });
    await n.command("getStatus");
    expect(n.outputs[0].payload.status).toMatchObject(expected);
    n.close();
  });

  it.each([
    ["0x3060", "run", "remote"],
    ["0x1060", "run", "run"],
    ["0x2070", "program", "program"],
  ])("decodes Logix status %s", async (status, runMode, keyswitch) => {
    const n = makeControllerNode({ identity: logix(Number(status)) });
    await n.command("getStatus");
    expect(n.outputs[0].payload.status.runMode).toBe(runMode);
    expect(n.outputs[0].payload.keyswitch).toBe(keyswitch);
    expect(n.outputs[0].payload.status.faulted).toBe(false);
    n.close();
  });

  it.each([
    ["0x0160", { minorFault: true, majorFault: false }],
    ["0x0460", { minorFault: false, majorFault: true }],
    ["0x0820", { majorFault: true, ioFault: true }],
  ])("decodes fault bits in status %s", async (status, expected) => {
    const n = makeControllerNode({ identity: logix(Number(status)) });
    await n.command("getStatus");
    expect(n.outputs[0].payload.status).toMatchObject({ faulted: true, ...expected });
    n.close();
  });

  it("falls back to the properties read on connect when the identity reads are refused", async () => {
    const n = makeControllerNode({
      identity: {},
      props: { name: "1756-L83E/B", serial_number: 0x00c0ffee, version: "33.11", status: 0x3070 },
    });
    await n.command("getStatus");
    expect(n.errors).toHaveLength(0);
    expect(n.outputs[0].payload).toMatchObject({
      name: "1756-L83E/B",
      serial: "00C0FFEE",
      firmware: { major: 33, minor: 11 },
      status: { runMode: "program" },
      keyswitch: "remote",
    });
    n.close();
  });
});
