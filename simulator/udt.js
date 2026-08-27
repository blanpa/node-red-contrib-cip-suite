/**
 * UDT (user-defined type) support for the simulator.
 *
 * Provides template definitions, their Template Object (class 0x6C) wire
 * encoding, and the backing buffers that struct tag reads slice from. This is
 * what lets the simulator reproduce a Logix program that stores arrays inside
 * nested UDTs — the shape reported in issue #4.
 * @module udt
 */

/** Byte size of the atomic CIP types the simulator understands. */
const ATOMIC_SIZE = {
  0xc1: 1, // BOOL
  0xc2: 1, // SINT
  0xc3: 2, // INT
  0xc4: 4, // DINT
  0xc6: 8, // LINT
  0xca: 4, // REAL
};

const STRUCT_TYPE = 0x02a0;

/**
 * Build a template from member specs, computing member offsets and the total
 * structure size. Nested templates must be defined first.
 *
 * @param {number} id - template (and tag type) code
 * @param {string} name - UDT name as reported by the controller
 * @param {number} structureHandle - opaque handle echoed in struct read replies
 * @param {Array<{name: string, type?: number, template?: object, count?: number}>} memberSpecs
 * @returns {object} template
 */
function defineTemplate(id, name, structureHandle, memberSpecs) {
  let offset = 0;
  const members = memberSpecs.map((spec) => {
    const count = spec.count || 1;
    const structure = !!spec.template;
    const elementSize = structure ? spec.template.structureSize : ATOMIC_SIZE[spec.type];
    if (!elementSize) throw new Error(`Unknown member type for ${name}.${spec.name}`);

    const member = {
      name: spec.name,
      typeCode: structure ? spec.template.id : spec.type,
      structure,
      template: spec.template || null,
      arrayDims: count > 1 ? 1 : 0,
      count,
      elementSize,
      offset,
    };
    offset += elementSize * count;
    return member;
  });

  return { id, name, structureHandle, structureSize: offset, members };
}

/** Type word as it appears in a template member entry and in the tag list. */
function typeWord(typeCode, structure, arrayDims) {
  return (typeCode & 0x0fff) | (structure ? 0x8000 : 0) | ((arrayDims & 0x03) << 13);
}

/**
 * Encode a template the way the Template Object's Read Template service returns
 * it: one 8-byte entry per member, then the UDT name, then the member names.
 * @param {object} template
 * @returns {Buffer}
 */
function encodeTemplateDefinition(template) {
  const entries = Buffer.alloc(template.members.length * 8);
  template.members.forEach((member, i) => {
    const base = i * 8;
    // "info" carries the element count for array members (bit position for BOOL).
    entries.writeUInt16LE(member.arrayDims > 0 ? member.count : 0, base);
    entries.writeUInt16LE(typeWord(member.typeCode, member.structure, member.arrayDims), base + 2);
    entries.writeUInt32LE(member.offset, base + 4);
  });

  // Logix appends ";n<x>_<size>" to the UDT name; the parser stops at the ';'.
  const names = [`${template.name};n0_${template.structureSize}`].concat(
    template.members.map((m) => m.name)
  );
  const nameBytes = Buffer.concat(
    names.map((n) => Buffer.concat([Buffer.from(n, "ascii"), Buffer.from([0x00])]))
  );

  return Buffer.concat([entries, nameBytes]);
}

/**
 * Encode the Template Object attribute list (attributes 4, 5, 2, 1) in the
 * order st-ethernet-ip requests and parses them.
 * @param {object} template
 * @returns {Buffer}
 */
function encodeTemplateAttributes(template) {
  const definitionLength = encodeTemplateDefinition(template).length;
  // Read Template asks for `objDefinitionSize * 4 - 16` bytes, so round up.
  const objDefinitionSize = Math.ceil((definitionLength + 16) / 4);

  const buf = Buffer.alloc(30);
  buf.writeUInt16LE(4, 0); // attribute count
  buf.writeUInt16LE(4, 2); // attribute 4 — object definition size (32-bit words)
  buf.writeUInt16LE(0, 4); // status
  buf.writeUInt32LE(objDefinitionSize, 6);
  buf.writeUInt16LE(5, 10); // attribute 5 — structure size in bytes
  buf.writeUInt16LE(0, 12);
  buf.writeUInt32LE(template.structureSize, 14);
  buf.writeUInt16LE(2, 18); // attribute 2 — member count
  buf.writeUInt16LE(0, 20);
  buf.writeUInt16LE(template.members.length, 22);
  buf.writeUInt16LE(1, 24); // attribute 1 — structure handle
  buf.writeUInt16LE(0, 26);
  buf.writeUInt16LE(template.structureHandle, 28);
  return buf;
}

// ─── The UDT used by the ControlLogix profile ───────────────────────
//
// Mirrors the tag shape from issue #4: an array of stations, each holding a
// nested UDT whose members are long arrays.
//
//   FIS_Stn : FIS_STATION[5]
//     └── Local : FIS_LOCAL
//           ├── FBCONTROL : DINT[2]
//           ├── FBFACTUAL : REAL[102]
//           ├── FBCOMPARE : REAL[102]
//           └── FBRESULT  : DINT[2]

const FIS_LOCAL = defineTemplate(0x0301, "FIS_LOCAL", 0x4d18, [
  { name: "FBCONTROL", type: 0xc4, count: 2 },
  { name: "FBFACTUAL", type: 0xca, count: 102 },
  { name: "FBCOMPARE", type: 0xca, count: 102 },
  { name: "FBRESULT", type: 0xc4, count: 2 },
]);

const FIS_STATION = defineTemplate(0x0302, "FIS_STATION", 0x4d19, [
  { name: "Local", template: FIS_LOCAL },
]);

const TEMPLATES = new Map([
  [FIS_LOCAL.id, FIS_LOCAL],
  [FIS_STATION.id, FIS_STATION],
]);

/** Number of FIS_Stn elements the simulator publishes. */
const FIS_STN_COUNT = 5;

/**
 * Deterministic contents for the FIS_Stn array, so tests can assert exact values.
 * @returns {Buffer}
 */
function buildFisStnData() {
  const buf = Buffer.alloc(FIS_STATION.structureSize * FIS_STN_COUNT);
  for (let station = 0; station < FIS_STN_COUNT; station++) {
    const base = station * FIS_STATION.structureSize;
    const local = base + FIS_STATION.members[0].offset;
    const member = (name) => local + FIS_LOCAL.members.find((m) => m.name === name).offset;

    buf.writeInt32LE(station, member("FBCONTROL"));
    buf.writeInt32LE(7, member("FBCONTROL") + 4);
    for (let i = 0; i < 102; i++) {
      buf.writeFloatLE(station * 1000 + i, member("FBFACTUAL") + i * 4);
      buf.writeFloatLE(-(i + 1), member("FBCOMPARE") + i * 4);
    }
    buf.writeInt32LE(11, member("FBRESULT"));
    buf.writeInt32LE(22, member("FBRESULT") + 4);
  }
  return buf;
}

module.exports = {
  ATOMIC_SIZE,
  STRUCT_TYPE,
  TEMPLATES,
  FIS_LOCAL,
  FIS_STATION,
  FIS_STN_COUNT,
  buildFisStnData,
  defineTemplate,
  encodeTemplateAttributes,
  encodeTemplateDefinition,
  typeWord,
};
