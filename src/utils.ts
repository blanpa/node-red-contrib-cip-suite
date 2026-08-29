/**
 * Shared utilities for cip-suite nodes.
 */

import { CIP_STATUS, CIP_TYPE_NAMES, NodeStatus } from "./types";

/**
 * Parse a tag name for special addressing:
 * - Bit access: "MyDint.5" → { baseName: "MyDint", bitIndex: 5 }
 * - Array element: "MyArray[3]" → { baseName: "MyArray", arrayIndex: 3 }
 * - Array range: "MyArray[0..9]" → { baseName: "MyArray", arrayStart: 0, arrayEnd: 9 }
 * - Program-scoped: "Program:MainProgram.MyTag" → passed through as-is
 */
export interface ParsedTagName {
  baseName: string;
  bitIndex: number | null;
  arrayIndex: number | null;
  arrayStart: number | null;
  arrayEnd: number | null;
  isRange: boolean;
}

export function parseTagName(tagName: string): ParsedTagName {
  const result: ParsedTagName = {
    baseName: tagName,
    bitIndex: null,
    arrayIndex: null,
    arrayStart: null,
    arrayEnd: null,
    isRange: false,
  };

  // Array range: MyArray[0..9]
  const rangeMatch = tagName.match(/^(.+)\[(\d+)\.\.(\d+)\]$/);
  if (rangeMatch) {
    result.baseName = rangeMatch[1];
    result.arrayStart = parseInt(rangeMatch[2], 10);
    result.arrayEnd = parseInt(rangeMatch[3], 10);
    result.isRange = true;
    return result;
  }

  // Array element: MyArray[3]
  const arrayMatch = tagName.match(/^(.+)\[(\d+)\]$/);
  if (arrayMatch) {
    result.baseName = arrayMatch[1];
    result.arrayIndex = parseInt(arrayMatch[2], 10);
    return result;
  }

  // Bit access: MyDint.5 (but NOT Program:MainProgram.MyTag)
  // Bit index is a single digit after the last dot, and the part before is not "Program:..."
  const bitMatch = tagName.match(/^(.+)\.(\d+)$/);
  if (bitMatch && !bitMatch[1].includes(":")) {
    result.baseName = bitMatch[1];
    result.bitIndex = parseInt(bitMatch[2], 10);
    return result;
  }

  return result;
}

export interface ProgramScope {
  program: string | null;
  name: string;
}

/**
 * Split a program-scoped tag into program name and tag path.
 * "Program:MainProgram.MyTag" → { program: "MainProgram", name: "MyTag" }
 */
export function parseProgramScope(tagName: string): ProgramScope {
  const match = tagName.match(/^Program:([^.\[]+)[.](.+)$/);
  if (match) {
    return { program: match[1], name: match[2] };
  }
  return { program: null, name: tagName };
}

export interface MemberInfo {
  arraySize: number | null;
  isStruct: boolean;
  isArray: boolean;
}

interface TagListLike {
  tags?: any[];
  templates?: Record<number, any>;
}

/** Strip a trailing array subscript ("FBACTUAL[3]" -> "FBACTUAL"). */
function stripSubscript(segment: string): string {
  return segment.replace(/\[[^\]]*\]/g, "");
}

/** Case-insensitive comparison, the way Logix treats tag and member names. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Find the tag-list entry for the root of a tag path.
 * Logix tag and member names are case-insensitive, so the lookup is too.
 */
export function findTagListEntry(
  tagList: TagListLike | null | undefined,
  rootName: string,
  program: string | null = null
): any | null {
  if (!tagList?.tags?.length) return null;
  const wanted = stripSubscript(rootName);
  return (
    tagList.tags.find(
      (entry) =>
        sameName(stripSubscript(String(entry.name)), wanted) &&
        sameName(String(entry.program ?? ""), String(program ?? ""))
    ) ?? null
  );
}

/**
 * Rewrite a tag path so every segment uses the exact casing the controller
 * reports in its tag list and UDT templates.
 *
 * st-ethernet-ip matches UDT member names case-sensitively when it decides
 * whether to build a `Structure` (which decodes into an object) or a plain
 * `Tag` (which hands back the raw struct bytes). A path typed as
 * `fis_stn[0].local` therefore reads back as a `Buffer` instead of an object,
 * even though the same path works fine in Studio 5000. Canonicalising the path
 * first makes the match succeed. Segments that cannot be resolved are passed
 * through untouched.
 */
export function canonicalizeTagName(
  tagName: string,
  tagList: TagListLike | null | undefined,
  program: string | null = null
): string {
  if (!tagList?.tags?.length) return tagName;

  const segments = tagName.split(".");
  const rootEntry = findTagListEntry(tagList, segments[0], program);
  if (!rootEntry) return tagName;

  const out: string[] = [
    stripSubscript(String(rootEntry.name)) + subscriptOf(segments[0]),
  ];

  let template = tagList.templates?.[rootEntry.type?.code];
  for (let i = 1; i < segments.length; i++) {
    const bare = stripSubscript(segments[i]);
    const member = template?._members?.find((entry: any) => sameName(String(entry.name), bare));
    if (!member) {
      // Unknown member (or a bit index such as ".5") — keep the rest verbatim.
      return [...out, ...segments.slice(i)].join(".");
    }
    out.push(String(member.name) + subscriptOf(segments[i]));
    template = tagList.templates?.[member.type?.code];
  }
  return out.join(".");
}

/** Return the subscript part of a segment ("Foo[3]" -> "[3]", "Foo" -> ""). */
function subscriptOf(segment: string): string {
  const at = segment.indexOf("[");
  return at === -1 ? "" : segment.slice(at);
}

/**
 * Resolve UDT member metadata (array length, nested struct) from the PLC tag list.
 * `isArray` is true when the resolved path is an array; `arraySize` holds the
 * element count when known, or null when it is not carried by the tag list and
 * has to be resolved from the controller (see `resolveArrayLength`) — the
 * Symbol Object list request only asks for name and type, so controller- and
 * program-scoped array tags never carry their length here.
 */
export function resolveMemberInfo(
  tagName: string,
  tagList: TagListLike | null | undefined,
  program: string | null = null
): MemberInfo {
  const empty: MemberInfo = { arraySize: null, isStruct: false, isArray: false };
  if (!tagList?.tags?.length || !tagList.templates) return empty;

  const rawSegments = tagName.split(".");
  const segments = rawSegments.map(stripSubscript);
  const tag = findTagListEntry(tagList, segments[0], program);
  if (!tag) return empty;

  if (segments.length === 1) {
    // A subscripted root ("MyArray[3]") addresses a single element, not the array.
    const isArray = tag.type.arrayDims > 0 && !subscriptOf(rawSegments[0]);
    return {
      arraySize: isArray ? null : 1,
      isStruct: !!tag.type.structure,
      isArray,
    };
  }

  let template = tagList.templates[tag.type.code];
  for (let i = 1; i < segments.length; i++) {
    const member = template?._members?.find((entry: any) => sameName(String(entry.name), segments[i]));
    if (!member) return empty;

    if (i === segments.length - 1) {
      const isArray = member.type.arrayDims > 0 && !subscriptOf(rawSegments[i]);
      return {
        arraySize: isArray ? member.info : 1,
        isStruct: !!member.type.structure,
        isArray,
      };
    }

    template = tagList.templates[member.type.code];
    if (!template) return empty;
  }

  return empty;
}

/**
 * Extract a bit from an integer value.
 */
export function getBit(value: number, bitIndex: number): boolean {
  return ((value >>> bitIndex) & 1) === 1;
}

/**
 * Set a specific bit in an integer value.
 */
export function setBit(value: number, bitIndex: number, bitValue: boolean): number {
  if (bitValue) {
    return value | (1 << bitIndex);
  } else {
    return value & ~(1 << bitIndex);
  }
}

/**
 * Build OR/AND masks for Read-Modify-Write service (0x4E).
 * OR mask sets bits, AND mask clears bits.
 */
export function buildBitMasks(
  byteSize: number,
  bitIndex: number,
  bitValue: boolean
): { orMask: Buffer; andMask: Buffer } {
  const orMask = Buffer.alloc(byteSize, 0x00);
  const andMask = Buffer.alloc(byteSize, 0xff);

  const byteOffset = Math.floor(bitIndex / 8);
  const bitOffset = bitIndex % 8;

  if (bitValue) {
    // Set bit: OR mask has the bit set
    orMask[byteOffset] = 1 << bitOffset;
  } else {
    // Clear bit: AND mask has the bit cleared
    andMask[byteOffset] = ~(1 << bitOffset) & 0xff;
  }

  return { orMask, andMask };
}

/**
 * Human-readable CIP status text.
 */
export function cipStatusText(code: number): string {
  return CIP_STATUS[code] || `Unknown (0x${code.toString(16)})`;
}

/**
 * Human-readable CIP data type name.
 */
export function cipTypeName(code: number): string {
  return CIP_TYPE_NAMES[code] || `0x${code.toString(16)}`;
}

/**
 * Render whatever st-ethernet-ip threw as readable text.
 *
 * The library rejects a failed connect with a bare object such as
 * `{ generalStatusCode: 1, extendedStatus: [273] }`, so reading `.message` off it yields
 * "undefined" and the real cause is lost.
 */
export function describeCipError(err: any): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err.message === "string" && err.message) return err.message;

  if (typeof err.generalStatusCode === "number") {
    const hex = (n: number, w: number) => "0x" + n.toString(16).padStart(w, "0");
    const ext =
      Array.isArray(err.extendedStatus) && err.extendedStatus.length > 0
        ? `, extended ${err.extendedStatus.map((e: number) => hex(e, 4)).join(", ")}`
        : "";
    return `${cipStatusText(err.generalStatusCode)} (CIP ${hex(err.generalStatusCode, 2)}${ext})`;
  }

  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    // fall through
  }
  return String(err);
}

/**
 * Turn any thrown value into a real Error, so callers can pass it to done() and Catch
 * nodes see a usable message.
 */
export function toCipError(err: any, prefix?: string): Error {
  const text = describeCipError(err);
  const wrapped = new Error(prefix ? `${prefix}: ${text}` : text);
  if (err && typeof err === "object") {
    if (typeof err.generalStatusCode === "number") {
      (wrapped as any).generalStatusCode = err.generalStatusCode;
    }
    if (err.extendedStatus !== undefined) (wrapped as any).extendedStatus = err.extendedStatus;
  }
  return wrapped;
}

/**
 * Standard Node-RED status objects.
 */
export const STATUS = {
  // `via` names the endpoint in use. Worth showing whenever a node can be re-pointed at
  // runtime, since "connected" alone does not say what it is connected to.
  connected(via?: string): NodeStatus {
    return { fill: "green", shape: "dot", text: via ? `connected: ${via}` : "connected" };
  },
  connecting(via?: string): NodeStatus {
    return { fill: "yellow", shape: "ring", text: via ? `connecting: ${via}` : "connecting..." };
  },
  disconnected(via?: string): NodeStatus {
    return { fill: "red", shape: "ring", text: via ? `disconnected: ${via}` : "disconnected" };
  },
  error(msg: string): NodeStatus {
    return { fill: "red", shape: "dot", text: msg };
  },
  reading(): NodeStatus {
    return { fill: "blue", shape: "dot", text: "reading..." };
  },
  writing(): NodeStatus {
    return { fill: "blue", shape: "dot", text: "writing..." };
  },
  scanning(): NodeStatus {
    return { fill: "green", shape: "ring", text: "scanning" };
  },
  idle(): NodeStatus {
    return { fill: "grey", shape: "ring", text: "idle" };
  },
};

/**
 * Debounce: ensures a function isn't called more often than `wait` ms.
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Parse a comma-separated or JSON array string of tag names.
 */
export function parseTagList(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr.map((s: any) => String(s).trim()).filter(Boolean) : [];
    } catch {
      // fall through to comma split
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Measure execution time of an async function.
 */
export async function withTiming<T>(fn: () => Promise<T>): Promise<{ result: T; elapsed: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, elapsed: Date.now() - start };
}
