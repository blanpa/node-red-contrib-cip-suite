import {
  parsePCCCAddress,
  buildPCCCReadCommand,
  buildPCCCWriteCommand,
  parsePCCCReadResponse,
  buildCIPPcccMessage,
  pcccTypeName,
} from "../src/pccc-utils";
import { PCCCFileType } from "../src/types";

// ── parsePCCCAddress ──

describe("parsePCCCAddress", () => {
  it("parses integer address N7:0", () => {
    const a = parsePCCCAddress("N7:0");
    expect(a.fileType).toBe(PCCCFileType.INTEGER);
    expect(a.fileNumber).toBe(7);
    expect(a.elementNumber).toBe(0);
    expect(a.subElement).toBe(0);
    expect(a.bitNumber).toBeNull();
    expect(a.typeLetter).toBe("N");
    expect(a.elementSize).toBe(2);
  });

  it("parses float address F8:5", () => {
    const a = parsePCCCAddress("F8:5");
    expect(a.fileType).toBe(PCCCFileType.FLOAT);
    expect(a.fileNumber).toBe(8);
    expect(a.elementNumber).toBe(5);
    expect(a.elementSize).toBe(4);
  });

  it("parses bit address B3:0/5", () => {
    const a = parsePCCCAddress("B3:0/5");
    expect(a.fileType).toBe(PCCCFileType.BIT);
    expect(a.fileNumber).toBe(3);
    expect(a.elementNumber).toBe(0);
    expect(a.bitNumber).toBe(5);
  });

  it("parses integer bit access N7:0/3", () => {
    const a = parsePCCCAddress("N7:0/3");
    expect(a.fileType).toBe(PCCCFileType.INTEGER);
    expect(a.bitNumber).toBe(3);
  });

  it("parses timer T4:0", () => {
    const a = parsePCCCAddress("T4:0");
    expect(a.fileType).toBe(PCCCFileType.TIMER);
    expect(a.fileNumber).toBe(4);
    expect(a.subElement).toBe(0);
    expect(a.elementSize).toBe(6);
  });

  it("parses timer sub-element T4:0.ACC", () => {
    const a = parsePCCCAddress("T4:0.ACC");
    expect(a.fileType).toBe(PCCCFileType.TIMER);
    expect(a.subElement).toBe(2);
  });

  it("parses timer sub-element T4:0.PRE", () => {
    const a = parsePCCCAddress("T4:0.PRE");
    expect(a.subElement).toBe(1);
  });

  it("parses counter C5:0.ACC", () => {
    const a = parsePCCCAddress("C5:0.ACC");
    expect(a.fileType).toBe(PCCCFileType.COUNTER);
    expect(a.subElement).toBe(2);
  });

  it("parses output O:0", () => {
    const a = parsePCCCAddress("O:0");
    expect(a.fileType).toBe(PCCCFileType.OUTPUT);
    expect(a.fileNumber).toBe(0);
    expect(a.elementNumber).toBe(0);
  });

  it("parses input with bit I:1/0", () => {
    const a = parsePCCCAddress("I:1/0");
    expect(a.fileType).toBe(PCCCFileType.INPUT);
    expect(a.fileNumber).toBe(1);
    expect(a.elementNumber).toBe(1);
    expect(a.bitNumber).toBe(0);
  });

  it("parses status S:1/5", () => {
    const a = parsePCCCAddress("S:1/5");
    expect(a.fileType).toBe(PCCCFileType.STATUS);
    expect(a.fileNumber).toBe(2); // default
    expect(a.bitNumber).toBe(5);
  });

  it("parses string ST9:0", () => {
    const a = parsePCCCAddress("ST9:0");
    expect(a.fileType).toBe(PCCCFileType.STRING);
    expect(a.fileNumber).toBe(9);
    expect(a.elementSize).toBe(84);
  });

  it("parses long L10:0", () => {
    const a = parsePCCCAddress("L10:0");
    expect(a.fileType).toBe(PCCCFileType.LONG);
    expect(a.fileNumber).toBe(10);
    expect(a.elementSize).toBe(4);
  });

  it("is case-insensitive", () => {
    const a = parsePCCCAddress("n7:0");
    expect(a.fileType).toBe(PCCCFileType.INTEGER);
  });

  it("throws on invalid address", () => {
    expect(() => parsePCCCAddress("INVALID")).toThrow("Invalid PCCC address");
  });

  it("throws on unknown file type", () => {
    expect(() => parsePCCCAddress("X1:0")).toThrow("Unknown PCCC file type");
  });
});

// ── buildPCCCReadCommand ──

describe("buildPCCCReadCommand", () => {
  it("builds read for N7:0", () => {
    const addr = parsePCCCAddress("N7:0");
    const cmd = buildPCCCReadCommand(addr);
    expect(cmd.length).toBe(7);
    expect(cmd[0]).toBe(2);  // byte count = elementSize(2) * 1
    expect(cmd[1]).toBe(7);  // file number
    expect(cmd[2]).toBe(PCCCFileType.INTEGER); // file type
    expect(cmd[3]).toBe(0);  // element low
    expect(cmd[4]).toBe(0);  // element high
    expect(cmd[5]).toBe(0);  // sub-element low
    expect(cmd[6]).toBe(0);  // sub-element high
  });

  it("builds read for F8:3 with count=2", () => {
    const addr = parsePCCCAddress("F8:3");
    const cmd = buildPCCCReadCommand(addr, 2);
    expect(cmd[0]).toBe(8);  // 4 bytes * 2
    expect(cmd[1]).toBe(8);  // file 8
    expect(cmd[3]).toBe(3);  // element 3
  });

  it("builds read for timer sub-element T4:0.ACC (single word)", () => {
    const addr = parsePCCCAddress("T4:0.ACC");
    const cmd = buildPCCCReadCommand(addr);
    expect(cmd[0]).toBe(2);  // single word for sub-element
    expect(cmd[5]).toBe(2);  // sub-element ACC=2
  });

  it("builds read for full timer T4:0 (6 bytes)", () => {
    const addr = parsePCCCAddress("T4:0");
    const cmd = buildPCCCReadCommand(addr);
    expect(cmd[0]).toBe(6);  // full element: 6 bytes
  });
});

// ── buildPCCCWriteCommand ──

describe("buildPCCCWriteCommand", () => {
  it("builds write for N7:0 = 42", () => {
    const addr = parsePCCCAddress("N7:0");
    const cmd = buildPCCCWriteCommand(addr, 42);
    expect(cmd.length).toBe(7 + 2); // header + 2 bytes INT
    expect(cmd[0]).toBe(2);  // byte size
    expect(cmd.readInt16LE(7)).toBe(42); // value
  });

  it("builds write for F8:0 = 3.14", () => {
    const addr = parsePCCCAddress("F8:0");
    const cmd = buildPCCCWriteCommand(addr, 3.14);
    expect(cmd.length).toBe(7 + 4);
    expect(cmd.readFloatLE(7)).toBeCloseTo(3.14, 2);
  });

  it("builds write for boolean B3:0 = true", () => {
    const addr = parsePCCCAddress("B3:0");
    const cmd = buildPCCCWriteCommand(addr, true);
    expect(cmd.readInt16LE(7)).toBe(1);
  });

  it("builds write for string ST9:0", () => {
    const addr = parsePCCCAddress("ST9:0");
    const cmd = buildPCCCWriteCommand(addr, "Hello");
    expect(cmd.length).toBe(7 + 84);
    expect(cmd.readUInt16LE(7)).toBe(5); // string length
    expect(cmd.slice(9, 14).toString("ascii")).toBe("Hello");
  });

  it("builds write for long L10:0 = 100000", () => {
    const addr = parsePCCCAddress("L10:0");
    const cmd = buildPCCCWriteCommand(addr, 100000);
    expect(cmd.readInt32LE(7)).toBe(100000);
  });
});

// ── parsePCCCReadResponse ──

describe("parsePCCCReadResponse", () => {
  it("parses integer response", () => {
    const addr = parsePCCCAddress("N7:0");
    const data = Buffer.alloc(2);
    data.writeInt16LE(1234, 0);
    expect(parsePCCCReadResponse(data, addr)).toBe(1234);
  });

  it("parses negative integer", () => {
    const addr = parsePCCCAddress("N7:0");
    const data = Buffer.alloc(2);
    data.writeInt16LE(-500, 0);
    expect(parsePCCCReadResponse(data, addr)).toBe(-500);
  });

  it("parses float response", () => {
    const addr = parsePCCCAddress("F8:0");
    const data = Buffer.alloc(4);
    data.writeFloatLE(3.14, 0);
    expect(parsePCCCReadResponse(data, addr)).toBeCloseTo(3.14, 2);
  });

  it("parses bit extraction B3:0/5 from 0x0020", () => {
    const addr = parsePCCCAddress("B3:0/5");
    const data = Buffer.alloc(2);
    data.writeInt16LE(0x0020, 0); // bit 5 set
    expect(parsePCCCReadResponse(data, addr)).toBe(true);
  });

  it("parses bit extraction B3:0/5 from 0x0000", () => {
    const addr = parsePCCCAddress("B3:0/5");
    const data = Buffer.alloc(2);
    data.writeInt16LE(0x0000, 0);
    expect(parsePCCCReadResponse(data, addr)).toBe(false);
  });

  it("parses full timer (CTL/PRE/ACC)", () => {
    const addr = parsePCCCAddress("T4:0");
    const data = Buffer.alloc(6);
    data.writeUInt16LE(0x8001, 0); // CTL
    data.writeInt16LE(1000, 2);    // PRE
    data.writeInt16LE(500, 4);     // ACC
    const result = parsePCCCReadResponse(data, addr);
    expect(result.CTL).toBe(0x8001);
    expect(result.PRE).toBe(1000);
    expect(result.ACC).toBe(500);
  });

  it("parses timer sub-element T4:0.ACC", () => {
    const addr = parsePCCCAddress("T4:0.ACC");
    const data = Buffer.alloc(2);
    data.writeInt16LE(750, 0);
    expect(parsePCCCReadResponse(data, addr)).toBe(750);
  });

  it("parses string response", () => {
    const addr = parsePCCCAddress("ST9:0");
    const data = Buffer.alloc(10);
    data.writeUInt16LE(5, 0);
    Buffer.from("Hello").copy(data, 2);
    expect(parsePCCCReadResponse(data, addr)).toBe("Hello");
  });

  it("parses long response", () => {
    const addr = parsePCCCAddress("L10:0");
    const data = Buffer.alloc(4);
    data.writeInt32LE(100000, 0);
    expect(parsePCCCReadResponse(data, addr)).toBe(100000);
  });

  it("returns null for too-short data", () => {
    const addr = parsePCCCAddress("N7:0");
    expect(parsePCCCReadResponse(Buffer.alloc(1), addr)).toBeNull();
  });
});

// ── buildCIPPcccMessage ──

describe("buildCIPPcccMessage", () => {
  it("builds valid CIP wrapper", () => {
    const data = Buffer.alloc(7);
    const msg = buildCIPPcccMessage(0x0f, 0xa2, data, 1);

    expect(msg[0]).toBe(0x4b); // Execute PCCC service
    expect(msg[1]).toBe(2);    // path size in words (4 bytes / 2)
    expect(msg[2]).toBe(0x20); // class segment
    expect(msg[3]).toBe(0x67); // PCCC Object class
    expect(msg[4]).toBe(0x24); // instance segment
    expect(msg[5]).toBe(0x01); // instance 1

    // Requester ID
    expect(msg[6]).toBe(7);           // requester ID length
    expect(msg.readUInt16LE(7)).toBe(1); // vendor ID

    // PCCC packet starts at offset 6 + 7 = 13
    const pcccStart = 6 + 7;
    expect(msg[pcccStart]).toBe(0x0f);          // CMD
    expect(msg[pcccStart + 1]).toBe(0x00);      // STS
    expect(msg.readUInt16LE(pcccStart + 2)).toBe(1); // TNS
    expect(msg[pcccStart + 4]).toBe(0xa2);      // FNC
  });

  it("includes PCCC data payload", () => {
    const data = Buffer.from([0x02, 0x07, 0x89]);
    const msg = buildCIPPcccMessage(0x0f, 0xa2, data, 5);
    // Total = 2(service+pathSize) + 4(path) + 7(reqId) + 5(pcccHeader) + 3(data) = 21
    expect(msg.length).toBe(21);
  });
});

// ── pcccTypeName ──

describe("pcccTypeName", () => {
  it("returns correct names", () => {
    expect(pcccTypeName(parsePCCCAddress("N7:0"))).toBe("Integer");
    expect(pcccTypeName(parsePCCCAddress("F8:0"))).toBe("Float");
    expect(pcccTypeName(parsePCCCAddress("T4:0"))).toBe("Timer");
    expect(pcccTypeName(parsePCCCAddress("B3:0"))).toBe("Bit");
    expect(pcccTypeName(parsePCCCAddress("O:0"))).toBe("Output");
    expect(pcccTypeName(parsePCCCAddress("I:0"))).toBe("Input");
    expect(pcccTypeName(parsePCCCAddress("S:0"))).toBe("Status");
    expect(pcccTypeName(parsePCCCAddress("ST9:0"))).toBe("String");
  });
});
