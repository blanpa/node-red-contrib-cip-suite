# node-red-contrib-cip-suite

[![Sponsor](https://img.shields.io/github/sponsors/blanpa?label=Sponsor&logo=githubsponsors&logoColor=white&color=EA4AAA)](https://github.com/sponsors/blanpa)

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
| Nested array range | `MyStruct.Member[0..101]` | Read a range of a UDT member array |
| UDT member | `MyUDT.MemberName` | Read/write a single structure member |
| Whole UDT/STRUCT | `MyUDT` | Full structure as an object (needs tag list) |
| Array of UDTs | `MyUDT` where `MyUDT : MyType[5]` | One object per element |
| Program-scoped | `Program:MainProgram.MyTag` | Tag inside a program |
| Batch | `msg.tags = ["Tag1","Tag2"]` | Multi-tag read via TagGroup |

Tag paths are matched **case-insensitively**, the way Logix itself treats them —
`fis_stn[0].local` and `FIS_Stn[0].Local` address the same tag and both decode into
an object.

On **cip-read**, the **Data Type** field controls decoding: `Auto-detect` returns
scalars natively and expands whole arrays and UDT/STRUCT tags when the endpoint's
tag list is available; `ARRAY` forces a full array read; `STRUCT` forces UDT
decoding. Auto-detect of full arrays and structures requires the tag list, which
ControlLogix/CompactLogix provide on connect.

**Array lengths** are resolved in this order, and memoised until the connection is
re-established, so a polled array costs one request per poll:

1. `msg.arraySize`, if you set it.
2. The UDT template, for a member array such as `MyStruct.Member` — the controller
   sends the element count with the tag list.
3. Symbol Object attribute 8 (array dimensions), for controller- and program-scoped
   array tags, whose length the tag list does not carry. One request, exact answer.
4. A bisecting index probe (~2·log2 n requests), if a controller does not answer
   attribute 8.

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
| Retry (ms) | 5000 | Reconnection interval, doubling up to Max retry |
| Max retry (ms) | 60000 | Backoff ceiling. Set equal to Retry for a flat interval |
| Keepalive (ms) | 30000 | Identity reads that hold an idle session open. `0` disables |
| Auto connect | on | Off leaves the session idle until a `connect` action arrives |
| Dynamic Control | off | Opt in to runtime control via `msg.action` / `msg.endpoint` |
| Micro800 | off | Enable for Micro800 (skips ForwardOpen, uses UCMM) |
| Routing Path | — | Multi-hop routing (e.g. `1/0/2/192.168.1.1`) |

> **Port** is informational. EtherNet/IP is always contacted on 44818.

### cip-pccc-endpoint

| Setting | Default | Description |
|---------|---------|-------------|
| IP Address | — | PLC IP address |
| Port | 44818 | EtherNet/IP port |
| Timeout (ms) | 5000 | Connection/request timeout |
| Retry (ms) | 5000 | Reconnection interval |

### cip-io-scanner

| Setting | Default | Description |
|---------|---------|-------------|
| Target IP | — | I/O adapter / drive IP address |
| Port | 44818 | EtherNet/IP port |
| RPI (ms) | 100 | Requested Packet Interval (cyclic rate) |
| Input/Output Assembly | 100 / 150 | Assembly instance numbers (see device EDS) |
| Config Assembly | 0 | Optional config assembly instance |
| Input/Output Size | 32 | Application data size in bytes (excl. Run/Idle header) |
| UDP Port | 2222 | Local UDP port for implicit I/O |
| 32-bit Run/Idle header | on | Prepend the Run/Idle header on O→T. Required by the ODVA AC/DC drive profile — leave **on** for PowerFlex drives, or they stay idle and ignore the output assembly |
| Electronic keying | off | Add an Electronic Key segment to the connection path. **Off = no key** ("don't check identity"), the most compatible choice. Enable only if a strict target rejects an unkeyed connection, then fill in Vendor ID / Device Type / Product Code / Major+Minor revision (from the device EDS). The compatibility bit accepts compatible revisions instead of an exact match |

The produced/consumed assemblies are addressed with **Connection Point** path segments and the connection is opened with the transport direction set to **Server** (`0x81`) — both required by stricter drive firmware such as the PowerFlex 525.

When a target refuses the connection, the node reports both status words, for example:

```
ForwardOpen refused by target: CIP status 0x01 (Connection failure),
extended 0x012a (Invalid Originator→Target application path)
```

The general status of a refused I/O connection is nearly always `0x01` "connection
failure" and says nothing useful — the **extended** status is the one that names the
parameter the target objected to. The common ones:

| Extended | Meaning | Usually means |
|----------|---------|---------------|
| `0x0103` | Transport class and trigger combination not supported | Target wants a different transport byte |
| `0x0106` | Ownership conflict | Another scanner (often a PLC) already owns the connection point |
| `0x0110` | Target application not configured for this connection | Wrong assembly instance, or the device needs configuring first |
| `0x0111` | RPI not supported | Requested RPI outside the device's range |
| `0x0114`–`0x0116` | Electronic key mismatch | Vendor / device type / revision in the key does not match |
| `0x0127` / `0x0128` | Invalid O→T / T→O connection size | Input or Output Size wrong — check whether the Run/Idle header's 4 bytes are counted |
| `0x012a` / `0x012b` | Invalid O→T / T→O application path | Wrong Output or Input assembly instance |

## Drive Control (PowerFlex 525)

A PowerFlex 525 is controlled with **implicit** (Class 1) messaging via `cip-io-scanner` — not with the tag nodes (it has no Logix tags). The drive's **native** assembly instances (verified against a working PLC→PF525 capture) are:

| Setting | Value |
|---------|-------|
| Output Assembly / Size | `2` / `4` (Logic Command word + Speed Reference word) |
| Input Assembly / Size | `1` / `8` (Logic Status word + Speed Feedback + datalinks) |
| Config Assembly | `6` |
| RPI | `100` ms (the PLC requests 0 and the drive negotiates ~98 ms) |
| 32-bit Run/Idle header | on |
| Electronic keying | off (enable only if the drive refuses the unkeyed connection) |

These native instances (Output 2 / Input 1 / Config 6) differ from the generic ODVA AC-drive assemblies (20/70). Send the 4 output bytes as a `Buffer` in `msg.payload` (bytes 0-1 = Logic Command, bytes 2-3 = Speed Reference, little-endian). Toggle the drive between Run and Idle with `msg.command:"run"`/`"idle"` (or `msg.run:true`/`false`).

Device **parameters** (read/write) use explicit messaging via `cip-param` (Parameter Object 0x0F), not `cip-write`. Confirm the exact assembly numbers, Logic Command bit map, and Speed Reference scaling against PowerFlex publication *520-UM001* — they differ between the ODVA AC-drive assemblies (20/70) and the PowerFlex-native ones.

## Features

### Connection Management
- **Drop detection** — an unexpected socket loss is noticed and retried, rather than leaving the endpoint reporting `connected` forever
- **Auto-reconnect** with exponential backoff and jitter, so a rack of nodes on one PLC does not retry in lockstep
- **Keepalive** — periodic Identity reads hold an idle session open (a Micro850 closes one after 120 s)
- **Connection metrics** — response times, error counts, uptime tracking
- **Micro800 mode** — bypasses UnconnectedSend, uses direct UCMM messaging
- **Multi-hop routing** — reach PLCs behind ControlLogix backplanes

### Dynamic Connection Control

Opt in per endpoint with the **Dynamic Control** checkbox, then `cip-read`, `cip-write`,
`cip-browse`, `cip-raw`, `cip-controller` and `cip-subscribe` accept `msg.action` and
`msg.endpoint`, following the pattern the core MQTT nodes use. While the checkbox is off,
both properties are ignored entirely, so existing flows are unaffected.

A message carrying `msg.action` performs that action and does **no** PLC I/O.

| `msg.action` | Effect | Re-points the node |
|---|---|---|
| `switch` | Re-points the receiving node at another endpoint | yes |
| `connect` | Connects. Already connected with no override is a no-op success | yes |
| `reconnect` | Forces a disconnect then connect, and refreshes the tag list | yes |
| `disconnect` | Disconnects and stops retrying until told otherwise | no |
| `status` | Emits connection state and metrics on the output | no |
| *(none)* | The node's normal read or write | no |

`msg.endpoint` is the id or the configured **Name** of a deployed `cip-endpoint`. A bare
reference **borrows** that endpoint for one message and leaves the node where it was; use
`switch` to move a node for good. `cip-subscribe` is the exception — it holds a scan loop
rather than answering one message at a time, so it requires `switch`.

```js
// Read a tag from a different PLC, this message only
msg = { endpoint: "PLC2", tagName: "Line1.Speed" };

// Move this node to another PLC for good
msg = { action: "switch", endpoint: "PLC2" };

// Report on PLC3 without moving
msg = { action: "status", endpoint: "PLC3" };

// Re-address the shared config node and reconnect (affects every node using it)
msg = { action: "connect", endpoint: { target: "config", address: "10.0.0.5", force: true } };
```

`switch` affects **one node**. A settings object with `target: "config"` changes the
**shared config node**, so it affects every node using that endpoint. Settings overrides
apply only to `connect`, since connecting is the only moment new settings take effect, and
are refused on a live connection unless you add `force: true`. Runtime changes are not
saved — a full deploy restores whatever is configured in the editor.

Output messages carry `msg.endpoint` naming the PLC that answered, so piping a read into a
write keeps both halves on the same controller.

### Backpressure Protection
All nodes skip subsequent requests while a previous one is in-flight, preventing PLC overload.

### Atomic Bit Operations
Write nodes support CIP Read-Modify-Write service (0x4E) for safe bit manipulation without race conditions.

### Admin HTTP Endpoints
- `GET /cip-endpoint/:id/browse` — browse tags from a deployed endpoint
- `GET /cip-endpoint/:id/metrics` — connection statistics (response times, error counts, uptime)

Both require the `cip-endpoint.read` permission where `adminAuth` is configured.

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
| `drive-powerflex525` | PowerFlex 525 drive — implicit Class 1 I/O | 44823 (TCP) + 2222 (UDP) |
| `node-red` | Node-RED with pre-loaded test flows | 11880 |

### Simulator Profiles

Each profile provides a realistic tag set:

- **ControlLogix** — scalars (BOOL, INT, DINT, REAL, LINT), arrays (`MyIntArray` INT[10], `MyRealArray` REAL[5]), program-scoped tags (`Program:MainProgram.Speed`, `Program:MainProgram.Recipe` INT[8]), and a nested UDT array `FIS_Stn : FIS_STATION[5]` whose `Local` member holds `FBCONTROL DINT[2]`, `FBFACTUAL REAL[102]`, `FBCOMPARE REAL[102]` and `FBRESULT DINT[2]` — 832 bytes per element, so struct reads exercise fragmentation
- **CompactLogix** — Same as CLX
- **Micro800** — 24 I/O tags (10 DO + 14 DI, all BOOL)
- **MicroLogix** — PCCC registers (N7, F8, B3, T4, C5, S)
- **PLC-5** — PCCC registers
- **PowerFlex 525** — no tags; implicit Class 1 I/O only (assemblies: Output 2 / Input 1 / Config 6). Models the drive's strict Forward_Open acceptance — the connection is granted only when the produced/consumed assemblies use Connection Point path segments and the transport is Server + Class 1

### Simulated CIP Services

| Service | Code | Description |
|---------|------|-------------|
| RegisterSession | 0x0065 | Session establishment |
| ForwardOpen/Close | 0x54/0x4E | Connected messaging |
| ReadTag | 0x4C | Read tag values — honours the requested element count, answers `0xFF`/`0x2105` past the end of a tag |
| ReadTagFragmented | 0x52 | Continues a read too large for one packet (structs, long arrays) |
| WriteTag | 0x4D | Write tag values |
| GetInstanceAttributeList | 0x55 | Tag browsing — type word carries the array and structure flags |
| GetAttributeAll | 0x01 | Controller identity |
| GetAttributeSingle | 0x0E | Single attribute read, incl. Symbol Object array dimensions (attr 8) |
| Template Object | 0x6C | UDT definitions — attributes and Read Template, so struct tags decode |
| ExecutePCCC | 0x4B | PCCC over CIP |
| MultipleServicePacket | 0x0A | Batch operations |
| Implicit I/O (Class 1) | — | Cyclic UDP assemblies for the PowerFlex 525 drive profile (ForwardOpen + UDP 2222) |

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
- Tag path canonicalisation against the controller's tag list and UDT templates
- Array length resolution (Symbol Object dimensions, bisecting index probe, caching)
- Bit manipulation (getBit, setBit, buildBitMasks)
- CIP status/type name resolution, including Connection Manager extended status
- PCCC address parsing (all file types, sub-elements, bit access)
- PCCC command building and response parsing
- CIP path building (8-bit/16-bit segments, attributeId edge cases)
- **Forward_Open framing** — strict PowerFlex 525 acceptance (transport byte, Connection Point vs Instance segments, electronic key parsing)
- **cip-read end-to-end** — the real node reads whole arrays, nested UDTs, arrays of UDTs, ranges, program-scoped tags and batches from the ControlLogix simulator, over fragmented responses
- **cip-io-scanner end-to-end** — the real node drives the PowerFlex 525 simulator over TCP ForwardOpen + cyclic UDP I/O, asserting the connection establishes, data flows both directions, and a refused connection surfaces its extended status

To exercise implicit I/O manually without Docker, run the drive simulator directly and point a `cip-io-scanner` node (Output 2 / Input 1 / Config 6, sizes 4 / 8, Run/Idle on) at `127.0.0.1:44818`:

```bash
npm run sim:pf525
```

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

Batch read (`msg.tags`) — `payload` is an array in the order requested, and a tag that
could not be read carries an `error` string instead of a value:

```json
{
  "payload": [
    { "tagName": "MyDint", "value": 42, "type": "DINT" },
    { "tagName": "MyIntArray", "value": [100, 200, 300], "type": "INT" },
    { "tagName": "Missing", "value": null, "type": "", "error": "..." }
  ],
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

## Sponsor this project

This package is developed and maintained in my own time.
If it saves you some, consider supporting it:

<a href="https://github.com/sponsors/blanpa">
  <img height="41" alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor%20on%20GitHub-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white">
</a>
<a href="https://buymeacoffee.com/blanpa">
  <img height="41" alt="Buy Me a Coffee" src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png">
</a>

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright 2026 blanpa

## Contributing and forks

Pull requests are welcome, including large ones. If you are planning a bigger
change — a dependency migration, a restructure, new nodes — please open an issue
first. We are happy to discuss it and to land substantial work here; that is
usually less effort than maintaining a parallel package, and it keeps a single
place for users to report bugs.

If you do publish a fork under its own package name, please also rename the
Node-RED node type IDs (for example `myprefix-cip-suite-*`) and use your own palette
category. Node-RED refuses to register a node type that is already claimed, so
identical type IDs make it impossible to install both packages side by side.

## Contributors

This package is better than it would have been alone. Thank you to everyone who has
contributed code, and to everyone who took the time to report a problem properly —
several releases exist because someone described a bug well enough to reproduce it.

| | Contribution |
|---|---|
| [@Steve-Mcl](https://github.com/Steve-Mcl) (Stephen McLaughlin) | Dynamic/runtime connection management ([#12](https://github.com/blanpa/node-red-contrib-cip-suite/pull/12), [#10](https://github.com/blanpa/node-red-contrib-cip-suite/issues/10)), the connection lifecycle rework that made a dropped PLC detectable at all ([#11](https://github.com/blanpa/node-red-contrib-cip-suite/pull/11)), and the tag browse fix ([#13](https://github.com/blanpa/node-red-contrib-cip-suite/pull/13)) |
| [@cgraun](https://github.com/cgraun) | Reported that arrays returned only their first element ([#4](https://github.com/blanpa/node-red-contrib-cip-suite/issues/4)), which uncovered the UDT array, tag casing and program scope bugs fixed in 0.0.7 |
| [@rmsems](https://github.com/rmsems) | Reported the PowerFlex 525 drive control gaps ([#3](https://github.com/blanpa/node-red-contrib-cip-suite/issues/3)), which led to the extended Forward_Open diagnostics and the drive simulator profile |

New contributors are welcome — see [Contributing and forks](#contributing-and-forks) above.
