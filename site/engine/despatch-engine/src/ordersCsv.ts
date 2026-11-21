/* ============================================================
   ordersCsv — the order-stream importer.

   A WMS export as CSV, one row per order line, becomes the
   engine's own order shape: lines grouped into orders, dues set
   by the class law (SLA_BY_CLASS), positions refused for any SKU
   the catalog does not carry. The importer never invents data:
   it groups, it validates with the engine's words, and it
   reports every row it refused with its physical line number.
   ============================================================ */

import { SLA_BY_CLASS } from "./constants.ts";
import type { CatalogEntry, DespatchOrder, OrderClass } from "./types.ts";

/** One refused CSV row: the physical line, the order id if it
 *  parsed, and the reasons in plain words. */
export interface RowRejection {
  readonly line: number;
  readonly order: string;
  readonly reasons: readonly string[];
}

/** The import's paper trail. */
export interface OrdersImportReport {
  readonly rowsRead: number;
  readonly rowsAccepted: number;
  readonly rowsRejected: number;
  readonly rejections: readonly RowRejection[];
  readonly notes: readonly string[];
}

/** The import's result. */
export interface OrdersImport {
  readonly orders: readonly DespatchOrder[];
  readonly report: OrdersImportReport;
}

const REQUIRED = ["orderId", "arrivalSec", "sku", "qty"] as const;
const OPTIONAL = ["class"] as const;
const CLASSES: readonly OrderClass[] = ["standard", "expedite", "critical"];

/** One parsed CSV row: its cells and the physical line it began on. */
interface Row {
  readonly cells: readonly string[];
  readonly line: number;
}

/**
 * Replaces nothing, invents nothing: reads the CSV, groups its
 * lines into orders, and answers the orders the engine accepts
 * alongside a report of everything it refused.
 */
export function importOrdersCsv(csv: string, catalog: readonly CatalogEntry[]): OrdersImport {
  const problems: string[] = [];
  const rows = parseCsv(csv, problems);
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }

  // Map header names to column indexes; strict, because a typo'd
  // column would silently drop a line.
  const header = rows[0].cells;
  const columns = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    const name = header[i].trim();
    if (!REQUIRED.includes(name as (typeof REQUIRED)[number]) && !OPTIONAL.includes(name as (typeof OPTIONAL)[number])) {
      problems.push(`The CSV header has an unknown column: ${name}.`);
    } else if (columns.has(name)) {
      problems.push(`The CSV header lists ${name} twice.`);
    } else {
      columns.set(name, i);
    }
  }
  for (const need of REQUIRED) {
    if (!columns.has(need)) {
      problems.push(`The CSV header is missing the ${need} column.`);
    }
  }
  if (problems.length > 0) {
    throw new Error(problems.join(" "));
  }

  const skus = new Set(catalog.map((entry) => entry.sku));
  const rejections: RowRejection[] = [];
  // order id -> the order being assembled, in arrival order
  const byId = new Map<string, { order: DespatchOrder; skuLines: Map<string, number> }>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const cell = (name: string): string => {
      const index = columns.get(name);
      return index === undefined || index >= row.cells.length ? "" : row.cells[index].trim();
    };
    const id = cell("orderId");
    const sku = cell("sku");
    const clsRaw = cell("class") || "standard";
    const reasons: string[] = [];

    if (id === "") {
      reasons.push("orderId is empty.");
    }
    const arrival = Number(cell("arrivalSec"));
    if (cell("arrivalSec") === "" || !Number.isFinite(arrival) || arrival < 0) {
      reasons.push("arrivalSec must be a number of seconds from the start of the day, zero or later.");
    }
    if (sku === "") {
      reasons.push("sku is empty.");
    } else if (!skus.has(sku)) {
      reasons.push(`sku ${sku} is not in the catalog; the catalog carries ${catalog.length} SKUs.`);
    }
    const qty = Number(cell("qty"));
    if (cell("qty") === "" || !Number.isInteger(qty) || qty < 1) {
      reasons.push("qty must be a whole number of one or more.");
    }
    if (!CLASSES.includes(clsRaw as OrderClass)) {
      reasons.push(`class must be standard, expedite, or critical, not "${clsRaw}".`);
    }

    if (reasons.length === 0) {
      const cls = clsRaw as OrderClass;
      const existing = byId.get(id);
      if (existing) {
        // rows of one order must agree on when it arrived and what it is
        if (existing.order.arrivalSec !== arrival) {
          reasons.push(`order ${id} already arrived at second ${existing.order.arrivalSec}; a row cannot move it to ${arrival}.`);
        } else if (existing.order.cls !== cls) {
          reasons.push(`order ${id} is already ${existing.order.cls}; a row cannot also call it ${cls}.`);
        }
      }
    }

    if (reasons.length > 0) {
      rejections.push({ line: row.line, order: id, reasons });
      continue;
    }

    const cls = clsRaw as OrderClass;
    let entry = byId.get(id);
    if (!entry) {
      const order: DespatchOrder = {
        id,
        arrivalSec: arrival,
        lines: [],
        cls,
        // the class law sets the due: the promise Bramble bought
        dueSec: arrival + SLA_BY_CLASS[cls],
      };
      entry = { order, skuLines: new Map() };
      byId.set(id, entry);
    }
    entry.skuLines.set(sku, (entry.skuLines.get(sku) ?? 0) + qty);
  }

  const orders: DespatchOrder[] = [];
  for (const entry of byId.values()) {
    const lines = [...entry.skuLines.entries()].map(([sku, qty]) => ({ sku, qty }));
    orders.push({ ...entry.order, lines });
  }
  orders.sort((a, b) => a.arrivalSec - b.arrivalSec || (a.id < b.id ? -1 : 1));

  if (rows.length === 1) {
    throw new Error("The CSV carried no data rows.");
  }
  if (orders.length === 0) {
    return {
      orders,
      report: {
        rowsRead: rows.length - 1,
        rowsAccepted: 0,
        rowsRejected: rejections.length,
        rejections,
        notes: ["Every row was refused, so no stream was built."],
      },
    };
  }

  const lastArrival = orders[orders.length - 1].arrivalSec;
  return {
    orders,
    report: {
      rowsRead: rows.length - 1,
      rowsAccepted: rows.length - 1 - rejections.length,
      rowsRejected: rejections.length,
      rejections,
      notes: [
        `${orders.length} orders were built from the accepted rows, dues set by the class law ` +
          `(critical ${SLA_BY_CLASS.critical / 60} minutes after arrival, expedite ${SLA_BY_CLASS.expedite / 60}, ` +
          `standard ${SLA_BY_CLASS.standard / 60}).`,
        `The last arrival lands at second ${lastArrival}; the sweep needs a horizon past it.`,
      ],
    },
  };
}

/** A small honest CSV reader: quoted fields, doubled quotes inside
 *  them, either line ending, blank lines skipped. Line numbers are
 *  physical. */
function parseCsv(csv: string, problems: string[]): Row[] {
  const rows: Row[] = [];
  const cells: string[] = [];
  let cell = "";
  let line = 1;
  let inQuotes = false;
  let quotedCell = false;

  const finishRow = () => {
    const blank = cell === "" && cells.every((value) => value === "");
    cells.push(cell);
    cell = "";
    if (!blank) {
      rows.push({ cells: [...cells], line });
    }
    cells.length = 0;
  };

  for (let i = 0; i <= csv.length; i++) {
    const c = i < csv.length ? csv[i] : "\n";
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < csv.length && csv[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
        if (c === "\n") {
          line++;
        }
      }
      continue;
    }
    if (c === '"') {
      if (cell === "" && !quotedCell) {
        inQuotes = true;
        quotedCell = true;
      } else {
        cell += c;
      }
    } else if (c === ",") {
      cells.push(cell);
      cell = "";
      quotedCell = false;
    } else if (c === "\r") {
      if (i + 1 < csv.length && csv[i + 1] === "\n") {
        continue;
      }
      finishRow();
      line++;
    } else if (c === "\n") {
      finishRow();
      line++;
    } else {
      cell += c;
    }
  }
  if (inQuotes) {
    problems.push("The CSV ends inside an unterminated quoted field.");
  }
  if (rows.length === 0) {
    problems.push("The CSV carried no header row.");
  }
  return rows;
}
