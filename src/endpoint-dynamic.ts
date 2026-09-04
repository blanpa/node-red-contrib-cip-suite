/**
 * Runtime endpoint selection and connection control.
 *
 * Action nodes call handleEndpointMsg() at the top of their input handler. It resolves
 * msg.endpoint, and if msg.action is present it performs that action and reports the
 * message consumed, so the node skips its own read or write. This mirrors the core MQTT
 * nodes, where an action message controls the connection and does not publish.
 *
 * RED and the node are passed in rather than captured, so everything here is testable with
 * plain fakes.
 * @module endpoint-dynamic
 */

import { CipEndpointOverride, NodeStatus } from "./types";
import { STATUS } from "./utils";

/** Actions understood by every endpoint-backed node. */
export const ACTIONS = {
  SWITCH: "switch",
  CONNECT: "connect",
  DISCONNECT: "disconnect",
  RECONNECT: "reconnect",
  GET_STATUS: "status",
} as const;

const ACTION_VALUES: string[] = Object.values(ACTIONS);

export interface DynOpts {
  /** Config node type to resolve against, e.g. "cip-endpoint". */
  type: string;
  /** Event namespace the endpoint broadcasts on. */
  events?: string;
  /** Rebind the node to a different endpoint. Owns deregister/register and any teardown. */
  switchTo: (endpoint: any) => void;
  /** Extra actions handled by this node (cip-subscribe adds start/stop/restart). */
  extraActions?: Record<string, (msg: any, send: any, done: any) => void>;
  /**
   * Set false for a node with no per-message operation to borrow an endpoint for.
   * cip-subscribe holds a scan loop rather than answering one message at a time, so a bare
   * reference has nothing to apply to and is rejected instead of silently re-pointing.
   */
  borrowable?: boolean;
}

/**
 * Which endpoint a single message is to be carried out against.
 *
 * `handleEndpointMsg` fills this in and the caller reads it, so a borrowed endpoint
 * travels as a local rather than as node state. The I/O is async, and a second message
 * arriving mid-read would otherwise redirect the first one.
 */
export interface MsgEndpoint {
  endpoint: any;
}

/**
 * Short name for the endpoint a node is using, for node.status().
 *
 * Applied to every endpoint-backed node, not just dynamic ones. When several nodes share
 * an endpoint and one of them can re-point itself, an unlabelled "connected" gives the
 * reader no way to tell which PLC a given node is reporting on, and a node that is
 * correctly tracking a shared endpoint looks like it has fallen behind.
 */
export function endpointLabel(node: any): string | undefined {
  const ep = node && node.endpoint;
  if (!ep) return undefined;
  return ep.name || ep.id;
}

/**
 * Set the node's status to reflect its endpoint, deferred by a tick.
 *
 * Called from a node constructor, so the flow is still being built: a status set
 * synchronously here is emitted before the Status node exists and nobody hears it. The
 * core MQTT broker node defers its equivalent for the same reason.
 */
export function applyInitialStatus(node: any): void {
  setTimeout(() => {
    try {
      node.status(endpointStatus(node));
    } catch {
      // node torn down between construction and the tick
    }
  }, 1);
}

/** The status a node should show for its endpoint right now. */
export function endpointStatus(node: any): NodeStatus {
  const ep = node && node.endpoint;
  if (!ep) return { fill: "red", shape: "ring", text: "no endpoint" };
  if (ep.connected) return STATUS.connected(endpointLabel(node));
  if (ep.connecting) return STATUS.connecting(endpointLabel(node));
  return STATUS.disconnected(endpointLabel(node));
}


/**
 * name -> node id, revalidated on every hit so it self-heals across redeploys without
 * holding a reference to the node itself.
 */
const nameCache = new Map<string, string>();

/** Exposed for tests; also called when a flow reload could have invalidated every id. */
export function clearEndpointNameCache(): void {
  nameCache.clear();
}

/**
 * Resolve an endpoint reference: a node id first, then a config node `name`.
 *
 * Node-RED's runtime getNode() only accepts ids, but eachNode() walks the flow
 * configuration and exposes config nodes, so a name lookup is possible. Matching more than
 * one endpoint is an error rather than an arbitrary pick, the same way core resolves
 * `link call` targets by name.
 *
 * @throws if the name is ambiguous.
 */
export function resolveEndpointRef(RED: any, ref: any, type: string): any | null {
  if (!ref || typeof ref !== "string") return null;

  const byId = RED.nodes.getNode(ref);
  if (byId && byId.type === type) return byId;

  const cachedId = nameCache.get(ref);
  if (cachedId) {
    const cached = RED.nodes.getNode(cachedId);
    if (cached && cached.type === type && cached.name === ref) return cached;
    nameCache.delete(ref);
  }

  if (typeof RED.nodes.eachNode !== "function") return null;

  const ids: string[] = [];
  RED.nodes.eachNode((def: any) => {
    if (def && def.type === type && def.name === ref) ids.push(def.id);
  });

  // A definition on a disabled tab, or a subflow template, has no live node.
  const live = ids.map((id) => RED.nodes.getNode(id)).filter(Boolean);
  if (live.length > 1) {
    throw new Error(`Multiple ${type} nodes are named "${ref}"; use the node id instead`);
  }
  if (live.length === 0) return null;

  nameCache.set(ref, live[0].id);
  return live[0];
}

/**
 * Record which endpoint answered, on an outgoing message.
 *
 * Only for endpoints that allow dynamic updates. A statically configured node can answer
 * from exactly one place for its whole life, so stamping there would add a property to the
 * output of every existing flow and say nothing the editor does not already show.
 *
 * The property this sets is the same one that selects an endpoint on the way in, which is
 * deliberate: piping a read into a write keeps both halves on the PLC that answered, and a
 * plain msg.endpoint borrows for one operation rather than re-pointing the downstream node.
 */
export function stampEndpoint(msg: any, endpoint: any): any {
  if (msg && endpoint && endpoint.allowDynamic) {
    msg.endpoint = endpoint.name || endpoint.id;
  }
  return msg;
}

/**
 * Wait for an endpoint to be usable, connecting it if necessary.
 *
 * Defaults to the node's own endpoint. `use` names the one endpoint this message borrowed,
 * which may be down: an endpoint with Auto connect off has nothing connected to it until
 * something asks, and refusing to connect it here would make the one-message form useless.
 *
 * Only dynamic nodes wait. A statically configured node fails immediately with the same
 * message and the same timing it always has, so existing flows see no change.
 *
 * This matters because register() starts a connect asynchronously: without it, switching to
 * a disconnected endpoint and reading in the same message always failed, even with
 * autoConnect on. It also covers the reconnect window after a controller drops an idle
 * session.
 */
export function ensureConnected(node: any, use?: any): Promise<void> {
  const endpoint = use || node.endpoint;
  if (!endpoint) return Promise.reject(new Error("No endpoint selected"));
  if (endpoint.connected) return Promise.resolve();
  // Without the opt-in, fail with the same message and the same timing as before rather
  // than introducing a wait into an existing flow.
  if (endpoint.allowDynamic !== true) return Promise.reject(new Error("Not connected to PLC"));


  return new Promise<void>((resolve, reject) => {
    // connect() already bounds the wait and settles every waiter exactly once, and joins
    // an attempt that is already in flight rather than starting a second one.
    endpoint.connect((err: Error | null) => (err ? reject(err) : resolve()));
  });
}

/** True when msg.endpoint is a settings override rather than a reference. */
function asOverride(value: any): CipEndpointOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as CipEndpointOverride;
}

/**
 * Apply a runtime override to an endpoint, returning the option names that changed.
 * Only the properties present on the override are touched.
 */
export function applyEndpointOptions(endpoint: any, override: CipEndpointOverride): string[] {
  const { target, force, ...settings } = override;
  if (Object.keys(settings).length === 0) return [];
  return endpoint.setOptions(settings, false);
}

/**
 * Handle msg.endpoint and msg.action.
 *
 * @returns true when the message was consumed, either by running an action or by failing,
 *          meaning the caller must return immediately. false to carry on with its own work.
 */
export function handleEndpointMsg(
  RED: any,
  node: any,
  msg: any,
  send: any,
  done: any,
  opts: DynOpts,
  ctx?: MsgEndpoint
): boolean {
  const finish = (err?: Error): boolean => {
    if (typeof done === "function") {
      err ? done(err) : done();
    } else if (err) {
      node.error(err.message, msg);
    }
    return true;
  };

  const ref = msg.endpoint;
  const rawAction = msg.action;
  const hasAction = rawAction !== undefined && rawAction !== null && rawAction !== "";
  const refGiven = ref !== undefined && ref !== null;

  if (!refGiven && !hasAction) {
    return false; // nothing to do; keep the common path cheap and quiet
  }

  // The endpoint owns the opt-in. With it off, msg.endpoint and msg.action are ignored
  // entirely and the message falls through, so upgrading cannot change how an existing
  // flow behaves. msg.endpoint is a plausible property name in flows that predate this.
  // Nothing below this point runs for a locked endpoint, validation included.
  if (node.endpoint && node.endpoint.allowDynamic !== true) {
    return false;
  }


  const override = asOverride(ref);

  // Anything that is neither a reference nor a settings object is a mistake. Letting it
  // through silently hides typos, and an array is an easy one to build by accident.
  if (refGiven && typeof ref !== "string" && !override) {
    return finish(
      new Error(
        `msg.endpoint must be an endpoint name, an id, or a settings object, not ${
          Array.isArray(ref) ? "an array" : typeof ref
        }`
      )
    );
  }
  if (refGiven && typeof ref === "string" && !ref) {
    return finish(new Error("msg.endpoint is empty"));
  }
  if (override && !override.target) {
    // Reserved for ad-hoc pooled connections. Erroring now keeps the meaning of an
    // untargeted object free, so adding them later cannot change behaviour under anyone.
    return finish(
      new Error(
        'msg.endpoint must be an endpoint name or id. To change the settings of the ' +
          'configured endpoint, set msg.endpoint.target = "config"'
      )
    );
  }

  // Validate the action BEFORE switching. Otherwise a typo re-points the node at another
  // PLC and then reports failure, leaving every later read pointed somewhere unintended.
  const action = hasAction ? String(rawAction) : null;
  const extra = action && opts.extraActions ? opts.extraActions[action] : undefined;
  if (action && !extra && !ACTION_VALUES.includes(action)) {
    return finish(
      new Error(`Invalid action "${action}". Expected one of: ${ACTION_VALUES.join(", ")}`)
    );
  }

  // Connecting is the only point at which new settings can take effect, so it is the only
  // action an override belongs on. Silently dropping it elsewhere would leave the sender
  // believing the change had been applied.
  if (override && action !== ACTIONS.CONNECT) {
    return finish(
      new Error('msg.endpoint overrides apply only to msg.action = "connect"')
    );
  }

  if (action === ACTIONS.SWITCH && typeof ref !== "string") {
    return finish(new Error('msg.action "switch" requires msg.endpoint to name an endpoint'));
  }

  // Resolve the reference without acting on it yet, so a bad one cannot leave the node
  // half-moved.
  let target: any = null;
  if (typeof ref === "string") {
    try {
      target = resolveEndpointRef(RED, ref, opts.type);
    } catch (err: any) {
      return finish(err);
    }
    if (!target) return finish(new Error(`Endpoint "${ref}" not found`));
    // Both ends must opt in. Allowing a switch onto a locked endpoint would strand the
    // node there, since no later message would be honoured.
    if (target.allowDynamic !== true) {
      return finish(
        new Error(`Endpoint "${ref}" does not allow dynamic updates. Enable it on that cip-endpoint`)
      );
    }
  }

  // Only an action moves the node, and only one that leaves the named endpoint bound and
  // ready to use: "switch", "connect" and "reconnect". "disconnect" does not, since binding
  // to something you just tore down strands the node on a dead endpoint, and "status" does
  // not because it only reports.
  const repoints =
    action === ACTIONS.SWITCH || action === ACTIONS.CONNECT || action === ACTIONS.RECONNECT;

  // A bare reference on a data message borrows the endpoint for that one message. It must
  // not re-point: the node would keep reading the borrowed PLC afterwards while the editor
  // still showed the configured one, so a single "read this tag from PLC2" would quietly
  // redirect every later read. Use "switch" to move a node for good.
  if (!action && target && opts.borrowable === false) {
    return finish(
      new Error(
        `This node has no per-message operation to use "${ref}" for. ` +
          `Set msg.action = "switch" to move it to that endpoint`
      )
    );
  }

  // Everything is validated; side effects start here.
  if (target && repoints) opts.switchTo(target);

  if (!action) {
    // The common path: carry on and read or write, against the borrowed endpoint if one
    // was named and the node's own otherwise.
    if (target && ctx) ctx.endpoint = target;
    return false;
  }

  if (extra) {
    extra(msg, send, done);
    return true;
  }

  // Re-point the node and stop there: no connect, no disconnect, no read. The switch
  // itself already happened above; this action exists so a flow can express "just move"
  // without the side effect of a read, which a bare msg.endpoint would trigger.
  if (action === ACTIONS.SWITCH) {
    return finish();
  }

  const endpoint = target || node.endpoint;
  if (!endpoint) return finish(new Error("No endpoint selected"));

  if (action === ACTIONS.GET_STATUS) {
    const out = { ...msg, payload: endpoint.getStatus() };
    delete out.action;
    if (typeof send === "function") send(out);
    return finish();
  }

  const connect = (): void => {
    endpoint.connect((err: Error | null) => finish(err || undefined));
  };

  if (action === ACTIONS.DISCONNECT) {
    Promise.resolve(endpoint.disconnect())
      .then(() => finish())
      .catch((err: any) => finish(err));
    return true;
  }

  // Cycles the existing settings. An override here is rejected above, so reconnect never
  // silently changes what it reconnects to.
  if (action === ACTIONS.RECONNECT) {
    Promise.resolve(endpoint.disconnect())
      .then(() => connect())
      .catch((err: any) => finish(err));
    return true;
  }

  // connect
  if (override) {
    const live = endpoint.connected || endpoint.connecting;
    const force = override.force === true || msg.force === true;
    if (live && !force) {
      return finish(
        new Error(
          "Disconnect from the PLC before connecting with new settings, or set msg.endpoint.force"
        )
      );
    }
    Promise.resolve(live ? endpoint.disconnect() : null)
      .then(() => {
        const changed = applyEndpointOptions(endpoint, override);
        connect();
      })
      .catch((err: any) => finish(err));
    return true;
  }

  // Connecting an already-connected endpoint is a no-op success, as it is for MQTT, but
  // re-announce the state so the request visibly confirms something.
  if (endpoint.connected) {
    if (typeof endpoint._broadcast === "function") endpoint._broadcast("cip:connected");
    return finish();
  }
  connect();
  return true;
}
