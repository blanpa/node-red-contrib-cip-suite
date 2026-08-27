# Changelog

## 0.0.7 — 2026-08-27

### Fixed

- **cip-read** — **batch reads returned `null` for every tag.** `msg.tags` collects
  tags into a `TagGroup`, but the guard before the group read tested `group.size`,
  a property `TagGroup` does not have. `undefined > 0` is false, so the group was
  never read and every tag in it came back with a `null` value. It counts its
  members through `length`.
- **cip-read** — **an array of UDTs returned only element `[0]`.** A `Structure`
  needs `arrayDims > 0` to decode a multi-element response as one object per
  element; the read built it with `arrayDims = 0`, so `FIS_Stn` (an array of a
  UDT) decoded the whole response as a single element. (#4)
- **cip-read** — **a UDT read came back as a raw `Buffer` when the tag path's
  casing differed from the controller's.** st-ethernet-ip matches UDT member
  names case-sensitively when deciding whether to build a `Structure` (decodes to
  an object) or a plain `Tag` (hands back the struct bytes), so `fis_stn[0].local`
  yielded `buffer[832]` where `FIS_Stn[0].Local` yielded an object. Tag paths are
  now rewritten to the controller's own casing before any tag object is built,
  which is how Logix itself treats them. (#4)
- **cip-read** — **program-scoped reads always failed** with CIP status `0x05`.
  The path was sent with its `Program:<name>.` prefix *and* the program passed
  separately, so the program segment appeared twice in the request.
- **cip-io-scanner** — **a refused Forward_Open now names the reason.** The error
  reported only the general status, which for a refused I/O connection is almost
  always `0x01` "connection failure"; the extended status word — the part that
  says *which* parameter the target objected to — was dropped. Both are now
  reported, with the extended code spelled out (`0x0103` transport class/trigger,
  `0x012a`/`0x012b` invalid application path, `0x0106` ownership conflict, and the
  rest of the Connection Manager set). (#3)

### Changed

- **cip-read** — **array lengths are resolved in one request and cached.**
  Controller- and program-scoped array tags do not carry their length in the tag
  list, and st-ethernet-ip's `getTagArraySize()` recovers it by reading the tag
  with 1, 2, 3, … elements until the read is refused — one round trip per element,
  repeated on *every* read, so a polled 500-element array meant ~500 requests per
  poll. The length now comes from Symbol Object attribute 8 (array dimensions) in
  a single request, falls back to a bisecting index probe (~2·log₂n requests) if a
  controller does not answer that attribute, and is memoised until the connection
  is re-established.

### Added

- **Simulator** — UDT support, so the tag shapes from #4 can be reproduced without
  hardware: Template Object (class 0x6C) attributes and Read Template, a nested
  UDT (`FIS_Stn : FIS_STATION[5]` → `Local` → `FBFACTUAL : REAL[102]` and friends),
  structure and array reads that honour the requested element count, `0xFF`/`0x2105`
  for over-long requests, fragmented reads over the packet limit, and Symbol Object
  attribute 8.
- **Simulator** — corrected Logix behaviours that previously hid node bugs: array
  and structure flags in the tag list type word, `Program:<name>` program symbols
  in controller scope (which is how a client discovers program scopes), dotted
  multi-segment symbolic paths, and Read Tag Fragmented no longer being mistaken
  for Unconnected Send (both are service `0x52`).
- **Tests** — 34 more, including an end-to-end suite that drives the real
  `cip-read` node against the simulator over the arrays, nested UDTs, ranges,
  program scopes and batch reads from #4, and a `cip-io-scanner` case asserting a
  refused Forward_Open surfaces its extended status.

## 0.0.6 — 2026-08-26

### Changed

- **License changed from MIT to Apache-2.0.** Apache-2.0 is the license
  Node-RED itself uses. Compared to MIT it adds an explicit patent grant
  (section 3), keeps attribution intact downstream through the new `NOTICE`
  file (section 4d), and requires modified files to be marked as changed
  (section 4b). It remains fully permissive: commercial use, closed-source
  derivatives and forks are all still allowed.
- **`NOTICE` added** and verified to ship inside the npm tarball.
- **Contributing and fork guidance in the README.** Pull requests are welcome,
  including large ones — an issue up front means substantial work can usually
  land here instead of in a parallel package. Forks that are published under
  their own package name are asked to rename their Node-RED node type IDs and
  use their own palette category, so both packages can be installed side by
  side.

## 0.0.5 — 2026-07-10

### Fixed
- **cip-read** — Arrays and UDT/STRUCT tags no longer return only their first
  element. **Auto-detect** now consults the PLC tag list to recognise a tag (or a
  nested UDT member) as an array and reads the full array, and to recognise a
  structure and decode it into an object — previously these fell through to a scalar
  read that returned only element `[0]`. Explicit `ARRAY`/`STRUCT` selection and
  `msg.arraySize` continue to force the respective read. (#4)

### Added
- **cip-read** — `STRUCT` option in the **Data Type** dropdown to force UDT decoding,
  and `msg.arraySize` to override the array length for a read.
- Program-scoped array and struct reads (`Program:MainProgram.MyStruct.Member`) and
  nested-member array ranges (`MyStruct.Member[0..101]`).
- Tag-list helpers `parseProgramScope()` and `resolveMemberInfo()` (array length and
  nested-struct resolution) with unit tests.

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
