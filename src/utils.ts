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
 * Standard Node-RED status objects.
 */
export const STATUS = {
  connected(): NodeStatus {
    return { fill: "green", shape: "dot", text: "connected" };
  },
  connecting(): NodeStatus {
    return { fill: "yellow", shape: "ring", text: "connecting..." };
  },
  disconnected(): NodeStatus {
    return { fill: "red", shape: "ring", text: "disconnected" };
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
