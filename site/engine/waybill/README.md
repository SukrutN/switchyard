# waybill

The integration half of the switchyard family — sheet 03's adapters,
riding the lanes the way a spur client does. Sheet 02's `despatch-wes`
listens on `orders` for a work system's own row shape; this module is
the **customs desk**: merchant EDI comes in as X12 warehouse documents
and leaves as journal bytes on exactly those lanes. A 940 lands on
`orders` where despatch-wes is already waiting; a refused document
lands on the DLQ with a reason code; the outbound paperwork (945
advice, 856 ship notice) mints from the canonical spine with its
envelope numbers paced over journaled KV.

Hand-rolled TypeScript, zero runtime dependencies.

**The honest caveat, up front:** the open-source X12 ecosystem is
healthcare-skewed (pyx12, LinuxForHealth/x12, TigerShark all map
HIPAA sets). Nobody ships 940/945 warehouse mapping out of the box —
writing the supply-chain mapping *is this artifact*, and it lives in
plain data files any EDI-literate reviewer can read.

---

## Quick view

```ts
import { receive } from "./src/inbound.ts";          // the adapter door
import { produceAdvice, produceNotice } from "./src/outbound.ts";
import { routeOfSender, ALDERLINE } from "./src/partners.ts";

// a partner's 940 arrives as bytes; the door routes by ISA06
const out = receive({ name: "AHL-940-0001", bytes });
out.orders;      // canonical orders — publish to `orders`
out.refusals;    // refusals with reason codes — publish to `waybill-dead`

// a shipment finished picking; the paperwork answers
const doc = produceAdvice(shipment, [order], ALDERLINE, controls);
doc.bytes;       // the 945, sealed (ISA/GS/ST/SE), byte-exact
```

One shape for an order, a shipment, a refusal: the canonical spine in
`canon.ts` — canonical JSON in a fixed key order per type (sheet 02's
writer law), a `v` checked at the decode door, absence written once
(scalar optionals always keyed with `""`/`[]`; structural optionals
omit their key), quantities counts, weights and money fixed-point.

## Mapping is the artifact — and it is data

`partners.ts` holds each trading partner as a **declarative profile**:
which documents they send, which segment paths feed which canonical
slots, the party loop, the id pairs, the despatch class and SLA, the
outbound templates. The mapping engine (`maps.ts`) reads three-letter
paths like `W01.5` and `N9{1=PO}.2` — tag, element, conditional pair —
and `checkMap` refuses a broken path at load, not at publish.

The executable thesis lives in `tests/partner.test.ts`: the **same
Alderline 940 through both profiles** yields two distinct canonical
orders — Alderline's own map takes the VN part number and the `N9*PO`
reference; Kelrick's map takes the IN part number, `W05.02` as the PO,
the `LX` loop number as the line name, expedite pace. Both orders
digest byte-for-byte under `tests/lock.test.ts`, pasted once from
`npm run lock` (`fixtures/lock.ts` → `fixtures/expected.ts`, the
house convention: a human re-runs and re-pastes).

The worked example is **fiction** on purpose: Alderline Provisions,
Kelrick Outfitters, Bramble & Twine (the 3PL, ours: `ZZ/BRAMBLE WMS`)
— so every fixture is reviewable to the byte, not cargo-culted.

## The lanes

| lane | kind | the traffic |
| --- | --- | --- |
| `orders` | stream out | one canonical order per accepted 940, subject `orders.<ref>.paid`, payload = sheet 02's `OrderRow v1` bytes — the WES reads it untouched |
| `waybill-dead` | DLQ out | one canonical refusal row per refused document, subject `<lane>.<code>.<docName>` (§2.10: the subject rides its lane) |
| `waybill-pace` | KV | control-number state `cntrl.<partner>.<doc>` — one journaled row per seal |

Refusal codes, each with its own document crime under test:
`X12_PARSE`, `ENVELOPE` (the ISA width law dies at its field),
`COUNTS` (a lying SE count refuses the whole file), `ROUTE_MISS` (an
unknown trading partner), `UNKNOWN_SEG`, `MAP_MISS` (a required slot
empty, a junk count, an empty id pair), `REF_CHARS` (a ref that could
not ride its own lane token). A file-level crime refuses the file; an
order-level crime refuses one order and spares its siblings — both
granularities tested.

## Outbound paperwork

`outbound.ts` mints the 945 and the 856 from the canonical shipment:
the same bytes the translation table gives, segment by segment,
locked as literal goldens. Envelope numbers come from `cntrl.ts` —
reserved BEFORE the numbers leave, one process mints in-process (the
KV read-modify-write queues per key), and the state *is* the journal:
a fresh yard hydrated from the rows continues the count forever. Both
minted documents re-parse clean (`encodeX12 ∘ parseX12` is the
identity on our output).

## The wire: one bus, one byte law

`wire.ts` mirrors `internal/wire` byte for byte — carried over whole
from sheet 02, because the yard is one bus for the whole fleet; the
golden test locks frames against hex derived by hand from
`PROTOCOL.md` §1–§7, re-derived for waybill's own subjects. `spur.ts`
is the reference client's TypeScript mirror (sessions brief by
default: no keepalive unless asked). `liveyard.ts` is the seam over a
live session; one honest asymmetry stands in the mirror — the real
yard's KV rows are journal rows of their own kind and never deliver
to lane consumers (§2.18), so a live `rows()` walks the stream window
only, and keys read back through `kvGet`.

## The live bring-up

`npm run run:waybill` — spawns the real Go yard (sibling repo
`switchyard`, `go run ./cmd/switchyard -data-dir <scratch>`), stages
the three files (two partners, one stranger) through the adapter
door, publishes order rows + the refusal to the DLQ, attaches a live
consumer on `orders` and proves the replay (every redelivered row
decodes to its canonical order), reserves and mints the 945 and 856,
re-reads the counters from the yard's own KV, prints the stat sheet,
says goodbye, and kills the tree. Wall clock appears only as elapsed
ms; no timestamps live in data.

## Testing

`npm test` — 118 characterization tests across 14 suites: the x12
metal (width law, count law, byte-exact round-trips, the trailing
terminator), the canonical spine (fixed-order bytes, the version
door, digests that cannot alias), the charter at the origin, desk
journal replay, the refusal zoo, one-file-two-maps, the 945/856
goldens, the control numbers (concurrency and reboot), the wire gold
hex, and the lock. `npm run typecheck`; `npm run lock` re-pastes the
digests when the mapping is deliberately revised.

## Sources

Standard text reads (the X12 standard text itself is paid ANSI; these
are the industry-common references the doc sets were checked against):

- Babelway, *EDI 940 Specification* — <https://www.babelway.com/knowledge-hub/edi-940/> (the W05/W06/W01/N9/G62 translation, cross-checked line by line)
- PartnerLinQ, *EDI 945* — <https://partnerlinq.com/blog/edi-945/> (the advice: W12/W03/N1/G62/MAN)
- the map-driven-validation idea is pyx12's: <https://github.com/azoner/pyx12>
- envelope-level discipline from tmc/x12: <https://github.com/tmc/x12>
- typed-canonical + round-trip discipline from LinuxForHealth/x12: <https://github.com/LinuxForHealth/x12>
- per-partner parser tailoring, in miniature: TigerShark <https://github.com/sbuss/TigerShark>
- the yard itself: `switchyard/docs/PROTOCOL.md` §1–§9 (the bus law)

## Stretch (unclaimed)

- 943/944 (stock transfer) — the maps engine takes new profiles as data
- 997 functional acks — the ack mode rides the per-partner profile
- ZPL label pass-through — binary payloads on work items, faithful carriage only
- AS2/SFTP transport — deliberately outside: waybill speaks to the yard; transports stay partners
- site page — the segment-by-segment translation table is locked in `fixtures/lock.ts` data; the rendering stays unclaimed
