# Changelog

## 0.0.2 — 2026-06-22

### Fixed
- **cip-io-scanner** — Add the 32-bit Run/Idle header to O→T (output) cyclic data.
  ODVA AC/DC drive-profile devices (PowerFlex 525 etc.) stayed in Idle and ignored
  the output assembly without it, so implicit control never took effect. The header
  is on by default (configurable), its 4 bytes are added to the negotiated O→T
  connection size, and Run/Idle can be commanded at runtime via
  `msg.command:"run"`/`"idle"` or `msg.run:true`/`false`. (#3)

## 0.0.1 — Initial Release

### Nodes

#### Core CIP (Logix)
- **cip-endpoint** — Shared TCP session with auto-reconnect, Micro800 support, multi-hop routing, connection metrics
- **cip-read** — Tag reads with bit access, array elements/ranges, UDT/structure support, batch mode, polling
- **cip-write** — Tag writes with atomic bit operations (CIP 0x4E), array writes, UDT partial merge, batch mode
- **cip-browse** — Tag discovery with glob/regex filtering, UDT detection, program-scoped tags
- **cip-subscribe** — Continuous cyclic multi-tag scanning via TagGroup, deadband filtering, report-by-exception
- **cip-controller** — Controller identity/status/mode reading, runtime commands (run/program/test/reset)
- **cip-raw** — Raw CIP service requests, Multiple Service Packet (0x0A), full response parsing
- **cip-discover** — UDP ListIdentity broadcast for network device discovery

#### Legacy PCCC (SLC500 / MicroLogix / PLC-5)
- **cip-pccc-endpoint** — Raw TCP with EtherNet/IP + PCCC encapsulation, TNS-based request matching
- **cip-pccc-read** — PCCC address reads (N, F, B, T, C, R, S, O, I, ST, L), multi-element, polling
- **cip-pccc-write** — PCCC address writes with bit-level read-modify-write

#### Advanced CIP Objects
- **cip-io-scanner** — Class 1 implicit I/O via ForwardOpen + UDP cyclic messaging
- **cip-security** — CIP Security Object (class 0x5D) status reading
- **cip-sync** — IEEE 1588 PTP time synchronization (class 0x43)
- **cip-motion** — Motion Axis Object (class 0x42) commands and status
- **cip-energy** — Energy Object (class 0x4F/0x4E) power monitoring and mode control
- **cip-file** — File Object (class 0x37) firmware upload/download
- **cip-param** — Parameter Object (class 0x0F) device parameterization

### Simulator
- Multi-profile Docker simulator (ControlLogix, CompactLogix, Micro800, MicroLogix, PLC-5)
- Pre-loaded Node-RED test flows covering all node types
- Supports CIP + PCCC protocols

### Test Suite
- 86 unit tests covering utils, PCCC parsing, CIP path building
