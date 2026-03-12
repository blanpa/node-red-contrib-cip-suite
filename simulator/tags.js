/**
 * Simulated PLC tag database.
 * Provides per-profile tag sets matching real hardware behavior.
 * @module tags
 */

// CIP data type codes (matching st-ethernet-ip expectations)
const CIP_TYPES = {
  BOOL: 0xc1,
  SINT: 0xc2,
  INT: 0xc3,
  DINT: 0xc4,
  LINT: 0xc6,
  REAL: 0xca,
  STRING: 0xd0
};

function tag(name, type, typeName, value, extra) {
  return { name, type, typeName, value, dims: 0, ...extra };
}

function arrayTag(name, type, typeName, value) {
  return { name, type, typeName, value, dims: 1, arraySize: value.length };
}

function pcccTag(name, type, typeName, value, fileNumber) {
  return { name, type, typeName, value, fileNumber };
}

function programTag(name, type, typeName, value, program) {
  return { name, type, typeName, value, dims: 0, program };
}

// ─── Tag sets per profile ────────────────────────────────────────────

/**
 * ControlLogix / CompactLogix: full-featured tag set.
 */
function createControlLogixTags() {
  const tags = new Map();

  // Scalar tags
  tags.set("MyBool", tag("MyBool", CIP_TYPES.BOOL, "BOOL", 1));
  tags.set("MyInt", tag("MyInt", CIP_TYPES.INT, "INT", 1234));
  tags.set("MyDint", tag("MyDint", CIP_TYPES.DINT, "DINT", 42));
  tags.set("MyReal", tag("MyReal", CIP_TYPES.REAL, "REAL", 3.14));
  tags.set("Counter", tag("Counter", CIP_TYPES.DINT, "DINT", 0));
  tags.set("Temperature", tag("Temperature", CIP_TYPES.REAL, "REAL", 22.5));
  tags.set("MotorRunning", tag("MotorRunning", CIP_TYPES.BOOL, "BOOL", 0));
  tags.set("SetPoint", tag("SetPoint", CIP_TYPES.REAL, "REAL", 75.0));

  // Program-scoped tags
  tags.set("Program:MainProgram.MyTag",
    programTag("Program:MainProgram.MyTag", CIP_TYPES.DINT, "DINT", 100, "MainProgram"));
  tags.set("Program:MainProgram.Speed",
    programTag("Program:MainProgram.Speed", CIP_TYPES.REAL, "REAL", 60.0, "MainProgram"));

  // Array tags
  tags.set("MyIntArray",
    arrayTag("MyIntArray", CIP_TYPES.INT, "INT", [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]));
  tags.set("MyRealArray",
    arrayTag("MyRealArray", CIP_TYPES.REAL, "REAL", [1.1, 2.2, 3.3, 4.4, 5.5]));

  // Extended types
  tags.set("MyLint", tag("MyLint", CIP_TYPES.LINT, "LINT", 123456789));
  tags.set("StatusWord", tag("StatusWord", CIP_TYPES.DINT, "DINT", 0x0000ff0a));

  // PCCC register files
  tags.set("_PCCC_N7", pcccTag("_PCCC_N7", "PCCC_INT", "Integer",
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900], 7));
  tags.set("_PCCC_F8", pcccTag("_PCCC_F8", "PCCC_FLOAT", "Float",
    [1.23, 4.56, 7.89, 10.11, 12.13], 8));
  tags.set("_PCCC_B3", pcccTag("_PCCC_B3", "PCCC_BIT", "Bit",
    [0xabcd, 0x1234], 3));

  return tags;
}

/**
 * Micro850: I/O tags only (24 digital: 10 DO + 14 DI), all BOOL.
 * Matches real 2080-L50E-24QWB hardware.
 */
function createMicro800Tags() {
  const tags = new Map();

  // 10 Digital Outputs
  for (let i = 0; i < 10; i++) {
    const name = `_IO_EM_DO_${String(i).padStart(2, "0")}`;
    tags.set(name, tag(name, CIP_TYPES.BOOL, "BOOL", 0));
  }

  // 14 Digital Inputs
  for (let i = 0; i < 14; i++) {
    const name = `_IO_EM_DI_${String(i).padStart(2, "0")}`;
    tags.set(name, tag(name, CIP_TYPES.BOOL, "BOOL", i % 2)); // alternate on/off
  }

  // A few user tags typical for Micro800
  tags.set("Counter", tag("Counter", CIP_TYPES.DINT, "DINT", 0));
  tags.set("SetPoint", tag("SetPoint", CIP_TYPES.REAL, "REAL", 50.0));
  tags.set("MotorRunning", tag("MotorRunning", CIP_TYPES.BOOL, "BOOL", 0));

  return tags;
}

/**
 * MicroLogix 1400: PCCC register files, minimal CIP tags.
 */
function createMicroLogixTags() {
  const tags = new Map();

  // PCCC register files (primary interface)
  tags.set("_PCCC_N7", pcccTag("_PCCC_N7", "PCCC_INT", "Integer",
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900], 7));
  tags.set("_PCCC_F8", pcccTag("_PCCC_F8", "PCCC_FLOAT", "Float",
    [1.23, 4.56, 7.89, 10.11, 12.13], 8));
  tags.set("_PCCC_B3", pcccTag("_PCCC_B3", "PCCC_BIT", "Bit",
    [0xabcd, 0x1234], 3));

  // A few basic CIP tags (MicroLogix supports limited CIP)
  tags.set("Counter", tag("Counter", CIP_TYPES.DINT, "DINT", 0));
  tags.set("Temperature", tag("Temperature", CIP_TYPES.REAL, "REAL", 22.5));

  return tags;
}

/**
 * PLC-5: PCCC-only, no CIP tags.
 */
function createPLC5Tags() {
  const tags = new Map();

  tags.set("_PCCC_N7", pcccTag("_PCCC_N7", "PCCC_INT", "Integer",
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900], 7));
  tags.set("_PCCC_F8", pcccTag("_PCCC_F8", "PCCC_FLOAT", "Float",
    [1.23, 4.56, 7.89, 10.11, 12.13], 8));
  tags.set("_PCCC_B3", pcccTag("_PCCC_B3", "PCCC_BIT", "Bit",
    [0xabcd, 0x1234], 3));

  return tags;
}

// ─── Tag set registry ────────────────────────────────────────────────

const tagSetCreators = {
  controllogix: createControlLogixTags,
  compactlogix: createControlLogixTags,  // same tag features
  micro800: createMicro800Tags,
  micrologix: createMicroLogixTags,
  plc5: createPLC5Tags,
};

/**
 * Create tag set for the given profile.
 * @param {string} [tagSet] - tag set name from profile (default: "controllogix")
 * @returns {Map<string, object>}
 */
function createDefaultTags(tagSet) {
  const creator = tagSetCreators[tagSet || "controllogix"];
  if (!creator) return createControlLogixTags();
  return creator();
}

module.exports = { CIP_TYPES, createDefaultTags };
