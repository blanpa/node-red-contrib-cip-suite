/**
 * Resolves what a cip-subscribe node should scan, for nodes that have been upgraded.
 *
 * An upgraded node has a `mode`: "ui" scans the rows of its tag list, "dynamic" scans the tags
 * a message property carries. Scan rate and deadband are typed inputs. A message property is
 * only read in the dynamic mode, so nothing in a message can change what the editor shows.
 *
 * A node that has not been upgraded has no `mode`. buildSubscribePlan() returns null for it
 * and cip-subscribe keeps its original behaviour, where a message can replace the tags and
 * the scan rate.
 *
 * Pure on purpose: property lookup is injected so this runs under Jest without Node-RED.
 * @module subscribe-plan
 */

import { BatchEntry, parseBatchTags } from "./utils";
import { EvalProp, asText, evaluateTyped, isBlank, positiveWhole, readsProp } from "./plan-utils";
import { duplicateKeyError } from "./read-plan";

export type SubscribeMode = "ui" | "dynamic";
/**
 * value: the one tag's value as payload. keyvalue: { key: value }. keyresult: { key: result }.
 * array: one result per tag.
 */
export type SubscribeOutput = "value" | "keyvalue" | "keyresult" | "array";

/** The scan rate used when none is given, as it has always been. */
export const DEFAULT_SCAN_RATE = 1000;

/** A tag to scan, and the key it has in an object result when it has an alias. */
export interface SubscribeTag {
  name: string;
  alias?: string;
}

export type TagsRequest =
  | { kind: "tags"; tags: SubscribeTag[] }
  /**
   * Nothing usable in the message. The caller warns with `reason` and keeps what it has, unless
   * `absent` says the message simply did not carry the property.
   */
  | { kind: "none"; reason: string; absent?: boolean }
  /** An entry or the property is not valid. The caller rejects the message. */
  | { kind: "error"; error: string };

export interface SubscribePlan {
  mode: SubscribeMode;
  output: SubscribeOutput;
  /** The tags known at deploy time. Empty in dynamic mode, where a message supplies them. */
  tags: SubscribeTag[];
  scanRate: number;
  /** 0 when there is none. */
  deadband: number;
  /** Set when the tags, the output, the scan rate or the deadband cannot be used. The node does not scan. */
  error?: string;
  /** Dynamic mode only: the tags a message carries. */
  resolveTags(msg: any): TagsRequest;
  /** Message properties that are present but that this node does not read. */
  unusedProps(msg: any): string[];
}

const MODES: SubscribeMode[] = ["ui", "dynamic"];
const OUTPUTS: SubscribeOutput[] = ["value", "keyvalue", "keyresult", "array"];
const WATCHED_PROPS = ["tags", "scanRate"];

/** The plan for a node, or null for a node that has not been upgraded. */
export function buildSubscribePlan(config: any, evalProp: EvalProp): SubscribePlan | null {
  if (config.mode === undefined || config.mode === null || config.mode === "") return null;

  const mode = config.mode as SubscribeMode;
  const output = (OUTPUTS.includes(config.output) ? config.output : "keyvalue") as SubscribeOutput;
  const rows: any[] = Array.isArray(config.tagList) ? config.tagList : [];
  /** A keyed result needs a key for each tag, so two tags cannot share one. */
  const keyed = output === "keyvalue" || output === "keyresult";

  const problems: string[] = [];
  const evaluate = (value: string, type: string, msg?: any) => evaluateTyped(evalProp, value, type, msg);

  if (!MODES.includes(mode)) {
    problems.push(`Unknown mode ${JSON.stringify(config.mode)}`);
  } else if (output === "value" && (mode !== "ui" || rows.length > 1)) {
    problems.push("The Value output needs a tag list with exactly one tag");
  }

  // Tags known at deploy time
  const tags: SubscribeTag[] = [];
  if (mode === "ui") {
    const blank = (row: any): boolean => (row?.tagNameType || "str") === "str" && !asText(row?.tagName) && !asText(row?.alias);
    rows.forEach((row: any, index: number) => {
      if (rows.every(blank)) return;
      let name: string;
      if ((row?.tagNameType || "str") === "str") {
        name = asText(row?.tagName);
      } else {
        const found = evaluate(String(row?.tagName ?? ""), row.tagNameType);
        if (found.error) {
          problems.push(`row ${index + 1}: ${found.error}`);
          return;
        }
        name = asText(found.value);
      }
      if (!name) {
        problems.push(`Invalid tag entry in row ${index + 1}: the tag name is empty`);
        return;
      }
      const tag: SubscribeTag = { name };
      const alias = asText(row?.alias);
      if (alias) tag.alias = alias;
      tags.push(tag);
    });

    // An alias can only be used once, and a keyed result needs a key for each tag
    const aliases = new Set<string>();
    for (const tag of tags) {
      if (!tag.alias) continue;
      if (aliases.has(tag.alias)) {
        problems.push(`Two tags have the alias "${tag.alias}". An alias can only be used once.`);
        break;
      }
      aliases.add(tag.alias);
    }
    if (keyed) {
      const clash = duplicateKeyError(tags);
      if (clash) problems.push(clash);
    }
  }

  // Scan rate: empty has always meant the default
  let scanRate = DEFAULT_SCAN_RATE;
  const scanRateType = config.scanRateType || "num";
  let rawRate: unknown = config.scanRate;
  if (scanRateType === "env") {
    const found = evaluate(String(config.scanRate ?? ""), "env");
    if (found.error) problems.push(`Invalid scan rate: ${found.error}`);
    rawRate = found.value;
    if (!found.error && isBlank(rawRate)) {
      problems.push(`Invalid scan rate: environment variable "${config.scanRate}" is not set`);
    }
  }
  if (!isBlank(rawRate)) {
    const checked = positiveWhole(rawRate, "scan rate");
    if (checked.error) problems.push(checked.error);
    else scanRate = checked.value!;
  }

  // Deadband: None, or a number that is not negative
  let deadband = 0;
  const deadbandType = config.deadbandType || "none";
  if (deadbandType !== "none") {
    let rawBand: unknown = config.deadband;
    if (deadbandType === "env") {
      const found = evaluate(String(config.deadband ?? ""), "env");
      if (found.error) problems.push(`Invalid deadband: ${found.error}`);
      rawBand = found.value;
      if (!found.error && isBlank(rawBand)) {
        problems.push(`Invalid deadband: environment variable "${config.deadband}" is not set`);
      }
    }
    if (!isBlank(rawBand)) {
      const n = typeof rawBand === "number" ? rawBand : Number(String(rawBand).trim());
      if (!Number.isFinite(n) || n < 0) {
        problems.push(`Invalid deadband ${JSON.stringify(rawBand)}: expected a number that is not negative`);
      } else {
        deadband = n;
      }
    }
  }

  const prop = asText(config.tagsProp) || "tags";

  function resolveTags(msg: any): TagsRequest {
    if (mode !== "dynamic") return { kind: "none", reason: "This node does not take its tags from a message" };
    const found = evaluate(prop, "msg", msg);
    if (found.error) return { kind: "error", error: found.error };
    const raw = found.value;
    if (raw === undefined) return { kind: "none", reason: `No tags in msg.${prop}`, absent: true };
    if (isBlank(raw) && !Array.isArray(raw)) return { kind: "none", reason: `No tags in msg.${prop}` };
    if (typeof raw !== "string" && !Array.isArray(raw)) {
      return { kind: "error", error: `msg.${prop} must be an array or a comma separated string, got ${typeof raw}` };
    }
    const entries: BatchEntry[] = parseBatchTags(raw);
    if (entries.length === 0) return { kind: "none", reason: `No tags in msg.${prop}` };
    const invalid = entries.filter((e) => e.error);
    if (invalid.length > 0) {
      return {
        kind: "error",
        error: `Invalid msg.${prop}, the tags were not changed. ${invalid.map((e) => e.error).join("; ")}`,
      };
    }
    if (keyed) {
      const clash = duplicateKeyError(entries);
      if (clash) return { kind: "error", error: `${clash} The tags were not changed.` };
    }
    return { kind: "tags", tags: entries.map((e) => (e.alias ? { name: e.name, alias: e.alias } : { name: e.name })) };
  }

  // The message properties this plan reads
  const read: string[] = mode === "dynamic" ? [prop] : [];

  return {
    mode,
    output,
    tags,
    scanRate,
    deadband,
    error: problems.length > 0 ? problems.join("; ") : undefined,
    resolveTags,
    unusedProps: (msg: any): string[] =>
      msg && typeof msg === "object"
        ? WATCHED_PROPS.filter((name) => msg[name] !== undefined && !read.some((path) => readsProp(path, name)))
        : [],
  };
}
