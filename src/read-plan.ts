/**
 * Resolves what a cip-read node should read, for nodes that have been upgraded.
 *
 * An upgraded node has a `mode`: "ui" reads the rows of its tag list, "dynamic" reads the tags
 * a message property carries. Nothing else in a message changes what is read, so a message
 * can never override what the editor shows. A row's tag name can come from a message
 * property or an environment variable, because the row says so.
 *
 * A node that has not been upgraded has no `mode`. buildReadPlan() returns null for it and
 * cip-read keeps its original behaviour, where msg.tags and msg.tagName override the node.
 *
 * Pure on purpose: property lookup is injected so this runs under Jest without Node-RED.
 * @module read-plan
 */

import { BatchEntry, parseBatchTags } from "./utils";
import { EvalProp, asText, evaluateTyped, isBlank, positiveWhole, readsProp } from "./plan-utils";

export { EvalProp };

export type ReadMode = "ui" | "dynamic";
/**
 * value: the one tag's value as payload. keyvalue: { key: value }. keyresult: { key: result }.
 * array: one result per tag.
 */
export type ReadOutput = "value" | "keyvalue" | "keyresult" | "array";

export type ReadRequest =
  | { kind: "single"; tag: string; dataType?: string; arraySize?: number }
  /** `source` names where the entries came from, for the error when one is invalid. */
  | { kind: "batch"; entries: BatchEntry[]; source: string }
  /** Nothing to read. The caller warns with `reason` and does not fail the message. */
  | { kind: "none"; reason: string }
  /** The configuration or the message is unusable. The caller fails the message. */
  | { kind: "error"; error: string };

export interface PollSetting {
  /** Milliseconds, 0 for none. */
  interval: number;
  /** Set when the configured interval is not usable. The node then does not poll. */
  error?: string;
}

export interface ReadPlan {
  mode: ReadMode;
  output: ReadOutput;
  /** True when a message supplies a value, so a poll tick (which has none) cannot read. */
  dynamic: boolean;
  poll: PollSetting;
  /** Set when the configuration cannot work whatever the message says. The node reports it and reads nothing. */
  error?: string;
  resolve(msg: any): ReadRequest;
  /** Message properties that are present but that this node does not read. */
  unusedProps(msg: any): string[];
}

/** Message properties a node might expect to work that it only reads when set up to. */
const WATCHED_PROPS = ["tags"];

const MODES: ReadMode[] = ["ui", "dynamic"];
const OUTPUTS: ReadOutput[] = ["value", "keyvalue", "keyresult", "array"];

/** The key a tag has in a keyed result: its alias, else the tag exactly as written. */
export const entryKey = (entry: BatchEntry): string => entry.alias || entry.name;

/**
 * An error text when two entries would share a key in a keyed result, else undefined.
 * Keys are literal, so MyArray[0..2] and MyArray[5..7] are different keys.
 */
export function duplicateKeyError(entries: BatchEntry[]): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.error) continue;
    const key = entryKey(entry);
    if (seen.has(key)) {
      return `Two tags have the key "${key}". Give one of them a different alias.`;
    }
    seen.add(key);
  }
  return undefined;
}

/** The poll interval of an upgraded node. A missing type is read as `num`. */
export function resolvePoll(config: any, evalProp: EvalProp): PollSetting {
  const type = config.pollIntervalType || "num";
  if (type === "none") return { interval: 0 };

  let raw: unknown = config.pollInterval;
  if (type === "env") {
    try {
      raw = evalProp(String(config.pollInterval ?? ""), "env");
    } catch (err: any) {
      return { interval: 0, error: `Invalid poll interval: ${err?.message || err}` };
    }
    if (isBlank(raw)) {
      return { interval: 0, error: `Invalid poll interval: environment variable "${config.pollInterval}" is not set` };
    }
  } else if (isBlank(raw) || Number(raw) === 0) {
    // 0 or empty has always meant trigger only
    return { interval: 0 };
  }

  const checked = positiveWhole(raw, "poll interval");
  return checked.error ? { interval: 0, error: checked.error } : { interval: checked.value! };
}

/** The plan for a node, or null for a node that has not been upgraded. */
export function buildReadPlan(config: any, evalProp: EvalProp): ReadPlan | null {
  if (config.mode === undefined || config.mode === null || config.mode === "") return null;

  const mode = config.mode as ReadMode;
  const output = (OUTPUTS.includes(config.output) ? config.output : "keyvalue") as ReadOutput;
  const rows: any[] = Array.isArray(config.tagList) ? config.tagList : [];
  const rowType = (row: any): string => row?.tagNameType || "str";

  const dynamic = mode === "dynamic" || rows.some((row) => rowType(row) === "msg");

  // What cannot work whatever the message says
  let error: string | undefined;
  if (!MODES.includes(mode)) {
    error = `Unknown mode ${JSON.stringify(config.mode)}`;
  } else if (output === "value" && (mode !== "ui" || rows.length > 1)) {
    error = "The Value output needs a tag list with exactly one tag";
  } else {
    const aliases = new Set<string>();
    for (const row of rows) {
      const alias = asText(row?.alias);
      if (!alias) continue;
      if (aliases.has(alias)) {
        error = `Two tags have the alias "${alias}". An alias can only be used once.`;
        break;
      }
      aliases.add(alias);
    }
  }

  function resolveRows(msg: any): ReadRequest {
    if (rows.length === 0) return { kind: "none", reason: "No tags configured" };

    const entries: BatchEntry[] = rows.map((row: any, index: number): BatchEntry => {
      const invalid = (text: string): BatchEntry => ({
        name: `row ${index + 1}`,
        error: `Invalid tag entry in row ${index + 1}: ${text}`,
      });

      let name: string;
      if (rowType(row) === "str") {
        name = asText(row?.tagName);
      } else {
        const found = evaluateTyped(evalProp, String(row?.tagName ?? ""), rowType(row), msg);
        if (found.error) return invalid(found.error);
        name = asText(found.value);
      }
      if (!name) return invalid("the tag name is empty");

      const entry: BatchEntry = { name };
      const alias = asText(row?.alias);
      if (alias) entry.alias = alias;
      const dataType = asText(row?.dataType) || "auto";
      if (dataType !== "auto") entry.dataType = dataType;
      if (dataType === "ARRAY" && !isBlank(row?.arraySize) && row.arraySize !== "auto") {
        const checked = positiveWhole(row.arraySize, `array size for "${name}"`);
        if (checked.error) return { name, error: checked.error };
        entry.arraySize = checked.value;
      }
      return entry;
    });

    // A list nobody has filled in yet is not an error, just nothing to do
    const blank = (row: any): boolean => rowType(row) === "str" && !asText(row?.tagName) && !asText(row?.alias);
    if (rows.every(blank)) return { kind: "none", reason: "No tags configured" };

    if (output === "value") {
      const only = entries[0];
      if (only.error) return { kind: "batch", entries, source: "tag list" };
      return { kind: "single", tag: only.name, dataType: only.dataType, arraySize: only.arraySize };
    }
    return finish(entries, "tag list");
  }

  function resolveFromMsg(msg: any): ReadRequest {
    const prop = asText(config.tagsProp) || "tags";
    const found = evaluateTyped(evalProp, prop, "msg", msg);
    if (found.error) return { kind: "error", error: found.error };
    const raw = found.value;
    if (isBlank(raw)) return { kind: "none", reason: `No tags in msg.${prop}` };
    if (typeof raw !== "string" && !Array.isArray(raw)) {
      return { kind: "error", error: `msg.${prop} must be an array or a comma separated string, got ${typeof raw}` };
    }
    return finish(parseBatchTags(raw), `msg.${prop}`);
  }

  /** The request for a list of entries, refusing keys a keyed result could not hold. */
  function finish(entries: BatchEntry[], source: string): ReadRequest {
    if ((output === "keyvalue" || output === "keyresult") && !entries.some((e) => e.error)) {
      const clash = duplicateKeyError(entries);
      if (clash) return { kind: "error", error: clash };
    }
    return { kind: "batch", entries, source };
  }

  // The message properties this plan reads, as the typed inputs name them
  const read: string[] = [];
  if (mode === "dynamic") read.push(asText(config.tagsProp) || "tags");
  for (const row of rows) {
    if (rowType(row) === "msg") read.push(asText(row?.tagName));
  }

  return {
    mode,
    output,
    dynamic,
    poll: resolvePoll(config, evalProp),
    error,
    resolve: error
      ? () => ({ kind: "error", error: error! })
      : mode === "dynamic"
        ? resolveFromMsg
        : resolveRows,
    unusedProps: (msg: any): string[] =>
      msg && typeof msg === "object"
        ? WATCHED_PROPS.filter((name) => msg[name] !== undefined && !read.some((path) => readsProp(path, name)))
        : [],
  };
}
