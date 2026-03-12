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
