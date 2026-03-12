# node-red-contrib-cip-suite

Comprehensive Node-RED nodes for Allen-Bradley and CIP-capable devices via EtherNet/IP. Covers the full spectrum from modern ControlLogix to legacy SLC500/PLC-5, plus advanced CIP objects for motion, energy, time sync, security, and more.

## Supported Hardware

| Platform | Protocol | Notes |
|----------|----------|-------|
| **ControlLogix** (L6x, L7x, L8x) | CIP Symbolic | Slot-based backplane routing |
| **CompactLogix** (L1x, L2x, L3x) | CIP Symbolic | Typically slot 0 |
| **Micro800** (Micro820/850/870) | CIP Symbolic | No backplane — enable Micro800 mode |
| **SLC 500** | PCCC over CIP | File-based addressing (N7:0, F8:0) |
| **MicroLogix** (1100/1400) | PCCC over CIP | File-based addressing |
| **PLC-5** | PCCC over CIP | File-based addressing |
| **Third-party CIP devices** | CIP Raw | Any EtherNet/IP device with CIP objects |

## Installation

```bash
cd ~/.node-red
npm install node-red-contrib-cip-suite
```

Or search for **node-red-contrib-cip-suite** in the Node-RED Palette Manager.

## Node Overview

All nodes appear under the **CIP Suite** category with a grey CIP icon.

### Core CIP Nodes

| Node | Type | Description |
|------|------|-------------|
| **cip-endpoint** | Config | Shared TCP session to a Logix PLC. Auto-reconnect, Micro800 support, multi-hop routing. |
| **cip-read** | In/Out | Read tag values. Supports bit access (`Tag.5`), array elements (`Tag[3]`), array ranges (`Tag[0..9]`), UDT/structures, batch reads, and polling. |
| **cip-write** | In/Out | Write tag values. Supports bit-level writes (atomic via CIP 0x4E or software RMW), arrays, UDT partial merge, batch writes. |
| **cip-browse** | In/Out | Discover tags on the PLC. Glob/regex filtering, UDT detection, program-scoped tags. |
| **cip-subscribe** | Out | Continuous cyclic multi-tag scanning via `readTagGroup()`. Deadband filtering, report-by-exception, runtime reconfiguration. |
| **cip-controller** | In/Out | Read controller identity, mode, fault status, keyswitch, tag count. Runtime commands: run/program/test/reset. |
| **cip-raw** | In/Out | Send raw CIP service requests. Supports Multiple Service Packet (0x0A). Full response parsing with human-readable status codes. |
| **cip-discover** | In/Out | UDP broadcast ListIdentity for network device discovery. Standalone — no endpoint required. |

### Legacy PCCC Nodes (SLC500 / MicroLogix / PLC-5)

| Node | Type | Description |
|------|------|-------------|
| **cip-pccc-endpoint** | Config | Raw TCP session with EtherNet/IP + PCCC encapsulation. Transaction-based request/response matching. |
| **cip-pccc-read** | In/Out | Read PCCC addresses: `N7:0`, `F8:0`, `B3:0/5`, `T4:0.ACC`, `S:1/5`. Multi-element reads, polling. |
| **cip-pccc-write** | In/Out | Write PCCC addresses with bit-level read-modify-write support. |

### Advanced CIP Object Nodes

| Node | CIP Class | Description |
|------|-----------|-------------|
| **cip-io-scanner** | Class 1 | Implicit I/O via ForwardOpen + UDP. Cyclic data exchange with remote I/O, drives, servos. |
| **cip-security** | 0x5D | CIP Security Object — TLS/DTLS status and security profile reading. |
| **cip-sync** | 0x43 | IEEE 1588 PTP time synchronization — grandmaster discovery, offset monitoring, PTP enable/disable. |
| **cip-motion** | 0x42 | Motion Axis Object — jog, moveAbsolute/Relative, home, stop, enable/disable, gear ratio, axis status polling. |
| **cip-energy** | 0x4F/0x4E | Energy Object — power/energy monitoring, electrical measurements (V/A/Hz/PF/THD), energy mode control. |
| **cip-file** | 0x37 | File Object — firmware upload/download with fragmented transfer, file directory listing, metadata access. |
| **cip-param** | 0x0F | Parameter Object — device parameterization, discovery scan, read/write with scaling support. |

## Tag Addressing

### CIP Symbolic (Logix)

| Format | Example | Description |
|--------|---------|-------------|
| Simple | `MyTag` | Read/write a tag |
| Bit access | `MyDint.5` | Read/write bit 5 of a DINT |
| Array element | `MyArray[3]` | Single array element |
| Array range | `MyArray[0..9]` | Read elements 0-9 via fragmented read |
| Program-scoped | `Program:MainProgram.MyTag` | Tag inside a program |
| Batch | `msg.tags = ["Tag1","Tag2"]` | Multi-tag read via TagGroup |

### PCCC (SLC/MLX/PLC-5)

| Format | Example | Description |
|--------|---------|-------------|
| Integer | `N7:0` | Integer file 7, element 0 |
| Float | `F8:5` | Float file 8, element 5 |
| Bit | `B3:0/5` | Bit file 3, element 0, bit 5 |
| Timer | `T4:0` | Full timer (CTL/PRE/ACC) |
| Timer sub-element | `T4:0.ACC` | Timer accumulator only |
| Counter | `C5:0.ACC` | Counter accumulator |
| Output/Input | `O:0/3`, `I:1/0` | I/O with bit access |
| Status | `S:1/5` | Status file with bit |
| String | `ST9:0` | String file |
| Long | `L10:0` | Long integer file |

## Configuration

### cip-endpoint

| Setting | Default | Description |
|---------|---------|-------------|
| IP Address | — | PLC IP address |
| Port | 44818 | EtherNet/IP port |
| Slot | 0 | Backplane slot (ControlLogix) |
| Timeout (ms) | 5000 | Connection timeout |
| Retry (ms) | 5000 | Reconnection interval |
| Micro800 | off | Enable for Micro800 (skips ForwardOpen, uses UCMM) |
| Routing Path | — | Multi-hop routing (e.g. `1/0/2/192.168.1.1`) |

### cip-pccc-endpoint

| Setting | Default | Description |
|---------|---------|-------------|
| IP Address | — | PLC IP address |
| Port | 44818 | EtherNet/IP port |
| Timeout (ms) | 5000 | Connection/request timeout |
| Retry (ms) | 5000 | Reconnection interval |

## Features

### Connection Management
- **Auto-reconnect** with configurable retry interval
- **Connection metrics** — response times, error counts, uptime tracking
- **Micro800 mode** — bypasses UnconnectedSend, uses direct UCMM messaging
- **Multi-hop routing** — reach PLCs behind ControlLogix backplanes

### Backpressure Protection
All nodes skip subsequent requests while a previous one is in-flight, preventing PLC overload.

### Atomic Bit Operations
Write nodes support CIP Read-Modify-Write service (0x4E) for safe bit manipulation without race conditions.

### Admin HTTP Endpoints
- `GET /cip-endpoint/:id/browse` — browse tags from a deployed endpoint
- `GET /cip-endpoint/:id/metrics` — connection statistics (response times, error counts, uptime)

### Status Indicators

| Color | Shape | Meaning |
|-------|-------|---------|
| Green | dot | Connected / OK |
| Yellow | ring | Connecting / warning |
| Red | ring | Error / disconnected |
| Blue | dot | Operation in progress |

## Docker Simulation Environment

A multi-profile PLC simulator is included for development and testing.

```bash
docker compose up -d
```

### Services

| Container | Description | Port |
|-----------|-------------|------|
| `plc-clx` | ControlLogix simulator | 44818 |
| `plc-cplx` | CompactLogix simulator | 44819 |
| `plc-micro` | Micro800 simulator | 44820 |
| `plc-mlx` | MicroLogix simulator (PCCC) | 44821 |
| `plc-plc5` | PLC-5 simulator (PCCC) | 44822 |
| `node-red` | Node-RED with pre-loaded test flows | 11880 |

### Simulator Profiles

Each profile provides a realistic tag set:

- **ControlLogix** — 10 tags (BOOL, INT, DINT, REAL, STRING, program-scoped)
- **CompactLogix** — Same as CLX
- **Micro800** — 24 I/O tags (10 DO + 14 DI, all BOOL)
- **MicroLogix** — PCCC registers (N7, F8, B3, T4, C5, S)
- **PLC-5** — PCCC registers

### Simulated CIP Services

| Service | Code | Description |
|---------|------|-------------|
| RegisterSession | 0x0065 | Session establishment |
| ForwardOpen/Close | 0x54/0x4E | Connected messaging |
| ReadTag | 0x4C | Read tag values |
| WriteTag | 0x4D | Write tag values |
| GetInstanceAttributeList | 0x55 | Tag browsing |
| GetAttributeAll | 0x01 | Controller identity |
| GetAttributeSingle | 0x0E | Single attribute read |
| ExecutePCCC | 0x4B | PCCC over CIP |
| MultipleServicePacket | 0x0A | Batch operations |

### Quick Start

```bash
# Start everything
docker compose up -d

# Open Node-RED
open http://localhost:11880

# View simulator logs
docker compose logs -f plc-clx

# Stop
docker compose down
```

## Example Flows

Pre-built flows are included in `examples/`:

- **basic-read-write.json** — Simple read/write operations
- **full-test-flow.json** — 6 tabs covering all simulators and node types

Import via Node-RED: Menu > Import > select file.

## Testing

```bash
npm test
```

Tests cover:
- Tag name parsing (bit, array, range, program-scoped)
- Bit manipulation (getBit, setBit, buildBitMasks)
- CIP status/type name resolution
- PCCC address parsing (all file types, sub-elements, bit access)
- PCCC command building and response parsing
- CIP path building (8-bit/16-bit segments, attributeId edge cases)

## API Reference

### cip-read Output

```json
{
  "payload": "<tag value>",
  "tagName": "MyDint",
  "dataType": "DINT",
  "timestamp": 1710000000000
}
```

### cip-write Input

```json
{
  "payload": 42,
  "tagName": "MyDint"
}
```

### cip-subscribe Output

Single tag:
```json
{
  "payload": 42,
  "tagName": "MyDint",
  "dataType": "DINT",
  "changed": true,
  "scanRate": 1000,
  "timestamp": 1710000000000
}
```

Multi-tag:
```json
{
  "payload": { "Tag1": 42, "Tag2": 3.14 },
  "tags": [
    { "name": "Tag1", "value": 42, "type": "DINT", "changed": true },
    { "name": "Tag2", "value": 3.14, "type": "REAL", "changed": false }
  ],
  "scanRate": 1000,
  "timestamp": 1710000000000
}
```

### cip-raw Input

```json
{
  "service": 14,
  "classId": 1,
  "instanceId": 1,
  "attributeId": 1,
  "data": null
}
```

Multiple Service Packet:
```json
{
  "requests": [
    { "service": 14, "classId": 1, "instanceId": 1, "attributeId": 1 },
    { "service": 14, "classId": 1, "instanceId": 1, "attributeId": 7 }
  ]
}
```

### cip-pccc-read Output

```json
{
  "payload": 1234,
  "address": "N7:0",
  "fileType": "Integer",
  "timestamp": 1710000000000
}
```

## Dependencies

- [st-ethernet-ip](https://www.npmjs.com/package/st-ethernet-ip) ^2.7.5 — EtherNet/IP protocol driver

## Requirements

- Node.js >= 16.0.0
- Node-RED >= 2.0.0

## License

MIT
