# gangway

Dock appointments for one inbound day. Carriers ask for a door. The
engine sizes the slots, refuses anything past the utilization cap,
keeps unload inside the labor windows, and puts each trailer on the
door that shortens the walk to Harbor & Lane's aisles.

Hand-rolled TypeScript, zero runtime dependencies. Same day in, same
reading out.

The floor is quay's. Aisle pitch 3.6 m, dock-to-mouth 12.4 m, aisles
F, G, H — the reserve rack in `quay-engine`'s putaway day. The carriers
are fiction.

## What it decides

**Slots.** Per-class capacity is `(doors × shift) ÷ handling`, floored.
Parcel 30 min, dry 45, cold 60. Mixed days are not booked as class
slots. They are booked as door-minutes, and booked minutes may not
exceed `floor(doors × shift × 0.85)`.

**Refusal.** A trailer the cap cannot afford is refused (`cap`). A
trailer the cap could afford, but no labor window on its door can
hold, is refused (`no-window`). Neither case opens an extra minute.

**Arrivals.** One mulberry32 stream, appointment id order. A draw under
the no-show rate is a no-show. Otherwise lateness is symmetric around
the booked start, rounded to a minute.

**Unload.** On a door, cold before dry before parcel. The start is the
earliest minute at or after the trailer is actually there, inside a
labor window, clear of the door. If that minute does not exist, the
trailer queues. The meal gap is a window the engine will not book
across.

**Door fitness.** Busiest manifest first. The score of a door is carton
count times street distance: along the dock to the aisle's x, then
12.4 m in. Ties take the lower door index. The baseline assigns a
seeded uniform door in id order. The page reports both totals.

## The day

`fixtures/harbor.ts` is Harbor & Lane day 07. Two doors, 06:00–14:00,
windows 06:00–10:00 and 11:00–14:00, seed `20261118`. Tests in
`tests/gangway.test.ts` lock the reading.

## Sources

van Belle, Valckenaers, and Cattrysse, *Cross-docking: State of the
art*, Omega 40 (2012), for the door-assignment problem this heuristic
is the cheap answer to. The slot-sizing language — doors times hours,
divided by handling — is the dock-appointment framing. Distances are
quay's, so a metre here is a metre on the putaway day.
