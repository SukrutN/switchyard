/* ============================================================
   profiles — one summarizer for the characterization trio.

   Tests lock against it, the bench scales it, and running it
   with node prints the lock sheet for the site's figures.
   ============================================================ */

import { pack, validateSolution } from "../index.ts";
import { PROFILES } from "../fixtures/orders.ts";
import { CARTON_LIBRARY } from "../fixtures/cartons.ts";
import type { CartonSpec, OrderInput, ShipSolution } from "../index.ts";

export interface ProfileSummary {
  solution: ShipSolution;
  reportOk: boolean;
  failingChecks: string[];
}

export function summarize(
  order: OrderInput,
  library: CartonSpec[],
): ProfileSummary {
  const solution = pack(order, library);
  const report = validateSolution(solution);
  return {
    solution,
    reportOk: report.ok,
    failingChecks: report.checks.filter((c) => !c.ok).map((c) => c.id),
  };
}

export function allProfiles(): Record<string, ProfileSummary> {
  const out: Record<string, ProfileSummary> = {};
  for (const p of PROFILES) {
    out[p.key] = summarize(p.order, CARTON_LIBRARY);
  }
  return out;
}

/** Plain-text lock sheet: cartons, utilization, margins, validation. */
export function lockSheet(): string[] {
  const all = allProfiles();
  const out: string[] = [];
  for (const key of Object.keys(all)) {
    const { solution: sol, reportOk, failingChecks } = all[key];
    out.push(
      `${sol.order.name} — ${sol.cartons.length} carton(s), util ${(
        sol.cubeUtilization * 100
      ).toFixed(1)}%, margin ${(sol.weightMargin * 100).toFixed(0)}%, score ${sol.score.toFixed(3)}, validate=${reportOk ? "OK" : failingChecks.join(",")}`,
    );
    sol.cartons.forEach((c, i) =>
      out.push(
        `  ${i + 1}. ${c.template.id}: ${c.boxes.length} box(es), util ${(
          c.cubeUtilization * 100
        ).toFixed(1)}%, payload ${(c.payloadG / 1000).toFixed(2)} kg / ${(
          c.template.payloadG / 1000
        ).toFixed(2)} kg`,
      ),
    );
    if (sol.unfilled.length > 0) {
      out.push(
        `  UNFILLED: ${sol.unfilled
          .map((u) => `${u.sku} (${u.reason})`)
          .join("; ")}`,
      );
    }
  }
  return out;
}
