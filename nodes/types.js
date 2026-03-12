"use strict";
/**
 * Shared type definitions for cip-suite.
 * Includes Node-RED runtime types and CIP/EtherNet/IP types.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IOConnectionState = exports.FileTransferState = exports.EnergyMode = exports.AxisState = exports.MotionCommand = exports.PCCCFileType = exports.CIP_STATUS = exports.CIPClass = exports.CIPService = exports.CIP_TYPE_NAMES = exports.CIPDataType = void 0;
// ── CIP Data Types ──
var CIPDataType;
(function (CIPDataType) {
    CIPDataType[CIPDataType["BOOL"] = 193] = "BOOL";
    CIPDataType[CIPDataType["SINT"] = 194] = "SINT";
    CIPDataType[CIPDataType["INT"] = 195] = "INT";
    CIPDataType[CIPDataType["DINT"] = 196] = "DINT";
    CIPDataType[CIPDataType["LINT"] = 197] = "LINT";
    CIPDataType[CIPDataType["USINT"] = 198] = "USINT";
    CIPDataType[CIPDataType["UINT"] = 199] = "UINT";
    CIPDataType[CIPDataType["UDINT"] = 200] = "UDINT";
    CIPDataType[CIPDataType["LREAL"] = 203] = "LREAL";
    CIPDataType[CIPDataType["REAL"] = 202] = "REAL";
    CIPDataType[CIPDataType["STRING"] = 208] = "STRING";
    CIPDataType[CIPDataType["SHORT_STRING"] = 218] = "SHORT_STRING";
    CIPDataType[CIPDataType["WORD"] = 209] = "WORD";
    CIPDataType[CIPDataType["DWORD"] = 210] = "DWORD";
    CIPDataType[CIPDataType["LWORD"] = 211] = "LWORD";
    CIPDataType[CIPDataType["STRUCT"] = 672] = "STRUCT";
})(CIPDataType || (exports.CIPDataType = CIPDataType = {}));
exports.CIP_TYPE_NAMES = {
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
var CIPService;
(function (CIPService) {
    CIPService[CIPService["GET_ATTRIBUTE_ALL"] = 1] = "GET_ATTRIBUTE_ALL";
    CIPService[CIPService["SET_ATTRIBUTE_ALL"] = 2] = "SET_ATTRIBUTE_ALL";
    CIPService[CIPService["GET_ATTRIBUTE_LIST"] = 3] = "GET_ATTRIBUTE_LIST";
    CIPService[CIPService["SET_ATTRIBUTE_LIST"] = 4] = "SET_ATTRIBUTE_LIST";
    CIPService[CIPService["RESET"] = 5] = "RESET";
    CIPService[CIPService["START"] = 6] = "START";
    CIPService[CIPService["STOP"] = 7] = "STOP";
    CIPService[CIPService["CREATE"] = 8] = "CREATE";
    CIPService[CIPService["DELETE"] = 9] = "DELETE";
    CIPService[CIPService["MULTIPLE_SERVICE_PACKET"] = 10] = "MULTIPLE_SERVICE_PACKET";
    CIPService[CIPService["APPLY_ATTRIBUTES"] = 13] = "APPLY_ATTRIBUTES";
    CIPService[CIPService["GET_ATTRIBUTE_SINGLE"] = 14] = "GET_ATTRIBUTE_SINGLE";
    CIPService[CIPService["SET_ATTRIBUTE_SINGLE"] = 16] = "SET_ATTRIBUTE_SINGLE";
    CIPService[CIPService["FIND_NEXT"] = 17] = "FIND_NEXT";
    CIPService[CIPService["READ_TAG"] = 76] = "READ_TAG";
    CIPService[CIPService["WRITE_TAG"] = 77] = "WRITE_TAG";
    CIPService[CIPService["READ_MODIFY_WRITE_TAG"] = 78] = "READ_MODIFY_WRITE_TAG";
    CIPService[CIPService["READ_TAG_FRAGMENTED"] = 82] = "READ_TAG_FRAGMENTED";
    CIPService[CIPService["WRITE_TAG_FRAGMENTED"] = 83] = "WRITE_TAG_FRAGMENTED";
    CIPService[CIPService["FORWARD_OPEN"] = 84] = "FORWARD_OPEN";
    CIPService[CIPService["GET_INSTANCE_ATTRIBUTE_LIST"] = 85] = "GET_INSTANCE_ATTRIBUTE_LIST";
    CIPService[CIPService["EXECUTE_PCCC"] = 75] = "EXECUTE_PCCC";
    CIPService[CIPService["FORWARD_CLOSE"] = 78] = "FORWARD_CLOSE";
    CIPService[CIPService["GET_FILE_DATA"] = 79] = "GET_FILE_DATA";
    CIPService[CIPService["INITIATE_UPLOAD"] = 75] = "INITIATE_UPLOAD";
    CIPService[CIPService["LARGE_FORWARD_OPEN"] = 91] = "LARGE_FORWARD_OPEN";
})(CIPService || (exports.CIPService = CIPService = {}));
// ── CIP Object Classes ──
var CIPClass;
(function (CIPClass) {
    CIPClass[CIPClass["IDENTITY"] = 1] = "IDENTITY";
    CIPClass[CIPClass["MESSAGE_ROUTER"] = 2] = "MESSAGE_ROUTER";
    CIPClass[CIPClass["ASSEMBLY"] = 4] = "ASSEMBLY";
    CIPClass[CIPClass["CONNECTION_MANAGER"] = 6] = "CONNECTION_MANAGER";
    CIPClass[CIPClass["REGISTER"] = 7] = "REGISTER";
    CIPClass[CIPClass["PARAMETER"] = 15] = "PARAMETER";
    CIPClass[CIPClass["PORT"] = 244] = "PORT";
    CIPClass[CIPClass["TCP_IP"] = 245] = "TCP_IP";
    CIPClass[CIPClass["ETHERNET_LINK"] = 246] = "ETHERNET_LINK";
    CIPClass[CIPClass["FILE"] = 55] = "FILE";
    CIPClass[CIPClass["MOTION_GROUP"] = 65] = "MOTION_GROUP";
    CIPClass[CIPClass["MOTION_AXIS"] = 66] = "MOTION_AXIS";
    CIPClass[CIPClass["TIME_SYNC"] = 67] = "TIME_SYNC";
    CIPClass[CIPClass["ENERGY"] = 79] = "ENERGY";
    CIPClass[CIPClass["CIP_SECURITY"] = 93] = "CIP_SECURITY";
    CIPClass[CIPClass["PCCC"] = 103] = "PCCC";
    CIPClass[CIPClass["SYMBOL"] = 107] = "SYMBOL";
    CIPClass[CIPClass["TEMPLATE"] = 108] = "TEMPLATE";
    CIPClass[CIPClass["CONNECTION_CONFIG"] = 243] = "CONNECTION_CONFIG";
})(CIPClass || (exports.CIPClass = CIPClass = {}));
// ── CIP Status Codes ──
exports.CIP_STATUS = {
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
// ── PCCC types ──
var PCCCFileType;
(function (PCCCFileType) {
    PCCCFileType[PCCCFileType["OUTPUT"] = 130] = "OUTPUT";
    PCCCFileType[PCCCFileType["INPUT"] = 131] = "INPUT";
    PCCCFileType[PCCCFileType["STATUS"] = 133] = "STATUS";
    PCCCFileType[PCCCFileType["BIT"] = 134] = "BIT";
    PCCCFileType[PCCCFileType["TIMER"] = 135] = "TIMER";
    PCCCFileType[PCCCFileType["COUNTER"] = 136] = "COUNTER";
    PCCCFileType[PCCCFileType["CONTROL"] = 137] = "CONTROL";
    PCCCFileType[PCCCFileType["INTEGER"] = 138] = "INTEGER";
    PCCCFileType[PCCCFileType["FLOAT"] = 139] = "FLOAT";
    PCCCFileType[PCCCFileType["MSD"] = 140] = "MSD";
    PCCCFileType[PCCCFileType["STRING"] = 141] = "STRING";
    PCCCFileType[PCCCFileType["ASCII"] = 142] = "ASCII";
    PCCCFileType[PCCCFileType["BCD"] = 143] = "BCD";
    PCCCFileType[PCCCFileType["LONG"] = 145] = "LONG";
})(PCCCFileType || (exports.PCCCFileType = PCCCFileType = {}));
var MotionCommand;
(function (MotionCommand) {
    MotionCommand[MotionCommand["JOG"] = 1] = "JOG";
    MotionCommand[MotionCommand["MOVE_ABSOLUTE"] = 2] = "MOVE_ABSOLUTE";
    MotionCommand[MotionCommand["MOVE_RELATIVE"] = 3] = "MOVE_RELATIVE";
    MotionCommand[MotionCommand["HOME"] = 4] = "HOME";
    MotionCommand[MotionCommand["STOP"] = 5] = "STOP";
    MotionCommand[MotionCommand["CHANGE_SPEED"] = 6] = "CHANGE_SPEED";
    MotionCommand[MotionCommand["GEAR"] = 7] = "GEAR";
    MotionCommand[MotionCommand["CHANGE_DECEL"] = 8] = "CHANGE_DECEL";
})(MotionCommand || (exports.MotionCommand = MotionCommand = {}));
var AxisState;
(function (AxisState) {
    AxisState[AxisState["IDLE"] = 0] = "IDLE";
    AxisState[AxisState["STANDSTILL"] = 1] = "STANDSTILL";
    AxisState[AxisState["HOMING"] = 2] = "HOMING";
    AxisState[AxisState["DISCRETE_MOTION"] = 3] = "DISCRETE_MOTION";
    AxisState[AxisState["CONTINUOUS_MOTION"] = 4] = "CONTINUOUS_MOTION";
    AxisState[AxisState["SYNCHRONIZED_MOTION"] = 5] = "SYNCHRONIZED_MOTION";
    AxisState[AxisState["STOPPING"] = 6] = "STOPPING";
    AxisState[AxisState["ERROR_STOP"] = 7] = "ERROR_STOP";
})(AxisState || (exports.AxisState = AxisState = {}));
var EnergyMode;
(function (EnergyMode) {
    EnergyMode[EnergyMode["NORMAL"] = 0] = "NORMAL";
    EnergyMode[EnergyMode["ENERGY_SAVING"] = 1] = "ENERGY_SAVING";
    EnergyMode[EnergyMode["ENERGY_OFF"] = 2] = "ENERGY_OFF";
    EnergyMode[EnergyMode["PAUSED"] = 3] = "PAUSED";
})(EnergyMode || (exports.EnergyMode = EnergyMode = {}));
var FileTransferState;
(function (FileTransferState) {
    FileTransferState[FileTransferState["IDLE"] = 0] = "IDLE";
    FileTransferState[FileTransferState["UPLOAD_IN_PROGRESS"] = 1] = "UPLOAD_IN_PROGRESS";
    FileTransferState[FileTransferState["DOWNLOAD_IN_PROGRESS"] = 2] = "DOWNLOAD_IN_PROGRESS";
    FileTransferState[FileTransferState["STORING"] = 3] = "STORING";
})(FileTransferState || (exports.FileTransferState = FileTransferState = {}));
var IOConnectionState;
(function (IOConnectionState) {
    IOConnectionState[IOConnectionState["IDLE"] = 0] = "IDLE";
    IOConnectionState[IOConnectionState["ESTABLISHING"] = 1] = "ESTABLISHING";
    IOConnectionState[IOConnectionState["ESTABLISHED"] = 2] = "ESTABLISHED";
    IOConnectionState[IOConnectionState["TIMED_OUT"] = 3] = "TIMED_OUT";
    IOConnectionState[IOConnectionState["DEFERRED_DELETE"] = 4] = "DEFERRED_DELETE";
    IOConnectionState[IOConnectionState["CLOSING"] = 5] = "CLOSING";
    IOConnectionState[IOConnectionState["ERROR"] = 6] = "ERROR";
})(IOConnectionState || (exports.IOConnectionState = IOConnectionState = {}));
//# sourceMappingURL=types.js.map