import { EventEmitter } from "events";

/**
 * Stands in for st-ethernet-ip. The two-level prototype chain matters: the Micro800 path
 * reaches through it for write_cip.
 */
jest.mock("st-ethernet-ip", () => {
  const { EventEmitter: EE } = require("events");

  class EnipLike extends EE {
    write_cip(_data: any, _connected: any, _timeout: any, cb: any) {
      if (cb) cb(null);
    }
  }

  const control = {
    created: [] as any[],
    connectResult: "resolve" as "resolve" | "reject" | "hang",
    connectError: { generalStatusCode: 1, extendedStatus: [273] } as any,
    reset() {
      control.created = [];
      control.connectResult = "resolve";
    },
  };

  class FakeController extends EnipLike {
    connectedMessaging: boolean;
    timeout_sp = 0;
    routing: any = null;
    destroyed = false;
    disconnectCalls = 0;
    state = { tagList: { tags: [] } };

    constructor(connectedMessaging: boolean) {
      super();
      this.connectedMessaging = connectedMessaging;
      control.created.push(this);
    }
    connect() {
      if (control.connectResult === "reject") return Promise.reject(control.connectError);
      if (control.connectResult === "hang") return new Promise(() => undefined);
      return Promise.resolve();
    }
    disconnect() {
      this.disconnectCalls++;
      return Promise.resolve();
    }
    destroy() {
      this.destroyed = true;
    }
    getControllerTagList() {
      return Promise.resolve();
    }
    setMaxListeners() {}
    setKeepAlive() {}
    get tagList() {
      return this.state.tagList.tags;
    }
  }

  return { Controller: FakeController, Tag: class {}, TagGroup: class {}, __control: control };
});

const stEthernetIp = require("st-ethernet-ip");
const control = stEthernetIp.__control;

const DEFAULT_CONFIG = {
  id: "ep1",
  name: "PLC1",
  address: "10.0.0.1",
  port: 44818,
  slot: 0,
  connTimeout: 200,
  retryInterval: 100,
  maxRetryInterval: 400,
  keepAlive: 0,
  useMicro800: false,
  routingPath: "",
};

let endpointCtor: any;
let adminRoutes: Record<string, Function>;
/** Deployed nodes, so the admin routes can resolve an id the way the runtime would. */
const deployed: Record<string, any> = {};

function loadModule() {
  adminRoutes = {};
  const RED: any = {
    nodes: {
      createNode(node: any, cfg: any) {
        node.id = cfg.id;
        node.name = cfg.name;
        node.type = "cip-endpoint";
        deployed[cfg.id] = node;
      },
      registerType(type: string, ctor: any) {
        if (type === "cip-endpoint") endpointCtor = ctor;
      },
      getNode: (id: string) => deployed[id] || null,
      eachNode: () => undefined,
    },
    httpAdmin: {
      get(path: string, _guard: any, handler: Function) {
        adminRoutes[path] = handler;
      },
    },
    auth: { needsPermission: () => (_r: any, _s: any, next: any) => next && next() },
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  jest.isolateModules(() => {
    require("../src/cip-endpoint")(RED);
  });
}

/** Build an endpoint node instance the way Node-RED would. */
function makeEndpoint(overrides: Record<string, any> = {}) {
  const node: any = new EventEmitter();
  node.log = jest.fn();
  node.warn = jest.fn();
  node.error = jest.fn();
  node.status = jest.fn();
  endpointCtor.call(node, { ...DEFAULT_CONFIG, ...overrides });
  return node;
}

/** A stand-in for a cip-read/cip-browse node registered against an endpoint. */
function makeUser(id: string) {
  const user: any = new EventEmitter();
  user.id = id;
  user.type = "cip-read";
  user.events = [] as string[];
  for (const evt of ["cip:connecting", "cip:connected", "cip:error", "cip:disconnected"]) {
    user.on(evt, () => user.events.push(evt));
  }
  return user;
}

const connectAndWait = (node: any): Promise<Error | null> =>
  new Promise((resolve) => node.connect((err: Error | null) => resolve(err)));

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeAll(() => loadModule());
beforeEach(() => {
  control.reset();
  for (const k of Object.keys(deployed)) delete deployed[k];
});

describe("options", () => {
  it("defaults everything that is absent from the flow config", () => {
    const node = makeEndpoint({ port: undefined, slot: undefined, keepAlive: undefined });
    expect(node.port).toBe(44818);
    expect(node.slot).toBe(0);
    expect(node.keepAlive).toBe(30000);
  });

  it("coerces numeric strings and keeps slot 0", () => {
    const node = makeEndpoint({ port: "44819", slot: "0", connTimeout: "1500" });
    expect(node.port).toBe(44819);
    expect(node.slot).toBe(0);
    expect(node.connTimeout).toBe(1500);
  });

  it("falls back rather than storing NaN", () => {
    const node = makeEndpoint({ port: "not-a-port" });
    expect(node.port).toBe(44818);
  });

  it("raises maxRetryInterval to at least retryInterval", () => {
    expect(makeEndpoint({ retryInterval: 5000, maxRetryInterval: 1000 }).maxRetryInterval).toBe(5000);
  });

  it("a runtime override applies only the supplied properties", () => {
    const node = makeEndpoint();
    const changed = node.setOptions({ address: "10.0.0.9" }, false);
    expect(changed).toEqual(["address"]);
    expect(node.address).toBe("10.0.0.9");
    expect(node.slot).toBe(0);
    expect(node.connTimeout).toBe(200);
  });

  it("reports no change when the value is the same", () => {
    const node = makeEndpoint();
    expect(node.setOptions({ address: "10.0.0.1" }, false)).toEqual([]);
  });
});

describe("nodes sharing one endpoint", () => {
  it("every registered node is told about each state change", async () => {
    const node = makeEndpoint();
    const a = makeUser("read1");
    const b = makeUser("browse1");
    node.register(a);
    node.register(b);
    await connectAndWait(node);

    // Registering the first user starts the connect, so the second can miss the
    // cip:connecting that precedes its own registration. What matters is that from the
    // point both are registered, both see the same thing.
    a.events.length = 0;
    b.events.length = 0;

    await node.disconnect();
    await connectAndWait(node);

    expect(a.events).toEqual(["cip:disconnected", "cip:connecting", "cip:connected"]);
    expect(b.events).toEqual(a.events);
  });

  it("a node that deregisters stops hearing about the endpoint", async () => {
    const node = makeEndpoint();
    const stays = makeUser("stays");
    const leaves = makeUser("leaves");
    node.register(stays);
    node.register(leaves);

    node.deregister(leaves);
    await connectAndWait(node);

    expect(stays.events).toContain("cip:connected");
    expect(leaves.events).not.toContain("cip:connected");
  });

  it("a node registering against a live endpoint is told immediately", async () => {
    const node = makeEndpoint();
    await connectAndWait(node);

    const late = makeUser("late");
    node.register(late);
    expect(late.events).toEqual(["cip:connected"]);
  });

  it("a redundant disconnect still announces the state", async () => {
    const node = makeEndpoint();
    const user = makeUser("read1");
    node.register(user);
    await node.disconnect();
    user.events.length = 0;

    // Nothing is up, so nothing changes. It still announces, because a repeat disconnect
    // is how a caller asks whether it is definitely down.
    await node.disconnect();
    expect(user.events).toEqual(["cip:disconnected"]);
  });

  it("connects when a user registers", async () => {
    const node = makeEndpoint();
    node.register(makeUser("a"));
    await flush();
    expect(node.connected).toBe(true);
  });

  it("disconnects when the last user is deleted, but not on a redeploy", async () => {
    const node = makeEndpoint();
    const user = makeUser("read1");
    node.register(user);
    await connectAndWait(node);

    node.deregister(user, () => undefined, false);
    await flush();
    expect(node.connected).toBe(true);

    node.register(user);
    node.deregister(user, () => undefined, true);
    await flush();
    expect(node.connected).toBe(false);
  });
});

describe("runtime settings surviving a reconnect", () => {
  it("keeps an overridden address across disconnect and connect", async () => {
    const node = makeEndpoint();
    await connectAndWait(node);

    node.setOptions({ address: "10.0.0.99" }, false);
    await node.disconnect();
    await connectAndWait(node);

    expect(node.address).toBe("10.0.0.99");
    expect(node.connected).toBe(true);
  });

  it("keeps an overridden address across an unexpected socket drop and retry", async () => {
    jest.useFakeTimers();
    try {
      const node = makeEndpoint();
      await connectAndWait(node);
      node.setOptions({ address: "10.0.0.99", slot: 3 }, false);

      const socket = node.plc;
      socket.emit("close");
      expect(node.connected).toBe(false);

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();

      expect(node.address).toBe("10.0.0.99");
      expect(node.slot).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("getStatus reports the live values, not the configured ones", async () => {
    const node = makeEndpoint();
    node.setOptions({ address: "10.0.0.99" }, false);
    await connectAndWait(node);

    const status = node.getStatus();
    expect(status).toMatchObject({
      id: "ep1",
      name: "PLC1",
      state: "connected",
      address: "10.0.0.99",
    });
  });
});

describe("connect and disconnect", () => {
  it("the callback reports success only once the attempt settles", async () => {
    const node = makeEndpoint();
    expect(node.connected).toBe(false);
    expect(await connectAndWait(node)).toBeNull();
    expect(node.connected).toBe(true);
  });

  it("reports a readable message when the library rejects with a bare object", async () => {
    control.connectResult = "reject";
    const node = makeEndpoint();
    const err = await connectAndWait(node);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Connection failure/);
    expect(err!.message).toMatch(/0x0111/);
  });

  it("suggests Micro800 mode when a Logix connect is refused", async () => {
    control.connectResult = "reject";
    const node = makeEndpoint({ useMicro800: false });
    const err = await connectAndWait(node);
    expect(err!.message).toMatch(/Micro800/);
  });

  it("does not suggest Micro800 mode when it is already on", async () => {
    control.connectResult = "reject";
    const node = makeEndpoint({ useMicro800: true });
    const err = await connectAndWait(node);
    expect(err!.message).not.toMatch(/Micro800 Mode/);
  });

  it("connecting while already connected settles immediately", async () => {
    const node = makeEndpoint();
    await connectAndWait(node);
    const before = control.created.length;
    expect(await connectAndWait(node)).toBeNull();
    expect(control.created.length).toBe(before);
  });

  it("concurrent callers join one attempt and all settle", async () => {
    const node = makeEndpoint();
    const results = await Promise.all([connectAndWait(node), connectAndWait(node)]);
    expect(results).toEqual([null, null]);
    expect(control.created.length).toBe(1);
  });

  it("closes the socket it gives up on", async () => {
    control.connectResult = "reject";
    const node = makeEndpoint();
    await connectAndWait(node);
    await flush();
    expect(control.created[0].destroyed).toBe(true);
    expect(node.plc).toBeNull();
  });

  it("a disconnect during an in-flight connect wins", async () => {
    const node = makeEndpoint();
    node.connect();
    await node.disconnect();
    await flush();
    expect(node.connected).toBe(false);
    expect(node.plc).toBeNull();
  });
});

describe("dropped connections", () => {
  it("notices a socket closing and schedules a retry", async () => {
    jest.useFakeTimers();
    try {
      const node = makeEndpoint();
      const user = makeUser("read1");
      node.register(user);
      await connectAndWait(node);
      user.events.length = 0;

      node.plc.emit("close");
      expect(node.connected).toBe(false);
      expect(user.events).toContain("cip:disconnected");

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(node.connected).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("ignores a superseded socket closing after a reconnect", async () => {
    const node = makeEndpoint();
    await connectAndWait(node);
    const first = node.plc;

    await node.disconnect();
    await connectAndWait(node);
    const second = node.plc;
    expect(second).not.toBe(first);

    first.emit("close");
    expect(node.plc).toBe(second);
    expect(node.connected).toBe(true);
  });

  it("does not retry after an explicit disconnect", async () => {
    jest.useFakeTimers();
    try {
      const node = makeEndpoint();
      await connectAndWait(node);
      await node.disconnect();

      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      expect(node.connected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("keepalive", () => {
  it("runs while connected and stops on disconnect", async () => {
    jest.useFakeTimers();
    try {
      const node = makeEndpoint({ keepAlive: 50 });
      await connectAndWait(node);
      expect(node._keepAliveTimer).not.toBeNull();

      await node.disconnect();
      expect(node._keepAliveTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("stays off when the interval is zero", async () => {
    const node = makeEndpoint({ keepAlive: 0 });
    await connectAndWait(node);
    expect(node._keepAliveTimer).toBeNull();
  });
});

describe("admin routes", () => {
  const respond = () => {
    const res: any = {
      code: 200,
      body: undefined,
      status(c: number) {
        res.code = c;
        return res;
      },
      json(b: any) {
        res.body = b;
        return res;
      },
    };
    return res;
  };

  it("metrics returns the same payload as the status action", async () => {
    const node = makeEndpoint();
    await connectAndWait(node);

    const res = respond();
    await adminRoutes["/cip-endpoint/:id/metrics"]({ params: { id: "ep1" } }, res);
    expect(res.body).toMatchObject({ id: "ep1", name: "PLC1" });
  });

  it("browse refuses when the endpoint is not connected", async () => {
    makeEndpoint();
    const res = respond();
    await adminRoutes["/cip-endpoint/:id/browse"]({ params: { id: "ep1" } }, res);
    expect(res.code).toBe(503);
  });
});
