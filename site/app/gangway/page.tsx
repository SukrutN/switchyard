/* gangway, unit 10. The page is the engine's reading of Harbor & Lane
   day 07. Every figure is a call into engine/gangway-engine. */

import type { Metadata } from "next"

import SiteHeader from "../components/SiteHeader"
import SiteFooter from "../components/SiteFooter"
import "../components/hero.css"
import "./components/gangway.css"

import { HARBOR, loadCurve, run } from "@/engine/gangway-engine/index.ts"

export const metadata: Metadata = {
  title: "gangway · unit-10, the dock day",
  description:
    "Dock appointments, a capped utilization curve, and a door-fitness assignment against Harbor & Lane's aisle mouths. Fictional carriers, one seeded day.",
}

const reading = run(HARBOR)
const curve = loadCurve(HARBOR, [1, 2, 3])
const savedM = (reading.randomDm - reading.fitnessDm) / 10

function meters(dm: number): string {
  return (dm / 10).toFixed(1)
}

function clock(min: number): string {
  const abs = ((min % 1440) + 1440) % 1440
  const h = Math.floor(abs / 60) + 6
  const m = abs % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

export default function GangwayPage() {
  return (
    <>
      <SiteHeader cross family={{ name: "gangway", unit: "/unit-10", href: "/gangway/" }} />
      <main>
        <section className="section gw-hero" id="top">
          <div className="wrp">
            <div className="hero__tags">
              <div className="hero__tag">
                <div className="hero__tag__k">UNIT</div>
                <div className="hero__tag__v">10 · DOCK &amp; DOORS</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">FLOOR</div>
                <div className="hero__tag__v">HARBOR &amp; LANE · QUAY</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">CAP</div>
                <div className="hero__tag__v">85% OF DOOR-MINUTES</div>
              </div>
              <div className="hero__tag hero__tag--right">
                <div className="hero__tag__k">DEPENDENCIES</div>
                <div className="hero__tag__v">ZERO</div>
              </div>
            </div>

            <div className="hero__grid">
              <div>
                <p className="eyebrow">gangway, the dock family</p>
                <h1 className="display hero__claim">Full doors turn trailers away.</h1>
                <p className="lede hero__lede">
                  Twenty made-up carriers ask for a door on Harbor &amp; Lane, day 07. A slot is
                  doors times hours, divided by how long that trailer takes. Booked time stops at 85
                  percent. A trailer that misses its window waits. The shift does not get longer to fit it.
                </p>
              </div>
              <div className="gw-stats" aria-label="the dock day in six numbers">
                <Stat k="OFFERED" v={`${reading.offered}`} />
                <Stat k="BOOKED" v={`${reading.accepted}`} />
                <Stat k="REFUSED" v={`${reading.refused}`} />
                <Stat k="NO-SHOW" v={`${reading.noShows}`} />
                <Stat k="QUEUED" v={`${reading.queued}`} />
                <Stat k="UTILIZATION" v={`${(reading.utilization * 100).toFixed(2)}%`} />
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="curve">
          <div className="wrp gw-split">
            <div>
              <p className="eyebrow">slot liability</p>
              <h2 className="display gw-h">Load piles up. The cap holds.</h2>
              <p className="lede">
                One copy of the day books {reading.bookedMin} of {reading.availableMin} door-minutes
                ({(reading.utilization * 100).toFixed(2)}%). Two copies and three copies both stop at{" "}
                {curve[1].bookedMin} minutes, under the cap of {reading.capMin}, and under the 85
                percent line. Class slots if the day were all one kind: parcel {reading.classSlots.parcel},
                dry {reading.classSlots.dry}, cold {reading.classSlots.cold}.
              </p>
              <table className="gw-table">
                <thead>
                  <tr>
                    <th>copies</th>
                    <th>offered min</th>
                    <th>booked min</th>
                    <th>utilization</th>
                    <th>refused</th>
                  </tr>
                </thead>
                <tbody>
                  {curve.map((point) => (
                    <tr key={point.copies}>
                      <td>{point.copies}</td>
                      <td>{point.offeredMin}</td>
                      <td>{point.bookedMin}</td>
                      <td>{(point.utilization * 100).toFixed(2)}%</td>
                      <td>{point.refused}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <p className="eyebrow">door fitness</p>
              <h2 className="display gw-h">Put the freight on the near door.</h2>
              <p className="lede">
                Aisle mouths F, G, and H sit on quay&apos;s pitch: 3.6 m apart, 12.4 m in from the dock.
                Busiest trailer first, then the door with the shorter street. Against a seeded random
                door, the same manifest walks {savedM.toFixed(1)} m less.
              </p>
              <div className="gw-bars" aria-label="carton-metres, fitness against random">
                <Bar label="FITNESS" dm={reading.fitnessDm} max={reading.randomDm} />
                <Bar label="RANDOM" dm={reading.randomDm} max={reading.randomDm} />
              </div>
              <p className="gw-note">
                {meters(reading.fitnessDm)} m fitness · {meters(reading.randomDm)} m random · pressure{" "}
                {reading.pressureMin} min of waiting after arrival
              </p>
            </div>
          </div>
        </section>

        <section className="section" id="day">
          <div className="wrp">
            <p className="eyebrow">the day</p>
            <h2 className="display gw-h">Who made the door, who waited.</h2>
            <p className="lede">
              Shift opens 06:00. The meal gap is 10:00–11:00. Kettle Freight (HL-01) is the seeded
              no-show. {reading.holds.map((hold) => hold.id).join(" and ")} were booked, then had no
              legal window left once the door was busy, so they queue.{" "}
              {reading.refusals.map((refusal) => refusal.id).join(", ")} never got a slot.
            </p>
            <ol className="gw-walk">
              {reading.unloads.map((unload) => (
                <li key={unload.id}>
                  <span className="gw-when">{clock(unload.startMin)}</span>
                  <span className="gw-who">
                    {unload.id} · door {unload.door + 1} · {unload.klass}
                  </span>
                  <span className="gw-what">
                    {unload.carrier} unloads until {clock(unload.endMin)}
                    {unload.waitMin > 0 ? ` · waited ${unload.waitMin} min` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  )
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="gw-stat">
      <span className="gw-stat__k">{k}</span>
      <span className="gw-stat__v">{v}</span>
    </div>
  )
}

function Bar({ label, dm, max }: { label: string; dm: number; max: number }) {
  return (
    <div className="gw-bar">
      <span>{label}</span>
      <span className="gw-bar__track">
        <span className="gw-bar__fill" style={{ width: `${(dm / max) * 100}%` }} />
      </span>
      <span>{meters(dm)} m</span>
    </div>
  )
}
