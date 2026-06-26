/**
 * PLC manufacturer/model profiles for the CIP simulator.
 * Each profile defines identity data, behavioral flags, and tag configuration.
 *
 * Usage: PLC_TYPE=micro800 node server.js
 * @module profiles
 */

const profiles = {
  /**
   * Allen-Bradley ControlLogix L85E (1756 series)
   * Full-featured: connected messaging, ForwardOpen, program-scoped tags.
   */
  controllogix: {
    name: "1756-L85E/B ControlLogix",
    vendor: 0x0001,         // Rockwell Automation
    deviceType: 0x000e,     // Programmable Logic Controller
    productCode: 0x0037,    // ControlLogix 5580
    majorRevision: 32,
    minorRevision: 11,
    serial: 0xdeadbeef,
    // Behavioral flags
    supportsForwardOpen: true,
    supportsConnectedMessaging: true,
    supportsTagBrowse: true,
    supportsPCCC: true,
    supportsReadControllerProps: true,
    tagSet: "controllogix",
  },

  /**
   * Allen-Bradley CompactLogix 5380 (5069 series)
   * Very similar to ControlLogix but smaller form factor.
   */
  compactlogix: {
    name: "5069-L320ER CompactLogix",
    vendor: 0x0001,
    deviceType: 0x000e,
    productCode: 0x006b,    // CompactLogix 5380
    majorRevision: 33,
    minorRevision: 1,
    serial: 0xcafe0001,
    supportsForwardOpen: true,
    supportsConnectedMessaging: true,
    supportsTagBrowse: true,
    supportsPCCC: true,
    supportsReadControllerProps: true,
    tagSet: "compactlogix",
  },

  /**
   * Allen-Bradley Micro850 (2080-L50E-24QWB)
   * No backplane → no UnconnectedSend, no ForwardOpen.
   * All messaging via SendRRData (UCMM) only.
   * st-ethernet-ip: Controller(false), connect(ip, slot, false)
   */
  micro800: {
    name: "2080-L50E-24QWB Micro850",
    vendor: 0x0001,
    deviceType: 0x000e,
    productCode: 0x012d,    // 301 = Micro850
    majorRevision: 22,
    minorRevision: 11,
    serial: 0xbeef0850,
    supportsForwardOpen: false,
    supportsConnectedMessaging: false,
    supportsTagBrowse: true,
    supportsPCCC: false,
    supportsReadControllerProps: false,
    tagSet: "micro800",
  },

  /**
   * Allen-Bradley MicroLogix 1400 (1766 series)
   * Supports connected messaging + PCCC. Limited CIP tag support.
   */
  micrologix: {
    name: "1766-L32BWA MicroLogix 1400",
    vendor: 0x0001,
    deviceType: 0x000e,
    productCode: 0x003f,    // MicroLogix 1400
    majorRevision: 21,
    minorRevision: 7,
    serial: 0xfeed1400,
    supportsForwardOpen: true,
    supportsConnectedMessaging: true,
    supportsTagBrowse: false,
    supportsPCCC: true,
    supportsReadControllerProps: true,
    tagSet: "micrologix",
  },

  /**
   * Allen-Bradley PowerFlex 525 AC drive (25B series, embedded EtherNet/IP).
   * No Logix tags — controlled with implicit (Class 1) I/O via ForwardOpen + UDP.
   * Models the real drive's strict Forward_Open acceptance: the produced/consumed
   * assemblies must use Connection Point path segments and the transport must be
   * Server + Class 1, or the drive rejects with CIP general status 0x01.
   */
  powerflex525: {
    name: "25B-D PowerFlex 525",
    vendor: 0x0001,         // Rockwell Automation
    deviceType: 0x0096,     // AC Drive
    productCode: 0x0009,
    majorRevision: 5,
    minorRevision: 1,
    serial: 0x0f525001,
    supportsForwardOpen: true,
    supportsConnectedMessaging: false,
    supportsTagBrowse: false,
    supportsPCCC: false,
    supportsReadControllerProps: false,
    // Implicit I/O behaviour
    supportsImplicitIO: true,
    strictDriveForwardOpen: true,
    ioConfig: {
      configInstance: 6,
      outputInstance: 2,   // O→T (Logic Command + Speed Reference), produced by scanner
      inputInstance: 1,    // T→O (Logic Status + Speed Feedback), produced by drive
      inputSize: 8,        // bytes the drive produces on T→O
    },
    tagSet: "powerflex525",
  },

  /**
   * Allen-Bradley PLC-5/40E
   * Classic PCCC-only controller. No CIP tag read/write.
   */
  plc5: {
    name: "1785-L40E PLC-5/40E",
    vendor: 0x0001,
    deviceType: 0x000e,
    productCode: 0x000a,
    majorRevision: 12,
    minorRevision: 1,
    serial: 0xdead0005,
    supportsForwardOpen: true,
    supportsConnectedMessaging: true,
    supportsTagBrowse: false,
    supportsPCCC: true,
    supportsReadControllerProps: true,
    tagSet: "plc5",
  },
};

/**
 * Get profile by name from PLC_TYPE environment variable.
 * @param {string} [type] - profile key (default: "controllogix")
 * @returns {object} profile
 */
function getProfile(type) {
  const key = (type || "controllogix").toLowerCase().replace(/[-_\s]/g, "");
  const profile = profiles[key];
  if (!profile) {
    const available = Object.keys(profiles).join(", ");
    console.error(`Unknown PLC_TYPE "${type}". Available: ${available}`);
    console.error("Falling back to controllogix.");
    return profiles.controllogix;
  }
  return profile;
}

module.exports = { profiles, getProfile };
