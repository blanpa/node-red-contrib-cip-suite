# Changelog

## 0.0.4 — 2026-06-26

### Fixed
- **cip-io-scanner** — Correct the Forward_Open framing so the I/O connection is
  accepted by strict drive firmware (PowerFlex 525), which rejected the previous
  framing with CIP general status `0x01` (Connection Failure):
  - **Transport Type/Trigger** is now `0x81` (Direction=Server, Class 1) instead of
    `0x01`. The target produces on T→O, so it is the server end — the direction bit
    must be set, or strict targets reply `0x01` / extended `0x0103` ("Transport Class
    and Trigger combination not supported").
  - The produced/consumed **Output and Input assemblies** are now addressed with
    **Connection Point** segments (`0x2C`) instead of plain Instance segments (`0x24`).
    Logix targets tolerate `0x24`; the PF525 does not. (The Config assembly still uses
    an Instance segment, matching a verified working PLC→PF525 capture.)

### Added
- **cip-io-scanner** — Optional **Electronic keying**. Off by default (no key segment =
  "don't check identity", the most compatible choice). When enabled, the connection path
  carries an Electronic Key built from configurable Vendor ID / Device Type / Product Code /
  Major+Minor revision, with a compatibility-bit option. (#3)

### Changed
- README and node help now document the PowerFlex 525 with its **native** assembly
  instances (Output 2 / Input 1 / Config 6), verified against a working capture, instead
  of the generic ODVA AC-drive assemblies (20/70).

## 0.0.3 — 2026-06-23

### Fixed
- **cip-io-scanner** — Remove a stray pad byte after the Connection Path Size field in
  Forward_Open. The extra `0x00` shifted the whole connection path one octet and left a
  trailing byte, which targets reject as CIP general status `0x15` ("too much data") — so
  the I/O connection failed identically regardless of assembly, size, RPI, or Run/Idle
  setting. The connection path now follows the size field immediately, per spec. (#3)

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
