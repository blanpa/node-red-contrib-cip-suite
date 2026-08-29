import {
  ACTIONS,
  applyEndpointOptions,
  clearEndpointNameCache,
  endpointLabel,
  endpointStatus,
  ensureConnected,
  handleEndpointMsg,
  resolveEndpointRef,
} from "../src/endpoint-dynamic";
import { describeCipError, toCipError } from "../src/utils";

interface FakeEndpoint {
  [key: string]: any;
}

function makeEndpoint(name: string, over: Partial<FakeEndpoint> = {}): FakeEndpoint {
  const ep: FakeEndpoint = {
    id: `id_${name}`,
    type: "cip-endpoint",
    name,
    address: "1.1.1.1",
    port: 44818,
    slot: 0,
    connected: false,
    connecting: false,
    allowDynamic: true,
    calls: [] as string[],
    setOptions(opts: any) {
      const changed = Object.keys(opts);
      Object.assign(ep, opts);
      ep.calls.push(`setOptions(${changed.join(",")})`);
      return changed;
    },
    disconnect() {
      ep.calls.push("disconnect");
      ep.connected = false;
      return Promise.resolve();
    },
    connect(cb?: (e: Error | null) => void) {
      ep.calls.push("connect");
      ep.connected = true;
      if (cb) cb(null);
      return Promise.resolve();
    },
    getStatus() {
      return { id: ep.id, name: ep.name, state: ep.connected ? "connected" : "disconnected" };
    },
    _broadcast(evt: string) {
      ep.calls.push(`broadcast:${evt}`);
    },
    register() {},
    deregister() {},
    ...over,
  };
  return ep;
}

function makeRED(endpoints: FakeEndpoint[]) {
  return {
    nodes: {
      getNode: (id: string) => endpoints.find((e) => e.id === id) || null,
      eachNode: (cb: (def: any) => void) =>
        endpoints.forEach((e) => cb({ id: e.id, type: e.type, name: e.name })),
    },
  };
}

/** Drives handleEndpointMsg and reports what happened. */
function dispatch(msg: any, opts: { current?: FakeEndpoint; others?: FakeEndpoint[]; extraActions?: any } = {}) {
  const current = opts.current ?? makeEndpoint("PLC1");
  const others = opts.others ?? [makeEndpoint("PLC2")];
  const RED = makeRED([current, ...others]);
  const node: any = { endpoint: current, log: jest.fn(), error: jest.fn(), status: jest.fn() };

  const sent: any[] = [];
  let doneCount = 0;
  let error: Error | undefined;
  const done = (err?: Error) => {
    doneCount++;
    if (err) error = err;
  };

  let switchedTo: string | null = null;
  const consumed = handleEndpointMsg(RED, node, msg, (m: any) => sent.push(m), done, {
    type: "cip-endpoint",
    switchTo: (ep: any) => {
      switchedTo = ep.name;
      node.endpoint = ep;
    },
    extraActions: opts.extraActions,
  });

  return {
    consumed,
    sent,
    node,
    current,
    others,
    get switchedTo() {
      return switchedTo;
    },
    get doneCount() {
      return doneCount;
    },
    get error() {
      return error;
    },
    settled: () => new Promise((r) => setTimeout(r, 0)),
  };
}

beforeEach(() => clearEndpointNameCache());

describe("resolveEndpointRef", () => {
  it("resolves by node id", () => {
    const plc2 = makeEndpoint("PLC2");
    expect(resolveEndpointRef(makeRED([plc2]), plc2.id, "cip-endpoint")).toBe(plc2);
  });

  it("resolves by configured name", () => {
    const plc2 = makeEndpoint("PLC2");
    expect(resolveEndpointRef(makeRED([plc2]), "PLC2", "cip-endpoint")).toBe(plc2);
  });

  it("returns null for an unknown name", () => {
    expect(resolveEndpointRef(makeRED([makeEndpoint("PLC2")]), "Nope", "cip-endpoint")).toBeNull();
  });

  it("throws when a name matches more than one endpoint", () => {
    const a = makeEndpoint("Shared");
    const b = { ...makeEndpoint("Shared"), id: "id_other" };
    expect(() => resolveEndpointRef(makeRED([a, b]), "Shared", "cip-endpoint")).toThrow(
      /Multiple cip-endpoint nodes are named "Shared"/
    );
  });

  it("ignores nodes of a different type", () => {
    const other = { ...makeEndpoint("PLC2"), type: "cip-pccc-endpoint" };
    expect(resolveEndpointRef(makeRED([other]), "PLC2", "cip-endpoint")).toBeNull();
  });

  it("treats a definition with no live node as not found", () => {
    const RED = {
      nodes: {
        getNode: () => null,
        eachNode: (cb: any) => cb({ id: "on_disabled_tab", type: "cip-endpoint", name: "PLC2" }),
      },
    };
    expect(resolveEndpointRef(RED, "PLC2", "cip-endpoint")).toBeNull();
  });

  it("re-resolves when a cached id stops resolving", () => {
    const plc2 = makeEndpoint("PLC2");
    expect(resolveEndpointRef(makeRED([plc2]), "PLC2", "cip-endpoint")).toBe(plc2);

    const replacement = { ...makeEndpoint("PLC2"), id: "id_after_redeploy" };
    expect(resolveEndpointRef(makeRED([replacement]), "PLC2", "cip-endpoint")).toBe(replacement);
  });

  it("returns null for non-string references", () => {
    const RED = makeRED([makeEndpoint("PLC2")]);
    expect(resolveEndpointRef(RED, 7, "cip-endpoint")).toBeNull();
    expect(resolveEndpointRef(RED, undefined, "cip-endpoint")).toBeNull();
  });

  it("returns null when the runtime has no eachNode", () => {
    expect(resolveEndpointRef({ nodes: { getNode: () => null } }, "PLC2", "cip-endpoint")).toBeNull();
  });
});

describe("describeCipError", () => {
  // Node-RED calls .toString() on a status text whenever a Status node is listening, so an
  // undefined one throws inside the runtime rather than in our code.
  it("always returns a string, whatever was thrown", () => {
    const thrown: any[] = [
      { generalStatusCode: 5, extendedStatus: [] },
      { generalStatusCode: 1, extendedStatus: [273] },
      new Error("boom"),
      "plain string",
      null,
      undefined,
      {},
      42,
    ];
    for (const err of thrown) {
      const text = describeCipError(err);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("renders a bare CIP rejection readably", () => {
    expect(describeCipError({ generalStatusCode: 5, extendedStatus: [] })).toBe(
      "Path destination unknown (CIP 0x05)"
    );
  });

  it("wraps a bare rejection into a real Error", () => {
    const err = toCipError({ generalStatusCode: 5, extendedStatus: [] }, "Read failed");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Read failed: Path destination unknown (CIP 0x05)");
  });
});

describe("applyEndpointOptions", () => {
  it("applies only the supplied properties", () => {
    const ep = makeEndpoint("PLC1");
    const changed = applyEndpointOptions(ep, { target: "config", address: "10.0.0.5" });
    expect(changed).toEqual(["address"]);
    expect(ep.address).toBe("10.0.0.5");
    expect(ep.port).toBe(44818);
  });

  it("does not pass target or force through as settings", () => {
    const ep = makeEndpoint("PLC1");
    applyEndpointOptions(ep, { target: "config", force: true, slot: 2 });
    expect(ep.calls).toContain("setOptions(slot)");
    expect(ep.target).toBeUndefined();
    expect(ep.force).toBeUndefined();
  });

  it("keeps slot 0", () => {
    const ep = makeEndpoint("PLC1", { slot: 3 });
    applyEndpointOptions(ep, { target: "config", slot: 0 });
    expect(ep.slot).toBe(0);
  });

  it("does nothing when only meta properties are supplied", () => {
    const ep = makeEndpoint("PLC1");
    expect(applyEndpointOptions(ep, { target: "config", force: true })).toEqual([]);
    expect(ep.calls).toHaveLength(0);
  });
});

describe("endpointLabel and endpointStatus", () => {
  it("prefers the endpoint name, falling back to its id", () => {
    expect(endpointLabel({ endpoint: makeEndpoint("PLC2") })).toBe("PLC2");
    expect(endpointLabel({ endpoint: { ...makeEndpoint(""), name: "" } })).toBe("id_");
    expect(endpointLabel({ endpoint: null })).toBeUndefined();
  });

  it("reports the endpoint's current state", () => {
    expect(endpointStatus({ endpoint: null }).text).toBe("no endpoint");
    expect(endpointStatus({ endpoint: makeEndpoint("PLC2") }).text).toBe("disconnected: PLC2");
    expect(endpointStatus({ endpoint: makeEndpoint("PLC2", { connecting: true }) }).text).toBe(
      "connecting: PLC2"
    );
    expect(endpointStatus({ endpoint: makeEndpoint("PLC2", { connected: true }) }).text).toBe(
      "connected: PLC2"
    );
  });
});

describe("ensureConnected", () => {
  it("resolves immediately when already connected", async () => {
    const ep = makeEndpoint("PLC1", { connected: true });
    await expect(ensureConnected({ endpoint: ep })).resolves.toBeUndefined();
    expect(ep.calls).not.toContain("connect");
  });

  it("rejects when there is no endpoint", async () => {
    await expect(ensureConnected({ endpoint: null })).rejects.toThrow("No endpoint selected");
  });

  it("does not wait when the endpoint has not opted in", async () => {
    const ep = makeEndpoint("PLC1", { allowDynamic: false });
    await expect(ensureConnected({ endpoint: ep })).rejects.toThrow("Not connected to PLC");
    expect(ep.calls).not.toContain("connect");
  });

  it("connects on demand when the endpoint has opted in", async () => {
    const ep = makeEndpoint("PLC1");
    await expect(ensureConnected({ endpoint: ep })).resolves.toBeUndefined();
    expect(ep.calls).toContain("connect");
  });

  it("propagates a connect failure", async () => {
    const ep = makeEndpoint("PLC1", {
      connect: (cb: any) => cb(new Error("refused")),
    });
    await expect(ensureConnected({ endpoint: ep })).rejects.toThrow("refused");
  });
});

describe("handleEndpointMsg: gating", () => {
  it("passes an ordinary message straight through", () => {
    const r = dispatch({ tagName: "MyTag" });
    expect(r.consumed).toBe(false);
    expect(r.doneCount).toBe(0);
  });

  it("ignores action and endpoint when the endpoint has not opted in", () => {
    const locked = makeEndpoint("PLC1", { allowDynamic: false });
    const r = dispatch({ action: "disconnect", endpoint: "PLC2" }, { current: locked });
    expect(r.consumed).toBe(false);
    expect(r.switchedTo).toBeNull();
    expect(locked.calls).toHaveLength(0);
  });

  it("refuses a switch onto an endpoint that has not opted in", () => {
    const locked = makeEndpoint("PLC2", { allowDynamic: false });
    const r = dispatch({ action: "switch", endpoint: "PLC2" }, { others: [locked] });
    expect(r.error?.message).toMatch(/does not allow dynamic updates/);
    expect(r.switchedTo).toBeNull();
  });

  it("errors on an unknown endpoint name without switching", () => {
    const r = dispatch({ endpoint: "Nope", tagName: "X" });
    expect(r.error?.message).toBe('Endpoint "Nope" not found');
    expect(r.switchedTo).toBeNull();
  });
});

describe("handleEndpointMsg: msg.endpoint validation", () => {
  it.each([
    [2, "not number"],
    [["PLC2"], "not an array"],
    [true, "not boolean"],
  ])("rejects %p", (value, expected) => {
    const r = dispatch({ endpoint: value, tagName: "X" });
    expect(r.consumed).toBe(true);
    expect(r.error?.message).toContain(expected);
  });

  it("treats null and undefined as not specified", () => {
    expect(dispatch({ endpoint: null, tagName: "X" }).consumed).toBe(false);
    expect(dispatch({ endpoint: undefined, tagName: "X" }).consumed).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(dispatch({ endpoint: "", tagName: "X" }).error?.message).toBe("msg.endpoint is empty");
  });

  it("rejects an object without target, reserving the shape", () => {
    const r = dispatch({ action: "connect", endpoint: { address: "10.0.0.5" } });
    expect(r.error?.message).toMatch(/must be an endpoint name or id/);
    expect(r.current.address).toBe("1.1.1.1");
  });
});

describe("handleEndpointMsg: actions", () => {
  it("switches on a bare endpoint reference and still reads", () => {
    const r = dispatch({ endpoint: "PLC2", tagName: "X" });
    expect(r.consumed).toBe(false);
    expect(r.switchedTo).toBe("PLC2");
  });

  it("switch re-points without connecting", () => {
    const plc2 = makeEndpoint("PLC2");
    const r = dispatch({ action: "switch", endpoint: "PLC2" }, { others: [plc2] });
    expect(r.switchedTo).toBe("PLC2");
    expect(plc2.calls).not.toContain("connect");
    expect(r.doneCount).toBe(1);
  });

  it("switch registers without asking the endpoint to connect", () => {
    const plc2 = makeEndpoint("PLC2");
    const registered: any[] = [];
    plc2.register = (_n: any, o: any) => registered.push(o);

    // Mirrors what a node's useEndpoint hook does on a switch.
    const r = dispatch({ action: "switch", endpoint: "PLC2" }, { others: [plc2] });
    expect(r.switchedTo).toBe("PLC2");
    plc2.register({}, { connect: false });
    expect(registered).toEqual([{ connect: false }]);
  });

  it("switch requires an endpoint reference", () => {
    expect(dispatch({ action: "switch" }).error?.message).toMatch(/requires msg.endpoint/);
  });

  it("status emits the endpoint identity and does not read", () => {
    const r = dispatch({ action: "status" });
    expect(r.consumed).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].payload).toMatchObject({ id: "id_PLC1", name: "PLC1" });
    expect(r.sent[0].action).toBeUndefined();
  });

  it("status with an endpoint reports on that one without re-pointing the node", () => {
    const r = dispatch({ action: "status", endpoint: "PLC2" });
    expect(r.sent[0].payload).toMatchObject({ name: "PLC2" });
    expect(r.switchedTo).toBeNull();
    expect(r.node.endpoint.name).toBe("PLC1");
  });

  it("disconnect with an endpoint tears that one down without re-pointing the node", async () => {
    const plc2 = makeEndpoint("PLC2", { connected: true });
    const r = dispatch({ action: "disconnect", endpoint: "PLC2" }, { others: [plc2] });
    await r.settled();
    expect(plc2.calls).toContain("disconnect");
    expect(r.switchedTo).toBeNull();
    expect(r.node.endpoint.name).toBe("PLC1");
  });

  it.each(["connect", "reconnect"])("%s with an endpoint re-points the node", async (action) => {
    const plc2 = makeEndpoint("PLC2");
    const r = dispatch({ action, endpoint: "PLC2" }, { others: [plc2] });
    await r.settled();
    expect(r.switchedTo).toBe("PLC2");
    expect(plc2.calls).toContain("connect");
  });

  it("status still reports an unknown endpoint as an error", () => {
    const r = dispatch({ action: "status", endpoint: "Nope" });
    expect(r.error?.message).toBe('Endpoint "Nope" not found');
    expect(r.sent).toHaveLength(0);
  });

  it("connect is a no-op success when already connected", async () => {
    const ep = makeEndpoint("PLC1", { connected: true });
    const r = dispatch({ action: "connect" }, { current: ep });
    await r.settled();
    expect(r.error).toBeUndefined();
    expect(ep.calls).toContain("broadcast:cip:connected");
  });

  it("connect connects when down", async () => {
    const r = dispatch({ action: "connect" });
    await r.settled();
    expect(r.current.calls).toContain("connect");
    expect(r.doneCount).toBe(1);
  });

  it("disconnect disconnects", async () => {
    const ep = makeEndpoint("PLC1", { connected: true });
    const r = dispatch({ action: "disconnect" }, { current: ep });
    await r.settled();
    expect(ep.calls).toContain("disconnect");
  });

  it("reconnect cycles the connection", async () => {
    const ep = makeEndpoint("PLC1", { connected: true });
    const r = dispatch({ action: "reconnect" }, { current: ep });
    await r.settled();
    expect(ep.calls).toEqual(expect.arrayContaining(["disconnect", "connect"]));
    expect(ep.calls.indexOf("disconnect")).toBeLessThan(ep.calls.indexOf("connect"));
  });

  it("rejects an unknown action without switching first", () => {
    const r = dispatch({ endpoint: "PLC2", action: "banana" });
    expect(r.error?.message).toMatch(/Invalid action "banana"/);
    expect(r.switchedTo).toBeNull();
  });

  it("dispatches a node-specific extra action", () => {
    const start = jest.fn((_m: any, _s: any, done: any) => done());
    const r = dispatch({ action: "start" }, { extraActions: { start } });
    expect(r.consumed).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("exposes the expected action names", () => {
    expect(Object.values(ACTIONS)).toEqual([
      "switch",
      "connect",
      "disconnect",
      "reconnect",
      "status",
    ]);
  });
});

describe("handleEndpointMsg: settings overrides", () => {
  const override = { target: "config" as const, address: "10.0.0.5" };

  it("applies on connect when the endpoint is down", async () => {
    const r = dispatch({ action: "connect", endpoint: override });
    await r.settled();
    expect(r.current.address).toBe("10.0.0.5");
    expect(r.current.calls).toContain("connect");
  });

  it("refuses on a live connection without force", async () => {
    const ep = makeEndpoint("PLC1", { connected: true });
    const r = dispatch({ action: "connect", endpoint: override }, { current: ep });
    await r.settled();
    expect(r.error?.message).toMatch(/Disconnect from the PLC before connecting/);
    expect(ep.address).toBe("1.1.1.1");
  });

  it("cycles a live connection with force, applying settings while down", async () => {
    const ep = makeEndpoint("PLC1", { connected: true });
    const r = dispatch({ action: "connect", endpoint: { ...override, force: true } }, { current: ep });
    await r.settled();
    expect(ep.address).toBe("10.0.0.5");
    const order = ep.calls.filter((c: string) => c !== "broadcast:cip:connected");
    expect(order.indexOf("disconnect")).toBeLessThan(order.indexOf("setOptions(address)"));
    expect(order.indexOf("setOptions(address)")).toBeLessThan(order.indexOf("connect"));
  });

  it.each(["disconnect", "reconnect", "status"])(
    "rejects an override supplied with %s rather than dropping it",
    async (action) => {
      const ep = makeEndpoint("PLC1", { connected: true });
      const r = dispatch({ action, endpoint: override }, { current: ep });
      await r.settled();
      expect(r.error?.message).toMatch(/overrides apply only to msg.action = "connect"/);
      expect(ep.address).toBe("1.1.1.1");
    }
  );

  it("rejects an override with no action at all", () => {
    const r = dispatch({ endpoint: override, tagName: "X" });
    expect(r.error?.message).toMatch(/overrides apply only to msg.action = "connect"/);
    expect(r.current.address).toBe("1.1.1.1");
  });
});

describe("handleEndpointMsg: done is called exactly once", () => {
  const cases: Array<[string, any]> = [
    ["status", { action: "status" }],
    ["switch", { action: "switch", endpoint: "PLC2" }],
    ["connect", { action: "connect" }],
    ["disconnect", { action: "disconnect" }],
    ["reconnect", { action: "reconnect" }],
    ["invalid action", { action: "banana" }],
    ["unknown endpoint", { endpoint: "Nope" }],
    ["bad endpoint type", { endpoint: 7 }],
  ];

  it.each(cases)("%s", async (_label, msg) => {
    const r = dispatch(msg);
    await r.settled();
    expect(r.doneCount).toBe(1);
  });
});
