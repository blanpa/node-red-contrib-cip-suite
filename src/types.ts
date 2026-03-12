/**
 * Shared type definitions for cip-suite.
 * Includes Node-RED runtime types and CIP/EtherNet/IP types.
 */

// ── Node-RED runtime types (minimal subset we need) ──

export interface NodeRedRuntime {
  nodes: {
    createNode(node: any, config: any): void;
    registerType(type: string, constructor: Function, opts?: any): void;
    getNode(id: string): any;
  };
  httpAdmin: {
    get(path: string, handler: (req: any, res: any) => void): void;
  };
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export interface NodeRedNode {
  id: string;
  name: string;
  type: string;
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string, msg2?: any): void;
  status(params: NodeStatus): void;
  send(msg: any): void;
  on(event: string, cb: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
}

export interface NodeStatus {
  fill?: "red" | "green" | "yellow" | "blue" | "grey";
  shape?: "ring" | "dot";
  text?: string;
}

// ── CIP Data Types ──

export enum CIPDataType {
  BOOL = 0x00c1,
  SINT = 0x00c2,
  INT = 0x00c3,
  DINT = 0x00c4,
  LINT = 0x00c5,
  USINT = 0x00c6,
  UINT = 0x00c7,
  UDINT = 0x00c8,
  LREAL = 0x00cb,
  REAL = 0x00ca,
  STRING = 0x00d0,
  SHORT_STRING = 0x00da,
  WORD = 0x00d1,
  DWORD = 0x00d2,
  LWORD = 0x00d3,
  STRUCT = 0x02a0,
}

export const CIP_TYPE_NAMES: Record<number, string> = {
  [CIPDataType.BOOL]: "BOOL",
  [CIPDataType.SINT]: "SINT",
  [CIPDataType.INT]: "INT",
  [CIPDataType.DINT]: "DINT",
  [CIPDataType.LINT]: "LINT",
  [CIPDataType.USINT]: "USINT",
  [CIPDataType.UINT]: "UINT",
  [CIPDataType.UDINT]: "UDINT",
  [CIPDataType.REAL]: "REAL",
  [CIPDataType.LREAL]: "LREAL",
  [CIPDataType.STRING]: "STRING",
  [CIPDataType.SHORT_STRING]: "SHORT_STRING",
  [CIPDataType.WORD]: "WORD",
  [CIPDataType.DWORD]: "DWORD",
  [CIPDataType.LWORD]: "LWORD",
  [CIPDataType.STRUCT]: "STRUCT",
};

// ── CIP Service Codes ──

export enum CIPService {
  GET_ATTRIBUTE_ALL = 0x01,
  SET_ATTRIBUTE_ALL = 0x02,
  GET_ATTRIBUTE_LIST = 0x03,
  SET_ATTRIBUTE_LIST = 0x04,
  RESET = 0x05,
  START = 0x06,
  STOP = 0x07,
  CREATE = 0x08,
  DELETE = 0x09,
  MULTIPLE_SERVICE_PACKET = 0x0a,
  APPLY_ATTRIBUTES = 0x0d,
  GET_ATTRIBUTE_SINGLE = 0x0e,
  SET_ATTRIBUTE_SINGLE = 0x10,
  FIND_NEXT = 0x11,
  READ_TAG = 0x4c,
  WRITE_TAG = 0x4d,
  READ_MODIFY_WRITE_TAG = 0x4e,
  READ_TAG_FRAGMENTED = 0x52,
  WRITE_TAG_FRAGMENTED = 0x53,
  FORWARD_OPEN = 0x54,
  GET_INSTANCE_ATTRIBUTE_LIST = 0x55,
  EXECUTE_PCCC = 0x4b,
  FORWARD_CLOSE = 0x4e,       // Note: same code as READ_MODIFY_WRITE_TAG — context-dependent
  GET_FILE_DATA = 0x4f,       // CIP File Object service
  INITIATE_UPLOAD = 0x4b,     // Note: same code as EXECUTE_PCCC — context-dependent (File Object)
  LARGE_FORWARD_OPEN = 0x5b,
}

// ── CIP Object Classes ──

export enum CIPClass {
  IDENTITY = 0x01,
  MESSAGE_ROUTER = 0x02,
  ASSEMBLY = 0x04,
  CONNECTION_MANAGER = 0x06,
  REGISTER = 0x07,
  PARAMETER = 0x0f,
  PORT = 0xf4,
  TCP_IP = 0xf5,
  ETHERNET_LINK = 0xf6,
  FILE = 0x37,
  MOTION_GROUP = 0x41,
  MOTION_AXIS = 0x42,
  TIME_SYNC = 0x43,
  ENERGY = 0x4f,
  CIP_SECURITY = 0x5d,
  PCCC = 0x67,
  SYMBOL = 0x6b,
  TEMPLATE = 0x6c,
  CONNECTION_CONFIG = 0xf3,
}

// ── CIP Status Codes ──

export const CIP_STATUS: Record<number, string> = {
  0x00: "Success",
  0x01: "Connection failure",
  0x02: "Resource unavailable",
  0x03: "Invalid parameter value",
  0x04: "Path segment error",
  0x05: "Path destination unknown",
  0x06: "Partial transfer",
  0x07: "Connection lost",
  0x08: "Service not supported",
  0x09: "Invalid attribute value",
  0x0a: "Attribute list error",
  0x0b: "Already in requested mode/state",
  0x0c: "Object state conflict",
  0x0d: "Object already exists",
  0x0e: "Attribute not settable",
  0x0f: "Privilege violation",
  0x10: "Device state conflict",
  0x11: "Reply data too large",
  0x12: "Fragmentation of primitive value",
  0x13: "Not enough data",
  0x14: "Attribute not supported",
  0x15: "Too much data",
  0x16: "Object does not exist",
  0x1a: "No stored attribute data",
  0x1b: "Store operation failure",
  0x1c: "Routing failure, request too large",
  0x1d: "Routing failure, response too large",
  0x1e: "Missing attribute list entry data",
  0x1f: "Invalid attribute value list",
  0x20: "Embedded service error",
  0x25: "Key failure in path",
  0x26: "Path size invalid",
  0x27: "Unexpected attribute in list",
  0x28: "Invalid member ID",
  0x29: "Member not settable",
};

// ── Endpoint config interface ──

export interface CipEndpointConfig {
  address: string;
  port: string;
  slot: string;
  connTimeout: string;
  retryInterval: string;
  useMicro800: boolean;
  routingPath: string;  // multi-hop routing (e.g., "1/2/192.168.1.1")
}

export interface CipEndpointNode extends NodeRedNode {
  address: string;
  port: number;
  slot: number;
  connTimeout: number;
  retryInterval: number;
  useMicro800: boolean;
  routingPath: string;
  plc: any; // st-ethernet-ip Controller
  connected: boolean;
  connecting: boolean;
  metrics: ConnectionMetrics;
  register(userNode: any): void;
  deregister(userNode: any): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readTag(tagName: string): Promise<{ value: any; type: string }>;
  writeTag(tagName: string, value: any, dataType?: number): Promise<void>;
  readModifyWriteTag(tagName: string, orMask: Buffer, andMask: Buffer): Promise<void>;
  readWallClock(): Promise<Date>;
  writeWallClock(date?: Date): Promise<void>;
  changeMode(mode: "run" | "program" | "test"): Promise<void>;
  resetFault(): Promise<void>;
  getController(): any;
}

export interface ConnectionMetrics {
  connected: boolean;
  connectTime: number | null;
  lastResponseTime: number;
  avgResponseTime: number;
  errorCount: number;
  reconnectCount: number;
  totalReads: number;
  totalWrites: number;
}

// ── Tag info from browse ──

export interface TagInfo {
  name: string;
  type: number | { typeName: string; code?: number; structure?: boolean };
  typeName: string;
  dimensions: number[];
  program: string | null;
  value?: any;
}

// ── Subscribe node config ──

export interface CipSubscribeConfig {
  endpoint: string;
  tags: string;      // comma-separated tag names or JSON array
  scanRate: string;   // ms
  deadband: string;   // for analog values
  diffOnly: boolean;  // report by exception
}

// ── Discover node config ──

export interface CipDiscoverConfig {
  broadcastAddress: string;
  timeout: string;
}

export interface DiscoveredDevice {
  address: string;
  port: number;
  vendorId: number;
  deviceType: number;
  productCode: number;
  revision: string;
  status: number;
  serial: string;
  productName: string;
}

// ── Controller node config ──

export interface CipControllerConfig {
  endpoint: string;
  pollInterval: string;
}

// ── PCCC types ──

export enum PCCCFileType {
  OUTPUT = 0x82,
  INPUT = 0x83,
  STATUS = 0x85,
  BIT = 0x86,
  TIMER = 0x87,
  COUNTER = 0x88,
  CONTROL = 0x89,
  INTEGER = 0x8a,
  FLOAT = 0x8b,
  MSD = 0x8c,     // message storage/display
  STRING = 0x8d,
  ASCII = 0x8e,
  BCD = 0x8f,
  LONG = 0x91,
}

export interface PCCCAddress {
  fileType: PCCCFileType;
  fileNumber: number;
  elementNumber: number;
  subElement: number;
  bitNumber: number | null;
  typeLetter: string;
  elementSize: number;    // bytes per element
  displayAddress: string; // original user string
}

export interface CipPcccEndpointConfig {
  address: string;
  port: string;
  connTimeout: string;
  retryInterval: string;
}

// ── I/O Scanner types ──

export interface CipIOScannerConfig {
  targetAddress: string;
  targetPort: string;
  rpi: string;               // Requested Packet Interval (ms)
  inputAssembly: string;     // instance number
  outputAssembly: string;
  configAssembly: string;
  inputSize: string;         // bytes
  outputSize: string;
  udpPort: string;           // local UDP port for I/O (default 2222)
}

// ── Utility types ──

export interface ReadResult {
  value: any;
  type: string;
  typeCode?: number;
  tagName: string;
  timestamp: number;
  bitIndex?: number;
  arrayIndex?: number;
}

export interface WriteResult {
  success: boolean;
  tagName: string;
  value: any;
  error?: string;
  timestamp: number;
}

export interface MultiTagResult {
  tagName: string;
  value: any;
  type: string;
  error?: string;
}

// ── CIP Security (Object 0x5D) ──

export interface CipSecurityConfig {
  endpoint: string;
  certPath: string;
  keyPath: string;
  caPath: string;
  securityMode: 'none' | 'integrity' | 'confidentiality';
}

// ── CIP Sync / IEEE 1588 PTP (Object 0x43) ──

export interface CipSyncConfig {
  endpoint: string;
  enablePTP: boolean;
  ptpDomain: string;
  grandmasterPriority: string;
}

export interface PTPClockQuality {
  clockClass: number;
  clockAccuracy: number;
  offsetScaledLogVariance: number;
}

export interface PTPGrandmasterInfo {
  clockIdentity: string;
  priority1: number;
  priority2: number;
  clockQuality: PTPClockQuality;
  timeSource: number;
}

// ── CIP Motion (Axis Object 0x42, Motion Group 0x41) ──

export interface CipMotionConfig {
  endpoint: string;
  axisInstance: string;
  groupInstance: string;
}

export enum MotionCommand {
  JOG = 1,
  MOVE_ABSOLUTE = 2,
  MOVE_RELATIVE = 3,
  HOME = 4,
  STOP = 5,
  CHANGE_SPEED = 6,
  GEAR = 7,
  CHANGE_DECEL = 8,
}

export enum AxisState {
  IDLE = 0,
  STANDSTILL = 1,
  HOMING = 2,
  DISCRETE_MOTION = 3,
  CONTINUOUS_MOTION = 4,
  SYNCHRONIZED_MOTION = 5,
  STOPPING = 6,
  ERROR_STOP = 7,
}

// ── CIP Energy (Object 0x4F) ──

export interface CipEnergyConfig {
  endpoint: string;
  pollInterval: string;
}

export enum EnergyMode {
  NORMAL = 0,
  ENERGY_SAVING = 1,
  ENERGY_OFF = 2,
  PAUSED = 3,
}

// ── File Object (0x37) ──

export interface CipFileConfig {
  endpoint: string;
  fileInstance: string;
}

export enum FileTransferState {
  IDLE = 0,
  UPLOAD_IN_PROGRESS = 1,
  DOWNLOAD_IN_PROGRESS = 2,
  STORING = 3,
}

// ── Parameter Object (0x0F) ──

export interface CipParamConfig {
  endpoint: string;
  paramInstance: string;
}

export interface ParameterDescriptor {
  instance: number;
  name: string;
  value: any;
  dataType: number;
  minValue?: any;
  maxValue?: any;
  defaultValue?: any;
  units?: string;
  description?: string;
  scalingMultiplier?: number;
  scalingDivisor?: number;
  scalingOffset?: number;
}

// ── Implicit I/O (Class 1 UDP) with Assembly Object 0x04 ──

export interface IOConnectionConfig {
  targetAddress: string;
  targetPort: number;
  rpi: number;               // Requested Packet Interval (microseconds)
  inputAssembly: number;
  outputAssembly: number;
  configAssembly: number;
  inputSize: number;         // bytes
  outputSize: number;
  connectionType: 'exclusive' | 'redundant' | 'listen_only';
  transportClass: number;    // 0 or 1
  connectionTimeoutMultiplier: number;
}

export enum IOConnectionState {
  IDLE = 0,
  ESTABLISHING = 1,
  ESTABLISHED = 2,
  TIMED_OUT = 3,
  DEFERRED_DELETE = 4,
  CLOSING = 5,
  ERROR = 6,
}
