/* dcsim, unit 11. One closed hour, three policies, the engines' numbers. */

import type { Metadata } from "next"

import SiteHeader from "../components/SiteHeader"
import SiteFooter from "../components/SiteFooter"
import "../components/hero.css"
import "./components/dcsim.css"

import { compare, SHIFT } from "@/engine/dcsim/index.ts"
import type { Policy, Report } from "@/engine/dcsim/index.ts"

export const metadata: Metadata = {
  title: "dcsim · unit-11, one closed hour",
  description:
    "A synthetic hour at Bramble & Twine. FCFS, despatch, and despatch with an AMR window, on one clock. Not a digital twin.",
}

const trio = compare(SHIFT.seed)
const ORDER: Policy[] = ["fcfs", "despatch", "despatch-amr"]
const LABEL: Record<Policy, string> = {
  fcfs: "FCFS",
  despatch: "DESPATCH",
  "despatch-amr": "DESPATCH + AMR",
}

export default function DcsimPage() {
  const maxTour = Math.max(...ORDER.map((policy) => trio[policy].totalTourSec))
  return (
    <>
      <SiteHeader cross family={{ name: "dcsim", unit: "/unit-11", href: "/dcsim/" }} />
      <main>
        <section className="section dc-hero" id="top">
          <div className="wrp">
            <div className="hero__tags">
              <div className="hero__tag">
                <div className="hero__tag__k">UNIT</div>
                <div className="hero__tag__v">11 · ONE CLOSED HOUR</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">FLOOR</div>
                <div className="hero__tag__v">BRAMBLE &amp; TWINE</div>
              </div>
              <div className="hero__tag">
                <div className="hero__tag__k">SEED</div>
                <div className="hero__tag__v">{SHIFT.seed}</div>
              </div>
              <div className="hero__tag hero__tag--right">
                <div className="hero__tag__k">NOTE</div>
                <div className="hero__tag__v">NO LIVE FLOOR</div>
              </div>
            </div>
            <p className="eyebrow">dcsim, one hour on one clock</p>
            <h1 className="display hero__claim">Same orders. Three ways to let them go.</h1>
            <p className="lede hero__lede">
              {trio.fcfs.orders} orders arrive in one seeded hour. Despatch batches them, boxcar counts
              the cartons, and the divert rule names the lane. Nothing here is a live building. FlexSim,
              AnyLogic, Plant Simulation, and AutoMod are the products people usually buy for this
              picture. These numbers are the engines, run twice on the same seed. The first ten minutes
              are left out of the throughput.
            </p>
          </div>
        </section>

        <section className="section" id="trio">
          <div className="wrp">
            <p className="eyebrow">the trio</p>
            <h2 className="display dc-h">Shorter walks. Longer holds.</h2>
            <div className="dc-cards">
              {ORDER.map((policy) => (
                <Card key={policy} label={LABEL[policy]} report={trio[policy]} maxTour={maxTour} />
              ))}
            </div>
            <p className="dc-note">
              Batching cuts the walk from {trio.fcfs.totalTourSec} s to {trio.despatch.totalTourSec} s and
              leaves zones idle for {trio.despatch.starvationSec} s while the window is shut. The AMR gate
              keeps those tours and adds {trio["despatch-amr"].amrWaitSec} s of waiting. Five neighbouring
              seeds depart 31, 34, 33, 32, and 34 orders in the measured window, a spread of 3.
            </p>
          </div>
        </section>

        <section className="section" id="law">
          <div className="wrp dc-split">
            <div>
              <p className="eyebrow">divert</p>
              <h2 className="display dc-h">The floor names the lane either way.</h2>
              <p className="lede">
                Same pieces under every policy, because the law does not ask who released them. Tall to
                L03, metal to L02, off-weight to reject, the rest to L01.
              </p>
              <ul className="dc-gates">
                <li>L01 · {trio.despatch.divert.L01}</li>
                <li>L02 · {trio.despatch.divert.L02}</li>
                <li>L03 · {trio.despatch.divert.L03}</li>
                <li>RJ · {trio.despatch.divert.RJ}</li>
              </ul>
            </div>
            <div>
              <p className="eyebrow">ledger</p>
              <h2 className="display dc-h">Arrivals, departures, what is left.</h2>
              <p className="lede">
                At the hour, despatch has sent {trio.despatch.departedInWindow} orders out after the
                warm-up and still holds {trio.despatch.wipAtHorizon}. Dock doors, two of them, sit at{" "}
                {(trio.despatch.doorUtil * 100).toFixed(1)}% through the hour on gangway&apos;s parcel
                handling. Boxcar packed {trio.despatch.cartons} cartons.
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  )
}

function Card({ label, report, maxTour }: { label: string; report: Report; maxTour: number }) {
  return (
    <article className="dc-card">
      <p className="dc-card__k">{label}</p>
      <p className="dc-card__n">{report.totalTourSec} s</p>
      <span className="dc-card__bar">
        <span style={{ width: `${(report.totalTourSec / maxTour) * 100}%` }} />
      </span>
      <p className="dc-card__row">release lag {report.meanReleaseLagSec} s</p>
      <p className="dc-card__row">cycle {report.meanCycleSec} s</p>
      <p className="dc-card__row">starved {report.starvationSec} s</p>
      <p className="dc-card__row">left in the hour {report.wipAtHorizon}</p>
    </article>
  )
}
