# Changelog

## 0.1.0 — 2026-09-04

Thanks to [@Steve-Mcl](https://github.com/Steve-Mcl) (Node-RED core maintainer), whose
work is most of this release: [#11](https://github.com/blanpa/node-red-contrib-cip-suite/pull/11),
[#12](https://github.com/blanpa/node-red-contrib-cip-suite/pull/12) and
[#13](https://github.com/blanpa/node-red-contrib-cip-suite/pull/13).

### Added

- **Dynamic connection control — a node can select, connect and cycle its endpoint at
  runtime.** Until now a `cip-endpoint` was bound to each node at deploy time and could not
  be re-pointed while a flow ran, so a generic flow could not pick its PLC from a
  production/staging config. Every node that does request and response work against an
  endpoint (`cip-read`, `cip-write`, `cip-browse`, `cip-raw`, `cip-controller`,
  `cip-subscribe`) now accepts `msg.action` and `msg.endpoint`, following the pattern the
  core MQTT nodes use. A message carrying `msg.action` performs that action and does **no**
  PLC I/O, so a `cip-write` given an action does not write.

  | action | effect | moves the node |
  | --- | --- | --- |
  | `switch` | Re-points the receiving node at another endpoint. | yes |
  | `connect` | Connects. Already connected with no override is a no-op success. | yes |
  | `reconnect` | Forces a disconnect then connect, and refreshes the tag list. | yes |
  | `disconnect` | Disconnects and stops retrying until told otherwise. | no |
  | `status` | Emits connection state and metrics, naming the endpoint that answered. | no |
  | *(none)* | The node's normal read or write, against the named endpoint if there is one. | no |

  `msg.endpoint` is either the id or the configured **Name** of a deployed `cip-endpoint`,
  or an object with `target: "config"` that changes that endpoint's settings in place. A
  bare reference **borrows** the endpoint for that one message and leaves the node where it
  was, which is what makes *read this tag from PLC2* a single message; `switch` is how a
  node is moved for good. A borrowed endpoint is connected on demand, so the one-message
  form works with **Auto connect** off. (#10, #12)

- **Opt-in per endpoint through a `Dynamic Control` checkbox, off by default.** While it is
  off, `msg.action` and `msg.endpoint` are ignored entirely and the message falls through to
  the node's normal path, so upgrading cannot change how an existing flow behaves. The gate
  sits on the config node so one checkbox covers every node using that connection, it cannot
  be set by a runtime override, and both ends of a `switch` have to opt in — otherwise a node
  could be moved onto a locked endpoint and stranded there. (#12)

- **cip-subscribe — the `start`, `stop` and `restart` actions its help has always documented
  are now implemented.** `msg.command` is kept as a deprecated alias. Switching a subscribe
  node rebuilds its `TagGroup`, which is built against one controller's tag list and cannot
  be carried across. (#12)

- **cip-endpoint — `Auto connect`, `Keepalive (ms)` and `Max retry (ms)` settings.** Auto
  connect off leaves the session idle until a message asks for it. Keepalive holds an
  otherwise idle session open: controllers close idle EtherNet/IP sessions, a Micro850 after
  exactly 120 seconds. (#12)

- **Output messages carry `msg.endpoint`, naming the PLC that answered**, so a flow can route
  on it and piping a read into a write keeps both halves on the same controller. Only
  endpoints allowing dynamic updates are stamped, so the output of existing flows is
  unchanged. (#12)

- **`getStatus()` on the endpoint**, returning connection state, metrics and the live
  address/slot/mode. It backs both `msg.action = "status"` and the metrics admin route, so
  the two cannot drift. (#12)

- **114 more unit tests**, taking the suite from 145 to 259 across 10 files. No sockets, all
  fakes: endpoint resolution and the full action decision table, the borrow-versus-re-point
  rule, the connection lifecycle, and tag names and program scope as they go on the wire.
  (#12)

### Changed

- **Reconnect now backs off exponentially with jitter**, from `Retry (ms)` up to
  `Max retry (ms)`, instead of retrying at a flat interval forever. The jitter stops a rack of
  nodes pointed at one PLC from retrying in lockstep after a shared outage. Set the two equal
  to restore a flat cadence. (#11)

- **Keepalive defaults to 30 s, including for endpoints that already exist.** After upgrading,
  every connection sends a Get_Attribute_Single on the Identity object every 30 seconds — the
  cheapest request every CIP device is required to answer. Set **Keepalive** to `0` to disable
  it. (#12)

- **Node statuses name the endpoint they are reporting on** (`connected: PLC2`). When several
  nodes share an endpoint and only some can re-point themselves, an unlabelled "connected"
  gives no way to tell which PLC a given node means. Nodes also report their endpoint's real
  state at construction, so an endpoint with Auto connect off no longer shows the previous
  run's status after a restart. (#12)

- **A failed connect reports what the controller actually said.** st-ethernet-ip rejects with
  a bare object such as `{ generalStatusCode: 1, extendedStatus: [273] }`, so reading
  `.message` off it yielded `undefined` and the cause was lost. Errors are now rendered with
  their CIP status text, and a Logix connect refused with status `0x01` suggests enabling
  Micro800 mode — which is exactly what that refusal usually means. (#11)

### Fixed

- **A dropped connection was never detected.** Nothing watched the socket after a successful
  connect, so a PLC that went off the network left the endpoint reporting `connected` forever
  and no retry was ever scheduled — a silent total failure, with every node still showing
  green. Verified against the previous release: after the controller disappeared, the endpoint
  stayed connected indefinitely; it is now detected within ~250 ms and reconnects about a
  second after the PLC returns. (#11)

- **`connect()` resolved before the TCP connect settled**, so a caller could not report the
  real outcome. The callback now fires when the attempt actually settles; concurrent callers
  join one attempt and all settle together, each callback running at most once. (#11)

- **A superseded connect attempt tore down the attempt that replaced it**, which a forced
  reconnect triggered every time. Every attempt now carries a generation and a late callback
  from an abandoned one bows out. (#11)

- **Failed and superseded attempts leaked the socket and a registered session on the
  controller.** Controllers with a small session table — Micro800 especially — then start
  refusing new connections until the sessions age out. (#11)

- **An explicit disconnect left user nodes on a stale green status**, because it never
  broadcast `cip:disconnected`. (#11)

- **The connect watchdog wedged the endpoint instead of releasing it.** It settled the waiting
  callbacks but left `connecting` set, and every later `connect()` joins an in-flight attempt
  and returns without arming a watchdog of its own — so after one connect that never settled,
  no callback fired again and no message against that endpoint could complete. It now retires
  the attempt. Its budget was also too tight to be destructive safely: `Controller.connect()`
  calls `ENIP.connect()` without a timeout argument, so the TCP connect and session
  registration ignore `timeout_sp` and fall back to the library's hardcoded 10 s, while the
  old budget expired at exactly 10.0 s on default settings.

- **`Dynamic Control` did not fail closed.** The flag was coerced through a helper that reads
  every value which is not `false` as `true`, so an `allowDynamic` left `null`, empty or `0`
  in a hand-edited flow unlocked runtime control of the connection. Only an explicit `true`,
  or the string form a checkbox can serialise to, opts in.

- **A tag picked from the browse list carried its data type into the Tag Name field** —
  `Counter  (DINT)` rather than `Counter` — and a read of that literal name failed. The
  options were built without a `value`, so they fell back to their label text. The handlers
  were also bound to `document` rather than to the node's edit dialog, and every node's HTML
  is loaded into the editor at once, so one click fired a browse request per node type and
  whichever response arrived last owned the list. There is now one shared implementation,
  bound to the open dialog. (#13)

### Security

- **The admin HTTP routes now require permission.** `GET /cip-endpoint/:id/browse` and
  `GET /cip-endpoint/:id/metrics` were registered without a guard, so on a Node-RED instance
  with `adminAuth` configured they were reachable without it — the browse route lists every
  tag in the controller. Both now go through `RED.auth.needsPermission("cip-endpoint.read")`.
  Instances without `adminAuth` are unaffected. (#11)

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
