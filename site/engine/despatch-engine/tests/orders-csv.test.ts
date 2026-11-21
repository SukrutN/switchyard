/* ============================================================
   ordersCsv — the order-stream importer, graded row by row.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import { importOrdersCsv } from "../src/ordersCsv.ts";
import { CATALOG, SLOTTING } from "../fixtures/dc.ts";
import { batchOnline } from "../index.ts";
import { SLA_BY_CLASS } from "../src/constants.ts";

const sku = (i: number): string => CATALOG[i].sku;

test("rows group into orders, merge repeated skus, and dues follow the class law", () => {
  const csv = [
    "orderId,arrivalSec,sku,qty,class",
    `O-1,120,${sku(0)},3,critical`,
    `O-1,120,${sku(1)},2,critical`,
    `O-1,120,${sku(0)},1,critical`, // same sku again: quantities merge
    `O-2,300,${sku(2)},2,`,
    `O-3,240,${sku(3)},4,expedite`,
  ].join("\n");

  const imported = importOrdersCsv(csv, CATALOG);

  assert.equal(imported.report.rowsRead, 5);
  assert.equal(imported.report.rowsAccepted, 5);
  assert.equal(imported.report.rowsRejected, 0);
  assert.equal(imported.orders.length, 3);
  // arrival order, not file order
  assert.equal(imported.orders[0].id, "O-1");
  assert.equal(imported.orders[1].id, "O-3");
  assert.equal(imported.orders[2].id, "O-2");
  // the merged lines
  assert.deepEqual(imported.orders[0].lines, [
    { sku: sku(0), qty: 4 },
    { sku: sku(1), qty: 2 },
  ]);
  // dues by the class law; the blank class defaulted to standard
  assert.equal(imported.orders[0].dueSec, 120 + SLA_BY_CLASS.critical);
  assert.equal(imported.orders[2].dueSec, 300 + SLA_BY_CLASS.standard);
});

test("skus the catalog does not carry are refused with words", () => {
  const csv = [
    "orderId,arrivalSec,sku,qty",
    `O-1,120,${sku(0)},3`,
    "O-2,130,NO-SUCH-SKU,1",
  ].join("\n");

  const imported = importOrdersCsv(csv, CATALOG);

  assert.equal(imported.report.rowsAccepted, 1);
  assert.equal(imported.report.rowsRejected, 1);
  assert.equal(imported.report.rejections[0].line, 3);
  assert.match(imported.report.rejections[0].reasons[0], /NO-SUCH-SKU is not in the catalog/);
});

test("rows that move an order's arrival or class are refused", () => {
  const csv = [
    "orderId,arrivalSec,sku,qty,class",
    `O-1,120,${sku(0)},3,standard`,
    `O-1,140,${sku(1)},1,standard`,
    `O-1,120,${sku(2)},1,expedite`,
  ].join("\n");

  const imported = importOrdersCsv(csv, CATALOG);

  assert.equal(imported.report.rowsAccepted, 1);
  assert.equal(imported.report.rowsRejected, 2);
  assert.match(imported.report.rejections[0].reasons[0], /already arrived at second 120/);
  assert.match(imported.report.rejections[1].reasons[0], /already standard/);
});

test("bad quantities, arrivals, and classes are refused row by row", () => {
  const csv = [
    "orderId,arrivalSec,sku,qty,class",
    `O-1,-5,${sku(0)},3,standard`,
    `O-2,120,${sku(0)},0,standard`,
    `O-3,120,${sku(0)},3,whenever`,
  ].join("\n");

  const imported = importOrdersCsv(csv, CATALOG);

  assert.equal(imported.report.rowsAccepted, 0);
  assert.equal(imported.report.rowsRejected, 3);
  assert.match(imported.report.rejections[0].reasons.join(" "), /arrivalSec/);
  assert.match(imported.report.rejections[1].reasons.join(" "), /qty/);
  assert.match(imported.report.rejections[2].reasons.join(" "), /class/);
  assert.equal(imported.orders.length, 0);
  assert.match(imported.report.notes[0], /Every row was refused/);
});

test("a header problem refuses the file", () => {
  assert.throws(
    () => importOrdersCsv("orderId,arrivalSec,sku,qty,colour\nO-1,120,X,1,red", CATALOG),
    /unknown column: colour/,
  );
  assert.throws(
    () => importOrdersCsv("orderId,sku,qty\nO-1,X,1", CATALOG),
    /missing the arrivalSec column/,
  );
  assert.throws(
    () => importOrdersCsv("orderId,arrivalSec,sku,qty", CATALOG),
    /no data rows/,
  );
});

test("quoted fields parse, so an order id can carry a comma", () => {
  const csv = [
    "orderId,arrivalSec,sku,qty",
    `"O, late",120,${sku(0)},3`,
  ].join("\n");

  const imported = importOrdersCsv(csv, CATALOG);
  assert.equal(imported.orders[0].id, "O, late");
});

test("an imported stream runs through the engine like any day", () => {
  const lines: string[] = ["orderId,arrivalSec,sku,qty"];
  let t = 0;
  let n = 0;
  while (t < 3600) {
    for (let line = 0; line < 3; line++) {
      lines.push(`O-${n},${t},${sku((n + line) % CATALOG.length)},${1 + (n % 3)}`);
    }
    n++;
    t += 60;
  }
  const imported = importOrdersCsv(lines.join("\n"), CATALOG);
  assert.equal(imported.orders.length, n);

  // the engine accepts the built stream: every order publishes
  const run = batchOnline(imported.orders, 90, SLOTTING);
  assert.equal(Object.keys(run.publish).length, imported.orders.length);
});
