# dcsim

One seeded hour in a closed building. Orders arrive, a policy releases
them, carts walk, one AMR gate may hold the tour, the divert law names
a lane, and boxcar counts the cartons. Then the clock stops.

This is not a digital twin. There is no live telemetry, no geometry
you can walk, and no continuous state. FlexSim, AnyLogic, Siemens
Plant Simulation, and AutoMod are what a buyer is usually shown at
this point in a sales cycle. They are named here so the claim stays
the right size: this hour is a synthetic closed world, and the figures
are the engines' own decisions under a shared clock.

## Who does the math

- **Arrivals and travel** — `despatch-engine`'s seeded day and its tour
  proxy. That proxy is the aisle walk the family already prices; the
  simulation does not grow a second one.
- **Release** — `batchFcfs` against `batchOffline` plus `releasePlan`.
  The freeze is 300 seconds. The paced plan is the waveless one.
- **AMR window** — one server in front of the tour. It is the capacity
  a floor would be given, not a re-solve of hearthline's planner.
- **Divert** — fluxline's published predicate: 165 mm, then metal, then
  the 2–12 kg band.
- **Cartons** — `boxcar`'s `pack`, one call per order, the library it
  ships with.
- **Doors** — gangway's door count and parcel handling (30 min), four
  trailers on two doors, beside the order flow.

The simulation owns the queue, the warm-up (the first 10 minutes are
not in the throughput), and the ledger. It does not own a new solver.

## The picture

Same hour, three policies.

| policy | tour seconds | mean release lag | mean cycle | starvation |
| --- | --- | --- | --- | --- |
| FCFS | 3640 | 0 | 125 s | 0 |
| despatch | 2537 | 342 s | 562 s | 4015 s |
| despatch + AMR | 2537 | 342 s | 664 s | 3735 s |

Batching shortens the walk and leaves pickers idle while the window
is still shut. The AMR window spends a further 1839 seconds of waiting
without changing the tours.

## Reproduce

```
node --test engine/dcsim/tests/dcsim.test.ts
```

`runShift(policy, seed)` is the whole hour. The same seed is the same
registry.
