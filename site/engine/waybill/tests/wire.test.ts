/* ============================================================
   wire.test — the byte law: golden frames hand-derived from
   `switchyard/docs/PROTOCOL.md` §1–§7 (not from this module —
   the hex strings were written off the tables before the
   encoders were trusted), then decode round-trips for every
   encoder family, then the §3 charter, the §7 skip rule, the
   reader's fatal cases, and the §6 error table.

   The goldens speak waybill where waybill has a stake: the
   HELLO carries this engine's label, the publish subject is
   the Alderline order's own, and the KV frames ride the pace
   lane. Frame layout for the derivations: 53 59 01 op + u32
   body length, then the §2 body table.
   ============================================================ */

import test from "node:test";
import assert from "node:assert/strict";
import * as w from "../src/wire.ts";

/* ---------- golden frames (§1 + §2, off the tables) ----------

   the convention: every encode*X helper returns a BODY; the socket
   edge assembles the header with encodeFrame (spur's rpcRound
   passes op + body separately). The goldens therefore assert the
   whole frame — body from the helper, head from encodeFrame. */

const frameHex = (op: number, body: Uint8Array): string =>
  w.hex(w.encodeFrame(op, body));

test("golden: HELLO {waybill, ts-waybill} — u8 len|str pairs", () => {
  // body: 07 'waybill' 0a 'ts-waybill' -> len 19 = 0x13
  assert.equal(
    frameHex(
      w.OP.HELLO,
      w.encodeHello({ name: "waybill", label: "ts-waybill" }),
    ),
    "53590101000000130777617962696c6c0a74732d77617962696c6c",
  );
  assert.deepEqual(w.decodeHello(w.encodeHello({ name: "", label: "" })), {
    name: "",
    label: "",
  });
});

test("golden: PING — empty body", () => {
  assert.equal(w.hex(w.encodeFrame(w.OP.PING, w.EMPTY_BODY)), "5359010300000000");
});

test("golden: STREAM_CREATE 'orders' — u16 len|str", () => {
  assert.equal(
    frameHex(w.OP.STREAM_CREATE, w.encodeStreamCreate({ lane: "orders" })),
    "5359010b0000000800066f7264657273",
  );
});

test("golden: STREAM_PUBLISH the Alderline order on the orders lane", () => {
  // body: 0006 'orders' 0015 'orders.AHL-00175.paid' 00 00000002 'hi' -> 38 bytes
  assert.equal(
    frameHex(
      w.OP.STREAM_PUBLISH,
      w.encodeStreamPublish({
        lane: "orders",
        subject: "orders.AHL-00175.paid",
        payload: new TextEncoder().encode("hi"),
      }),
    ),
    "5359010d0000002600066f726465727300156f72646572732e41484c2d30303137352e7061696400000000026869",
  );
});

test("golden: KV_SET board on the pace lane", () => {
  // body: 000c 'waybill-pace' 0005 'board' 00000002 'b1' -> 27 bytes
  assert.equal(
    frameHex(
      w.OP.KV_SET,
      w.encodeKVSet({
        lane: "waybill-pace",
        key: "board",
        payload: new TextEncoder().encode("b1"),
      }),
    ),
    "535901150000001b000c77617962696c6c2d706163650005626f617264000000026231",
  );
});

test("golden: KV_GET board", () => {
  // body: 000c 'waybill-pace' 0005 'board' -> 21 bytes
  assert.equal(
    frameHex(w.OP.KV_GET, w.encodeKVGet({ lane: "waybill-pace", key: "board" })),
    "5359011600000015000c77617962696c6c2d706163650005626f617264",
  );
});

test("golden: ACK sid 7, seq 3 — u32 sid | u64 seq", () => {
  assert.equal(
    frameHex(w.OP.ACK, w.encodeAck({ sid: 7, seq: 3 })),
    "535901120000000c000000070000000000000003",
  );
});

test("golden: LANE_INFO 'waybill-dead'", () => {
  // body: 000c 'waybill-dead' -> 14 bytes
  assert.equal(
    frameHex(w.OP.LANE_INFO, w.encodeLaneInfo({ lane: "waybill-dead" })),
    "5359011d0000000e000c77617962696c6c2d64656164",
  );
});

test("golden: SUBSCRIBE 'orders.>' sid 9", () => {
  assert.equal(
    frameHex(w.OP.SUBSCRIBE, w.encodeSubscribe({ pattern: "orders.>", sid: 9 })),
    "535901060000000e00086f72646572732e3e00000009",
  );
});

/* ---------- decode round-trips, one per family ---------- */

test("round-trips: handshake + publish-shaped bodies", () => {
  const px = new TextEncoder().encode("pay");
  assert.deepEqual(w.decodeHello(w.encodeHello({ name: "crew-1", label: "ts-waybill" })), {
    name: "crew-1",
    label: "ts-waybill",
  });
  assert.deepEqual(
    w.decodeWelcome(w.encodeWelcome({ serverLabel: "switchyard/1.0.0", maxBody: 1048576 })),
    { serverLabel: "switchyard/1.0.0", maxBody: 1048576 },
  );
  assert.deepEqual(
    w.decodePublish(w.encodePublish({ subject: "orders.a.paid", payload: px })),
    { subject: "orders.a.paid", reply: undefined, payload: px },
  );
  assert.deepEqual(
    w.decodeDeliver(w.encodeDeliver({ subject: "x.y", sid: 4, seq: 9, payload: px })),
    { subject: "x.y", sid: 4, seq: 9, reply: undefined, payload: px },
  );
  assert.deepEqual(
    w.decodeStreamPublish(
      w.encodeStreamPublish({ lane: "orders", subject: "orders.createdAt.paid", payload: px }),
    ),
    { lane: "orders", subject: "orders.createdAt.paid", reply: undefined, payload: px },
  );
  assert.deepEqual(
    w.decodeLaneDeliver(w.encodeLaneDeliver({ subject: "orders.a.paid", sid: 2, seq: 7, payload: px })),
    { subject: "orders.a.paid", sid: 2, seq: 7, reply: undefined, payload: px },
  );
});

test("round-trips: consumers, KV family, console", () => {
  const px = new TextEncoder().encode("row");
  const withFilter = w.encodeConsumerAttach({
    lane: "orders",
    consumer: "waybill-batch",
    filter: "orders.>",
    sid: 12,
    ackWaitMillis: 0,
  });
  assert.deepEqual(w.decodeConsumerAttach(withFilter), {
    lane: "orders",
    consumer: "waybill-batch",
    filter: "orders.>",
    sid: 12,
    ackWaitMillis: 0,
  });
  const noFilter = w.encodeConsumerAttach({
    lane: "waybill-dead",
    consumer: "waybill-ctl",
    sid: 3,
    ackWaitMillis: 5000,
  });
  assert.deepEqual(w.decodeConsumerAttach(noFilter), {
    lane: "waybill-dead",
    consumer: "waybill-ctl",
    filter: undefined,
    sid: 3,
    ackWaitMillis: 5000,
  });
  assert.deepEqual(
    w.decodeConsumerReady(
      w.encodeConsumerReady({
        lane: "orders",
        consumer: "waybill-batch",
        sid: 12,
        next: 41,
        ackWaitMillis: 0,
      }),
    ),
    { lane: "orders", consumer: "waybill-batch", sid: 12, next: 41, ackWaitMillis: 0 },
  );
  assert.deepEqual(
    w.decodeKVValue(
      w.encodeKVValue({
        lane: "waybill-pace",
        key: "board",
        seq: 5,
        found: true,
        payload: px,
      }),
    ),
    { lane: "waybill-pace", key: "board", seq: 5, found: true, payload: px },
  );
  const miss = w.decodeKVValue(
    w.encodeKVValue({ lane: "waybill-pace", key: "board", seq: 0, found: false }),
  );
  assert.equal(miss.found, false);
  assert.equal(miss.seq, 0);
  assert.equal(miss.payload, undefined);
  assert.deepEqual(
    w.decodeKVKeyListBody(w.encodeKVKeyList({ lane: "waybill-pace", keys: ["b", "a"] })),
    { lane: "waybill-pace", keys: ["a", "b"] },
  );
  assert.deepEqual(
    w.decodeLaneState(
      w.encodeLaneState({
        lane: "waybill-pace",
        seq: 9,
        quarantined: true,
        journalBytes: 432,
        keyCount: 1,
        consumers: [{ name: "waybill", floor: 7, pending: 2, attached: true }],
      }),
    ),
    {
      lane: "waybill-pace",
      seq: 9,
      quarantined: true,
      journalBytes: 432,
      keyCount: 1,
      consumers: [{ name: "waybill", floor: 7, pending: 2, attached: true }],
    },
  );
  assert.deepEqual(
    w.decodeYardState(
      w.encodeYardState({
        version: "1.0.0",
        uptimeSec: 12,
        sessions: 2,
        lanes: [{ lane: "orders", seq: 3 }],
        quarantined: ["bad-lane"],
      }),
    ),
    {
      version: "1.0.0",
      uptimeSec: 12,
      sessions: 2,
      lanes: [{ lane: "orders", seq: 3 }],
      quarantined: ["bad-lane"],
    },
  );
});

/* ---------- ByteReader / ByteWriter edges ---------- */

test("reader: truncated and trailing bodies are MALFORMED", () => {
  const good = w.encodeAck({ sid: 1, seq: 3 });
  const truncated = good.slice(0, good.length - 2);
  assert.throws(() => w.decodeAck(truncated), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.MALFORMED);
  assert.throws(() => w.decodeAck(new Uint8Array([...good, 0x01])), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.MALFORMED);
});

test("reader: u64 accepts safe integers, refuses the rest", () => {
  assert.equal(w.decodeAck(w.encodeAck({ sid: 1, seq: 2 ** 53 - 1 })).seq, 2 ** 53 - 1);
  // the ACK body: u32 sid at 0..3, u64 seq at 4..11 — 2^53 is not a yard sequence
  const tooBig = w.encodeAck({ sid: 1, seq: 1 });
  tooBig.set(w.fromHex("0020000000000000"), 4);
  assert.throws(() => w.decodeAck(tooBig), (e: unknown) =>
    e instanceof w.WireError);
  assert.throws(() => w.encodeAck({ sid: 1, seq: 2 ** 53 }));
  assert.throws(() => w.encodeAck({ sid: 1, seq: -1 }));
  assert.throws(() => w.encodeAck({ sid: 0, seq: 1 }), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.MALFORMED);
});

/* ---------- the subject charter (§3) ---------- */

test("charter: publish subjects refuse wildcards and misfits", () => {
  assert.throws(() => w.checkSubject("orders.*.paid", w.OP.PUBLISH), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.BAD_SUBJECT);
  assert.throws(() => w.checkSubject("orders.>", w.OP.PUBLISH), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.BAD_SUBJECT);
  assert.throws(() => w.checkSubject("", w.OP.PUBLISH), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.BAD_SUBJECT);
  assert.throws(() => w.checkSubject("orders. test", w.OP.PUBLISH), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.BAD_SUBJECT);
  assert.throws(() => w.checkSubject("orders.\u007f", w.OP.PUBLISH), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.BAD_SUBJECT);
  assert.throws(() => w.checkSubject(new Array(33).fill("a").join("."), w.OP.PUBLISH));
  assert.equal(w.checkSubject("orders.AHL-00175.paid", w.OP.PUBLISH), "orders.AHL-00175.paid");
});

test("charter: patterns allow wildcards, '>' only final", () => {
  assert.equal(w.checkPattern("orders.>", w.OP.CONSUMER_ATTACH), "orders.>");
  assert.equal(w.checkPattern("orders.*", w.OP.CONSUMER_ATTACH), "orders.*");
  assert.throws(() => w.checkPattern("orders.>.x", w.OP.CONSUMER_ATTACH), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.BAD_SUBJECT);
});

test("charter: subjectMatches is byte-exact §3 matching", () => {
  assert.equal(w.subjectMatches("orders.>", "orders.AHL-00175.paid"), true);
  assert.equal(w.subjectMatches("orders.>", "orders"), false);
  assert.equal(w.subjectMatches("orders.>", "waybill-pace.board"), false);
  assert.equal(w.subjectMatches("orders.*", "orders.x"), true);
  assert.equal(w.subjectMatches("orders.*", "orders.x.y"), false);
  assert.equal(w.subjectMatches("*.paid", "orders.paid"), true);
  assert.equal(w.subjectMatches("orders.paid", "orders.paid"), true);
  assert.equal(w.subjectMatches("orders.paid", "orders.paid.x"), false);
});

test("charter: subject rides the lane (§2.10); lane names and keys refuse", () => {
  assert.throws(
    () =>
      w.encodeStreamPublish({
        lane: "orders",
        subject: "waybill-pace.board",
        payload: new Uint8Array(1),
      }),
    (e: unknown) => e instanceof w.WireError && e.code === w.ERR.STREAM_SUBJECT,
  );
  assert.equal(w.subjectRidesLane("orders", "orders.a.paid"), true);
  assert.equal(w.subjectRidesLane("orders", "orders"), true);
  assert.equal(w.subjectRidesLane("orders", "other"), false);
  assert.throws(
    () => w.encodeStreamCreate({ lane: "" }),
    (e: unknown) => e instanceof w.WireError && e.code === w.ERR.BAD_STREAM_NAME,
  );
  assert.throws(
    () => w.encodeStreamCreate({ lane: "a".repeat(65) }),
    (e: unknown) => e instanceof w.WireError && e.code === w.ERR.BAD_STREAM_NAME,
  );
  assert.throws(
    () => w.encodeKVGet({ lane: "orders", key: "" }),
    (e: unknown) => e instanceof w.WireError && e.code === w.ERR.BAD_KEY,
  );
  assert.throws(
    () => w.encodeKVGet({ lane: "orders", key: "k".repeat(129) }),
    (e: unknown) => e instanceof w.WireError && e.code === w.ERR.BAD_KEY,
  );
});

/* ---------- the reader (§1 + §7) ---------- */

test("reader: a frame split across chunk boundaries is one frame", () => {
  const frame = w.encodeFrame(w.OP.PING, w.EMPTY_BODY);
  const r = new w.FrameReader();
  r.feed(frame.slice(0, 3));
  assert.equal(r.next(), null);
  r.feed(frame.slice(3));
  const got = r.next();
  assert.ok(got);
  assert.equal(got.op, w.OP.PING);
  assert.equal(got.skipped, false);
  assert.equal(r.next(), null);
});

test("reader: §7 skip rule — over softMax discards exactly bodyLen", () => {
  const r = new w.FrameReader(); // yard default 1 MiB
  const big = w.encodeFrame(w.OP.LANE_INFO, new Uint8Array(2 * 1024 * 1024));
  const ping = w.encodeFrame(w.OP.PING, w.EMPTY_BODY);
  const all = new Uint8Array([...ping, ...big, ...ping]);
  r.feed(all);
  const f1 = r.next();
  assert.ok(f1 && f1.op === w.OP.PING && !f1.skipped);
  const f2 = r.next();
  assert.ok(f2 && f2.skipped && f2.body.length === 0 && f2.op === w.OP.LANE_INFO);
  const f3 = r.next();
  assert.ok(f3 && f3.op === w.OP.PING && !f3.skipped);
  assert.equal(r.next(), null);
});

test("reader: protocol ceiling and protocol crimes are fatal", () => {
  const overCeiling = new Uint8Array([0x53, 0x59, 0x01, w.OP.LANE_INFO, 0x00, 0x50, 0x00, 0x00]);
  const r = new w.FrameReader();
  r.feed(overCeiling);
  assert.throws(() => r.next(), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.TOO_LARGE && e.fatal);
  const badMagic = new Uint8Array([0x00, 0x59, 0x01, 0x03, 0, 0, 0, 0]);
  const r2 = new w.FrameReader();
  r2.feed(badMagic);
  assert.throws(() => r2.next(), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.MALFORMED && e.fatal);
  const badVersion = new Uint8Array([0x53, 0x59, 0x09, 0x03, 0, 0, 0, 0]);
  const r3 = new w.FrameReader();
  r3.feed(badVersion);
  assert.throws(() => r3.next(), (e: unknown) =>
    e instanceof w.WireError && e.code === w.ERR.UNSUPPORTED_VERSION && e.fatal);
  const r4 = new w.FrameReader();
  r4.feed(new Uint8Array([0x53, 0x59]));
  assert.equal(r4.next(), null);
});

test("writer: bodies over the protocol ceiling refuse before bytes", () => {
  assert.throws(
    () => w.encodeFrame(w.OP.PUBLISH, new Uint8Array(w.MAX_BODY_BYTES + 1)),
    (e: unknown) => e instanceof w.WireError && e.code === w.ERR.TOO_LARGE,
  );
});

/* ---------- the §6 error table ---------- */

test("error table: exactly the six fatal codes; server speech flagged", () => {
  for (const fatal of [w.ERR.MALFORMED, w.ERR.UNSUPPORTED_VERSION, w.ERR.SLOW_CONSUMER,
    w.ERR.UNKNOWN_OP, w.ERR.IDLE_TIMEOUT, w.ERR.NOT_ALLOWED]) {
    assert.equal(w.errFatal(fatal), true, w.errName(fatal));
  }
  for (const calm of [w.ERR.BAD_SUBJECT, w.ERR.DUP_SUB, w.ERR.TOO_LARGE,
    w.ERR.STREAM_UNKNOWN, w.ERR.STREAM_EXISTS, w.ERR.SERVER_FAULT, w.ERR.BAD_KEY]) {
    assert.equal(w.errFatal(calm), false, w.errName(calm));
  }
  assert.equal(w.isServerOnly(w.OP.WELCOME), true);
  assert.equal(w.isServerOnly(w.OP.LANE_STATE), true);
  assert.equal(w.isServerOnly(w.OP.PUBLISH), false);
  assert.equal(w.isServerOnly(w.OP.ACK), false);
  const e = new w.WireError(w.ERR.TOO_LARGE, false, "no", w.OP.STREAM_PUBLISH);
  assert.match(e.message, /TOO_LARGE/);
  assert.match(e.message, /STREAM_PUBLISH/);
});
