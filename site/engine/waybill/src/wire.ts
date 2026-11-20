/* ============================================================
   wire — the Switchyard line protocol, version 1, in TypeScript.

   This file mirrors `internal/wire` byte for byte: the frame
   header (§1), every op body (§2), the subject charter (§3),
   the error table (§6), and the reader's skip rule (§7). The
   numbers are bus-stable — an encoded frame from here and an
   encoded frame from Go agree byte for byte, which the golden
   test locks against independently hand-derived hex:
   `tests/wire.test.ts`.

   Lineage: carried over whole from sheet 02 (`despatch-wes`),
   because the yard is one bus for the whole fleet — waybill
   speaks the same frames that engine proved, number for number.

   Pure throughout: no sockets, no clocks, no deps. Encoders
   read exactly like the §2 tables — one statement per field —
   so a protocol diff is a one-place review.

   House references: `switchyard/docs/PROTOCOL.md` §1–§7;
   `switchyard/internal/wire/codec.go`, `codec_streams.go`,
   `codec_kv.go`, `codec_yard.go`, `codec_auth.go`.
   ============================================================ */

/* ---------- frame layout (§1) ---------- */

export const MAGIC1 = 0x53; // 'S'
export const MAGIC2 = 0x59; // 'Y'
export const VERSION = 0x01;
export const HEADER_LEN = 8;

/** protocol-wide ceiling: a declared body above this is sabotage (§7). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** the yard's default ceiling (§7); WELCOME's maxBody outranks it (§2.2). */
export const YARD_MAX_BODY = 1 * 1024 * 1024;

/* ---------- op codes (§2 table) ---------- */

export const OP = {
  HELLO: 0x01,
  WELCOME: 0x02,
  PING: 0x03,
  PONG: 0x04,
  PUBLISH: 0x05,
  SUBSCRIBE: 0x06,
  UNSUB: 0x07,
  DELIVER: 0x08,
  ERROR: 0x09,
  BYE: 0x0a,
  STREAM_CREATE: 0x0b,
  STREAM_READY: 0x0c,
  STREAM_PUBLISH: 0x0d,
  STREAM_RECEIPT: 0x0e,
  CONSUMER_ATTACH: 0x0f,
  CONSUMER_READY: 0x10,
  STREAM_DELIVER: 0x11,
  ACK: 0x12,
  STREAM_DELETE: 0x13,
  STREAM_GONE: 0x14,
  KV_SET: 0x15,
  KV_GET: 0x16,
  KV_DELETE: 0x17,
  KV_KEYS: 0x18,
  KV_VALUE: 0x19,
  KV_KEYLIST: 0x1a,
  YARD_INFO: 0x1b,
  YARD_STATE: 0x1c,
  LANE_INFO: 0x1d,
  LANE_STATE: 0x1e,
  AUTHENTICATE: 0x1f,
  AUTH_OK: 0x20,
} as const;

export type Op = (typeof OP)[keyof typeof OP];

/** server speech — a client that sends one of these is killed (§2). */
export function isServerOnly(op: number): boolean {
  switch (op) {
    case OP.WELCOME:
    case OP.DELIVER:
    case OP.STREAM_READY:
    case OP.STREAM_RECEIPT:
    case OP.CONSUMER_READY:
    case OP.STREAM_DELIVER:
    case OP.STREAM_GONE:
    case OP.KV_VALUE:
    case OP.KV_KEYLIST:
    case OP.YARD_STATE:
    case OP.LANE_STATE:
    case OP.AUTH_OK:
      return true;
    default:
      return false;
  }
}

export function opName(op: number): string {
  for (const k of Object.keys(OP) as (keyof typeof OP)[]) {
    if (OP[k] === op) return k;
  }
  return `OP(0x${op.toString(16).toUpperCase()})`;
}

/* ---------- flag bits (§2 bodies; one convention, one bit 0) ---------- */

export const FLAG_REPLY_PRESENT = 0x01;
export const FLAG_FILTER_PRESENT = 0x02;
export const FLAG_KV_FOUND = 0x01;
export const FLAG_LANE_QUARANTINED = 0x01;
export const FLAG_CONSUMER_ATTACHED = 0x01;
export const FLAG_FATAL = 0x01;

/* ---------- caps (§7 table) ---------- */

export const MAX_SUBJECT = 255;
export const MAX_TOKEN_LENGTH = 64;
export const MAX_TOKEN_COUNT = 32;
export const MAX_REPLY = 255;
export const MAX_CLIENT_NAME = 64;
export const MAX_CLIENT_LABEL = 16;
export const MAX_SERVER_LABEL = 48;
export const MAX_LANE_NAME = 64;
export const MAX_KEY = 128;
export const MAX_AUTH_TOKEN = 256;

/* ---------- error codes (§6 table) ---------- */

export const ERR = {
  MALFORMED: 0x01,
  UNSUPPORTED_VERSION: 0x02,
  BAD_SUBJECT: 0x03,
  DUP_SUB: 0x04,
  NO_SUB: 0x05,
  TOO_LARGE: 0x06,
  SLOW_CONSUMER: 0x07,
  NOT_HANDSHAKED: 0x08,
  UNKNOWN_OP: 0x09,
  IDLE_TIMEOUT: 0x0a,
  STREAM_UNKNOWN: 0x0b,
  STREAM_EXISTS: 0x0c,
  BAD_STREAM_NAME: 0x0d,
  STREAM_SUBJECT: 0x0e,
  DUP_CONSUMER: 0x0f,
  NO_CONSUMER: 0x10,
  STREAM_DISABLED: 0x11,
  SERVER_FAULT: 0x12,
  BAD_KEY: 0x13,
  NOT_ALLOWED: 0x14,
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];

/** fatal by the §6 table — the frame is the last thing on the wire. */
export function errFatal(code: number): boolean {
  switch (code) {
    case ERR.MALFORMED:
    case ERR.UNSUPPORTED_VERSION:
    case ERR.SLOW_CONSUMER:
    case ERR.UNKNOWN_OP:
    case ERR.IDLE_TIMEOUT:
    case ERR.NOT_ALLOWED:
      return true;
    default:
      return false;
  }
}

export function errName(code: number): string {
  for (const k of Object.keys(ERR) as (keyof typeof ERR)[]) {
    if (ERR[k] === code) return k;
  }
  return `CODE(0x${code.toString(16).toUpperCase()})`;
}

/* ---------- the one error every refusal surfaces as ---------- */

export class WireError extends Error {
  readonly code: number;
  readonly fatal: boolean;
  readonly op?: number;

  constructor(code: number, fatal: boolean, message: string, op?: number) {
    super(
      `${errName(code)}${op !== undefined ? ` in ${opName(op)}` : ""}: ${message}`,
    );
    this.name = "WireError";
    this.code = code;
    this.fatal = fatal;
    this.op = op;
  }
}

/* ============================================================
   byte writer — sequential appends, big-endian everywhere (§1).
   ============================================================ */

export class ByteWriter {
  private out = new Uint8Array(64);
  private n = 0;

  private grow(need: number): void {
    if (this.n + need <= this.out.length) return;
    let cap = Math.max(this.out.length * 2, 64);
    while (cap < this.n + need) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(this.out.subarray(0, this.n), 0);
    this.out = bigger;
  }

  bytes(): Uint8Array {
    return this.out.slice(0, this.n);
  }

  u8(v: number): this {
    this.grow(1);
    this.out[this.n++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.grow(2);
    this.out[this.n++] = (v >>> 8) & 0xff;
    this.out[this.n++] = v & 0xff;
    return this;
  }

  u32(v: number): this {
    this.grow(4);
    this.out[this.n++] = (v >>> 24) & 0xff;
    this.out[this.n++] = (v >>> 16) & 0xff;
    this.out[this.n++] = (v >>> 8) & 0xff;
    this.out[this.n++] = v & 0xff;
    return this;
  }

  /** u64 as Number — yard sequences live far under 2^53. */
  u64(v: number): this {
    if (v < 0 || !Number.isSafeInteger(v)) {
      throw new WireError(ERR.MALFORMED, false, `u64 value ${v} is not a safe integer`);
    }
    this.u32(Math.floor(v / 2 ** 32));
    this.u32(v % 2 ** 32);
    return this;
  }

  /** object bytes (subjects/keys were build-validated already). */
  str(s: string): this {
    const n = s.length;
    this.grow(n);
    for (let i = 0; i < n; i++) {
      this.out[this.n++] = s.charCodeAt(i) & 0xff;
    }
    return this;
  }

  /** payload bytes — already validated for size by the caller. */
  data(b: Uint8Array): this {
    this.grow(b.length);
    this.out.set(b, this.n);
    this.n += b.length;
    return this;
  }
}

/* ============================================================
   byte reader — bounds-checked, offset-reporting (codec.go).
   Decode failures name the byte they gave up at.
   ============================================================ */

export class ByteReader {
  readonly buf: Uint8Array;
  readonly op?: number;
  private off = 0;

  constructor(buf: Uint8Array, op?: number) {
    this.buf = buf;
    this.op = op;
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }

  /** no trailing bytes — the codec validates shape only (codec.go). */
  exactEnd(): void {
    if (this.off !== this.buf.length) {
      throw new WireError(
        ERR.MALFORMED,
        false,
        `trailing bytes: ${this.remaining} unread at offset ${this.off}`,
        this.op,
      );
    }
  }

  u8(): number {
    if (this.remaining < 1) throw this.short("u8");
    return this.buf[this.off++];
  }

  u16(): number {
    if (this.remaining < 2) throw this.short("u16");
    const v = (this.buf[this.off] << 8) | this.buf[this.off + 1];
    this.off += 2;
    return v;
  }

  u32(): number {
    if (this.remaining < 4) throw this.short("u32");
    const v =
      this.buf[this.off] * 2 ** 24 +
      ((this.buf[this.off + 1] << 16) |
        (this.buf[this.off + 2] << 8) |
        this.buf[this.off + 3]);
    this.off += 4;
    return v;
  }

  u64(): number {
    if (this.remaining < 8) throw this.short("u64");
    const hi =
      this.buf[this.off] * 2 ** 24 +
      ((this.buf[this.off + 1] << 16) |
        (this.buf[this.off + 2] << 8) |
        this.buf[this.off + 3]);
    const lo =
      this.buf[this.off + 4] * 2 ** 24 +
      ((this.buf[this.off + 5] << 16) |
        (this.buf[this.off + 6] << 8) |
        this.buf[this.off + 7]);
    this.off += 8;
    const v = hi * 2 ** 32 + lo;
    if (!Number.isSafeInteger(v)) {
      throw new WireError(
        ERR.MALFORMED,
        false,
        `u64 > 2^53 at offset ${this.off - 8} — not a yard sequence`,
        this.op,
      );
    }
    return v;
  }

  /** u8 length prefix + bytes. */
  str8(label: string, max: number, min = 0): string {
    const n = this.u8();
    if (n < min || n > max) {
      throw new WireError(
        ERR.MALFORMED,
        false,
        `${label} ${n} bytes out of range [${min},${max}] at offset ${this.off - 1}`,
        this.op,
      );
    }
    return this.takeStr(n, label);
  }

  /** u16 length prefix + bytes — the family's common field. */
  str16(label: string, max: number, min = 0): string {
    const n = this.u16();
    if (n < min || n > max) {
      throw new WireError(
        ERR.MALFORMED,
        false,
        `${label} ${n} bytes out of range [${min},${max}] at offset ${this.off - 2}`,
        this.op,
      );
    }
    return this.takeStr(n, label);
  }

  bytes(n: number, label: string): Uint8Array {
    if (n < 0 || n > this.remaining) {
      throw this.short(`${label} payload of ${n}`);
    }
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  private takeStr(n: number, label: string): string {
    if (n > this.remaining) throw this.short(`${label} body of ${n}`);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.buf[this.off + i]);
    this.off += n;
    return s;
  }

  private short(what: string): WireError {
    return new WireError(
      ERR.MALFORMED,
      false,
      `body ends inside ${what} at offset ${this.off}`,
      this.op,
    );
  }
}

/* ============================================================
   the subject charter (§3)
   ============================================================ */

const assertToken = (token: string, op: number, pattern: boolean): void => {
  if (token.length < 1 || token.length > MAX_TOKEN_LENGTH) {
    throw new WireError(
      ERR.BAD_SUBJECT,
      false,
      `${pattern ? "pattern" : "subject"} token "${token}" ${token.length} bytes, want 1..${MAX_TOKEN_LENGTH}`,
      op,
    );
  }
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) {
      throw new WireError(
        ERR.BAD_SUBJECT,
        false,
        `${pattern ? "pattern" : "subject"} token "${token}" has byte 0x${c.toString(16)} off 0x21..0x7E`,
        op,
      );
    }
    if (c === 0x2e) {
      throw new WireError(
        ERR.BAD_SUBJECT,
        false,
        `token "${token}" contains the '.' separator`,
        op,
      );
    }
  }
};

const assertTokens = (subject: string, op: number): string[] => {
  if (subject.length < 1 || subject.length > MAX_SUBJECT) {
    throw new WireError(
      ERR.BAD_SUBJECT,
      false,
      `${subject.length} bytes total, want 1..${MAX_SUBJECT}`,
      op,
    );
  }
  const tokens = subject.split(".");
  if (tokens.length < 1 || tokens.length > MAX_TOKEN_COUNT) {
    throw new WireError(
      ERR.BAD_SUBJECT,
      false,
      `${tokens.length} tokens, want 1..${MAX_TOKEN_COUNT}`,
      op,
    );
  }
  return tokens;
};

/** §3 for a CONCRETE subject — a publish carrying a wildcard is refused. */
export function checkSubject(subject: string, op: number): string {
  for (const t of assertTokens(subject, op)) {
    assertToken(t, op, false);
    if (t === "*" || t === ">") {
      throw new WireError(
        ERR.BAD_SUBJECT,
        false,
        `wildcard "${t}" in a publish subject`,
        op,
      );
    }
  }
  return subject;
}

/** §3 for a PATTERN (subscribe / consumer filter). */
export function checkPattern(pattern: string, op: number): string {
  const tokens = assertTokens(pattern, op);
  for (let i = 0; i < tokens.length; i++) {
    assertToken(tokens[i], op, true);
    if (tokens[i] === ">" && i !== tokens.length - 1) {
      throw new WireError(
        ERR.BAD_SUBJECT,
        false,
        `">" matches the remaining tokens and must be the final token`,
        op,
      );
    }
  }
  return pattern;
}

/** does a concrete subject match a §3 wildcard pattern? byte-exact. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return i === p.length - 1 && s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return s.length === p.length;
}

/* ============================================================
   the frame writer (§1)
   ============================================================ */

const MAX_U32 = 0xffff_ffff;

export const EMPTY_BODY = new Uint8Array(0);

export function encodeFrame(op: number, body: Uint8Array): Uint8Array {
  if (body.length > MAX_BODY_BYTES) {
    throw new WireError(ERR.TOO_LARGE, false, `refusing to write ${body.length}-byte body`, op);
  }
  const out = new Uint8Array(HEADER_LEN + body.length);
  out[0] = MAGIC1;
  out[1] = MAGIC2;
  out[2] = VERSION;
  out[3] = op & 0xff;
  out[4] = (body.length >>> 24) & 0xff;
  out[5] = (body.length >>> 16) & 0xff;
  out[6] = (body.length >>> 8) & 0xff;
  out[7] = body.length & 0xff;
  out.set(body, HEADER_LEN);
  return out;
}

/* ============================================================
   op bodies — one encode/decode pair per op, the §2 tables.
   ============================================================ */

/* ---------- §2.1 / §2.2 handshake ---------- */

export interface Hello {
  readonly name: string; // display-only, 0..64
  readonly label: string; // client family tag, 0..16
}

export function encodeHello(h: Hello): Uint8Array {
  assertLen("hello name", h.name, 0, MAX_CLIENT_NAME);
  assertLen("hello label", h.label, 0, MAX_CLIENT_LABEL);
  return new ByteWriter()
    .u8(h.name.length).str(h.name)
    .u8(h.label.length).str(h.label)
    .bytes();
}

export function decodeHello(body: Uint8Array): Hello {
  const r = new ByteReader(body, OP.HELLO);
  const name = r.str8("name", MAX_CLIENT_NAME);
  const label = r.str8("label", MAX_CLIENT_LABEL);
  r.exactEnd();
  return { name, label };
}

export interface Welcome {
  readonly serverLabel: string; // e.g. "switchyard/1.0.0"
  readonly maxBody: number; // authoritative for this yard (§2.2)
}

export function encodeWelcome(w: Welcome): Uint8Array {
  assertLen("welcome label", w.serverLabel, 1, MAX_SERVER_LABEL);
  return new ByteWriter()
    .u16(w.serverLabel.length).str(w.serverLabel)
    .u32(w.maxBody)
    .bytes();
}

export function decodeWelcome(body: Uint8Array): Welcome {
  const r = new ByteReader(body, OP.WELCOME);
  const serverLabel = r.str16("serverLabel", MAX_SERVER_LABEL, 1);
  const maxBody = r.u32();
  r.exactEnd();
  return { serverLabel, maxBody };
}

function assertLen(label: string, s: string, min: number, max: number): void {
  if (s.length < min || s.length > max) {
    throw new WireError(
      ERR.MALFORMED,
      false,
      `${label} ${s.length} bytes out of range [${min},${max}]`,
    );
  }
}

/* ---------- publish-shaped bodies (§2.3, §2.6, §2.10, §2.14) ----------
   All four share the layout: u16 subjLen|subj | u8 flags |
   [u16 replyLen|reply] | u32 payloadLen|payload — plus their own
   identifying fields ahead of it. One builder keeps the four in step. */

const flagsByte = (reply?: string): number =>
  reply !== undefined ? FLAG_REPLY_PRESENT : 0;

const publishTail = (
  w: ByteWriter,
  reply: string | undefined,
  payload: Uint8Array,
): void => {
  w.u8(flagsByte(reply));
  if (reply !== undefined) {
    assertLen("reply", reply, 1, MAX_REPLY);
    w.u16(reply.length).str(reply);
  }
  w.u32(payload.length);
  w.data(payload);
};

/* ---------- §2.3 PUBLISH ---------- */
export interface PublishBody {
  readonly subject: string;
  readonly reply?: string;
  readonly payload: Uint8Array;
}

const subjectPayloadGuard = (
  subject: string,
  reply: string | undefined,
  payload: Uint8Array,
  op: number,
): void => {
  checkSubject(subject, op);
  // overhead: subjLen + subject + flags + payloadLen (u32) (+ reply)
  clockRoom(op, 2 + subject.length + 1 + 4 + (reply ? 2 + reply.length : 0), payload.length);
};

function clockRoom(op: number, overhead: number, payloadLen: number): void {
  const room = MAX_BODY_BYTES - overhead;
  if (payloadLen > room) {
    throw new WireError(
      ERR.TOO_LARGE,
      false,
      `payload ${payloadLen} B over frame room ${room} B`,
      op,
    );
  }
}

export function encodePublish(p: PublishBody): Uint8Array {
  subjectPayloadGuard(p.subject, p.reply, p.payload, OP.PUBLISH);
  const w = new ByteWriter();
  w.u16(p.subject.length).str(p.subject);
  publishTail(w, p.reply, p.payload);
  return w.bytes();
}

export function decodePublish(body: Uint8Array): PublishBody {
  const r = new ByteReader(body, OP.PUBLISH);
  const subject = r.str16("subject", MAX_SUBJECT, 1);
  const flags = r.u8();
  let reply: string | undefined;
  if (flags & FLAG_REPLY_PRESENT) reply = r.str16("reply", MAX_REPLY, 1);
  const payload = r.bytes(r.u32(), "payload");
  r.exactEnd();
  return { subject, reply, payload };
}

/* ---------- §2.6 DELIVER ---------- */

export interface DeliverBody {
  readonly subject: string;
  readonly sid: number;
  readonly seq: number; // per-sid, gapless from 1 (§4)
  readonly reply?: string;
  readonly payload: Uint8Array;
}

const assertSid = (sid: number, op: number): void => {
  if (sid < 1 || sid > MAX_U32 || !Number.isSafeInteger(sid)) {
    throw new WireError(ERR.MALFORMED, false, `sid ${sid} out of range [1,2^32-1]`, op);
  }
};

export function encodeDeliver(d: DeliverBody): Uint8Array {
  assertSid(d.sid, OP.DELIVER);
  subjectPayloadGuard(d.subject, d.reply, d.payload, OP.DELIVER);
  const w = new ByteWriter();
  w.u16(d.subject.length).str(d.subject);
  w.u32(d.sid);
  w.u32(d.seq);
  publishTail(w, d.reply, d.payload);
  return w.bytes();
}

export function decodeDeliver(body: Uint8Array): DeliverBody {
  const r = new ByteReader(body, OP.DELIVER);
  const subject = r.str16("subject", MAX_SUBJECT, 1);
  const sid = r.u32();
  const seq = r.u32();
  const flags = r.u8();
  let reply: string | undefined;
  if (flags & FLAG_REPLY_PRESENT) reply = r.str16("reply", MAX_REPLY, 1);
  const payload = r.bytes(r.u32(), "payload");
  r.exactEnd();
  return { subject, sid, seq, reply, payload };
}

/* ---------- §2.4 / §2.5 subscriptions ---------- */

export interface SubscribeBody {
  readonly pattern: string;
  readonly sid: number; // client-assigned, unique per session
}

export function encodeSubscribe(s: SubscribeBody): Uint8Array {
  checkPattern(s.pattern, OP.SUBSCRIBE);
  assertSid(s.sid, OP.SUBSCRIBE);
  return new ByteWriter().u16(s.pattern.length).str(s.pattern).u32(s.sid).bytes();
}

export function decodeSubscribe(body: Uint8Array): SubscribeBody {
  const r = new ByteReader(body, OP.SUBSCRIBE);
  const pattern = r.str16("pattern", MAX_SUBJECT, 1);
  const sid = r.u32();
  r.exactEnd();
  if (sid < 1 || sid > MAX_U32) {
    throw new WireError(ERR.MALFORMED, false, `sid ${sid} out of range`, OP.SUBSCRIBE);
  }
  return { pattern, sid };
}

export interface UnsubBody {
  readonly sid: number;
}

export function encodeUnsub(u: UnsubBody): Uint8Array {
  assertSid(u.sid, OP.UNSUB);
  return new ByteWriter().u32(u.sid).bytes();
}

export function decodeUnsub(body: Uint8Array): UnsubBody {
  const r = new ByteReader(body, OP.UNSUB);
  const sid = r.u32();
  r.exactEnd();
  return { sid };
}

/* ---------- §2.7 ERROR ---------- */

export interface ErrorBody {
  readonly code: number; // §6 table
  readonly message: string; // for humans; the code is the promise
  readonly fatal: boolean;
}

export function encodeError(e: ErrorBody): Uint8Array {
  // §2.7: the message truncates to 255, never fails and never lies
  const msg =
    e.message.length > MAX_SUBJECT ? e.message.slice(0, MAX_SUBJECT) : e.message;
  return new ByteWriter()
    .u8(e.code)
    .u16(msg.length).str(msg)
    .u8(e.fatal ? FLAG_FATAL : 0)
    .bytes();
}

export function decodeError(body: Uint8Array): ErrorBody {
  const r = new ByteReader(body, OP.ERROR);
  const code = r.u8();
  const message = r.str16("message", MAX_SUBJECT);
  const flags = r.u8();
  r.exactEnd();
  return { code, message, fatal: (flags & FLAG_FATAL) !== 0 };
}

/* ============================================================
   the durable lane family (§2.8–§2.17)
   ============================================================ */

/** §3.1 length half: names become directory names under the data dir. */
/** §3.1 length half: names become directory names, the yard owns charset.
    The name misfits refuse non-fatally so a fixed retry lands (§6). */
const assertLane = (name: string, _op: number, field: string): void => {
  if (name.length < 1 || name.length > MAX_LANE_NAME) {
    throw new WireError(
      ERR.BAD_STREAM_NAME,
      false,
      `${field} ${name.length} bytes out of range [1,${MAX_LANE_NAME}]`,
    );
  }
};

function appendStr16(s: string, w: ByteWriter): void {
  w.u16(s.length).str(s);
}

/* ---------- §2.8 / §2.9 create & ready ---------- */

export interface StreamName {
  readonly lane: string;
}

export function encodeStreamCreate(c: StreamName): Uint8Array {
  assertLane(c.lane, OP.STREAM_CREATE, "lane name");
  return new ByteWriter().u16(c.lane.length).str(c.lane).bytes();
}

export function decodeStreamCreate(body: Uint8Array): StreamName {
  const r = new ByteReader(body, OP.STREAM_CREATE);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  r.exactEnd();
  return { lane };
}

export interface StreamReadyBody {
  readonly lane: string;
  readonly seq: number; // the next number the lane will assign (§2.9)
}

export function encodeStreamReady(s: StreamReadyBody): Uint8Array {
  assertLane(s.lane, OP.STREAM_READY, "lane name");
  return new ByteWriter()
    .u16(s.lane.length).str(s.lane)
    .u64(s.seq)
    .bytes();
}

export function decodeStreamReady(body: Uint8Array): StreamReadyBody {
  const r = new ByteReader(body, OP.STREAM_READY);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const seq = r.u64();
  r.exactEnd();
  return { lane, seq };
}

/* ---------- §2.10 / §2.11 lane publish & receipt ---------- */

export interface StreamPublishBody {
  readonly lane: string;
  readonly subject: string; // first token must equal the lane (§2.10)
  readonly reply?: string;
  readonly payload: Uint8Array;
}

/** the subject-rides-the-lane rule (§2.10) — server-side for the yard,
    refused where it originates here so the refusal names the caller. */
export function subjectRidesLane(lane: string, subject: string): boolean {
  return subject.split(".")[0] === lane;
}

export function encodeStreamPublish(p: StreamPublishBody): Uint8Array {
  assertLane(p.lane, OP.STREAM_PUBLISH, "lane name");
  checkSubject(p.subject, OP.STREAM_PUBLISH);
  if (!subjectRidesLane(p.lane, p.subject)) {
    throw new WireError(
      ERR.STREAM_SUBJECT,
      false,
      `subject "${p.subject}" does not ride lane "${p.lane}"`,
      OP.STREAM_PUBLISH,
    );
  }
  subjectPayloadGuard(p.subject, p.reply, p.payload, OP.STREAM_PUBLISH);
  const w = new ByteWriter();
  appendStr16(p.lane, w);
  w.u16(p.subject.length).str(p.subject);
  publishTail(w, p.reply, p.payload);
  return w.bytes();
}

export function decodeStreamPublish(body: Uint8Array): StreamPublishBody {
  const r = new ByteReader(body, OP.STREAM_PUBLISH);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const subject = r.str16("subject", MAX_SUBJECT, 1);
  const flags = r.u8();
  let reply: string | undefined;
  if (flags & FLAG_REPLY_PRESENT) reply = r.str16("reply", MAX_REPLY, 1);
  const payload = r.bytes(r.u32(), "payload");
  r.exactEnd();
  return { lane, subject, reply, payload };
}

export interface StreamReceiptBody {
  readonly lane: string;
  readonly seq: number; // the journal write this receipt confirms (§2.11)
}

export function encodeStreamReceipt(s: StreamReceiptBody): Uint8Array {
  assertLane(s.lane, OP.STREAM_RECEIPT, "lane name");
  return new ByteWriter().u16(s.lane.length).str(s.lane).u64(s.seq).bytes();
}

export function decodeStreamReceipt(body: Uint8Array): StreamReceiptBody {
  const r = new ByteReader(body, OP.STREAM_RECEIPT);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const seq = r.u64();
  r.exactEnd();
  return { lane, seq };
}

/* ---------- §2.12 / §2.13 / §2.14 consumers ---------- */

export interface ConsumerAttachBody {
  readonly lane: string;
  readonly consumer: string;
  readonly filter?: string;
  readonly sid: number;
  readonly ackWaitMillis: number; // 0 = yard default (§7: 10 s)
}

export function encodeConsumerAttach(a: ConsumerAttachBody): Uint8Array {
  assertLane(a.lane, OP.CONSUMER_ATTACH, "lane name");
  assertLane(a.consumer, OP.CONSUMER_ATTACH, "consumer name");
  assertSid(a.sid, OP.CONSUMER_ATTACH);
  if (a.filter !== undefined) {
    checkPattern(a.filter, OP.CONSUMER_ATTACH);
  }
  const w = new ByteWriter();
  appendStr16(a.lane, w);
  appendStr16(a.consumer, w);
  w.u8(a.filter !== undefined ? FLAG_FILTER_PRESENT : 0);
  if (a.filter !== undefined) {
    w.u16(a.filter.length).str(a.filter);
  }
  w.u32(a.sid);
  w.u32(a.ackWaitMillis >>> 0);
  return w.bytes();
}

export function decodeConsumerAttach(body: Uint8Array): ConsumerAttachBody {
  const r = new ByteReader(body, OP.CONSUMER_ATTACH);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const consumer = r.str16("consumer", MAX_LANE_NAME, 1);
  const flags = r.u8();
  let filter: string | undefined;
  if (flags & FLAG_FILTER_PRESENT) filter = r.str16("filter", MAX_SUBJECT, 1);
  const sid = r.u32();
  const ackWait = r.u32();
  r.exactEnd();
  if (sid < 1 || sid > MAX_U32) {
    throw new WireError(ERR.MALFORMED, false, `sid ${sid} out of range`, OP.CONSUMER_ATTACH);
  }
  return { lane, consumer, filter, sid, ackWaitMillis: ackWait };
}

export interface ConsumerReadyBody {
  readonly lane: string;
  readonly consumer: string;
  readonly sid: number;
  readonly next: number; // first sequence the consumer will receive (§2.13)
  readonly ackWaitMillis: number; // the effective value in force (echo)
}

export function encodeConsumerReady(b: ConsumerReadyBody): Uint8Array {
  assertLane(b.lane, OP.CONSUMER_READY, "lane name");
  assertLane(b.consumer, OP.CONSUMER_READY, "consumer name");
  assertSid(b.sid, OP.CONSUMER_READY);
  return new ByteWriter()
    .u16(b.lane.length).str(b.lane)
    .u16(b.consumer.length).str(b.consumer)
    .u32(b.sid)
    .u64(b.next)
    .u32(b.ackWaitMillis >>> 0)
    .bytes();
}

export function decodeConsumerReady(body: Uint8Array): ConsumerReadyBody {
  const r = new ByteReader(body, OP.CONSUMER_READY);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const consumer = r.str16("consumer", MAX_LANE_NAME, 1);
  const sid = r.u32();
  const next = r.u64();
  const ackWait = r.u32();
  r.exactEnd();
  return { lane, consumer, sid, next, ackWaitMillis: ackWait };
}

export interface LaneDelivery {
  readonly subject: string;
  readonly sid: number;
  readonly seq: number; // the LANE's sequence — shared by every consumer (§2.14)
  readonly reply?: string;
  readonly payload: Uint8Array;
}

export function encodeLaneDeliver(d: LaneDelivery): Uint8Array {
  assertSid(d.sid, OP.STREAM_DELIVER);
  subjectPayloadGuard(d.subject, d.reply, d.payload, OP.STREAM_DELIVER);
  const w = new ByteWriter();
  w.u16(d.subject.length).str(d.subject);
  w.u32(d.sid);
  w.u64(d.seq);
  publishTail(w, d.reply, d.payload);
  return w.bytes();
}

export function decodeLaneDeliver(body: Uint8Array): LaneDelivery {
  const r = new ByteReader(body, OP.STREAM_DELIVER);
  const subject = r.str16("subject", MAX_SUBJECT, 1);
  const sid = r.u32();
  const seq = r.u64();
  const flags = r.u8();
  let reply: string | undefined;
  if (flags & FLAG_REPLY_PRESENT) reply = r.str16("reply", MAX_REPLY, 1);
  const payload = r.bytes(r.u32(), "payload");
  r.exactEnd();
  return { subject, sid, seq, reply, payload };
}

/* ---------- §2.15 ACK ---------- */

export interface Ack {
  readonly sid: number;
  readonly seq: number; // one lane sequence per ack, contiguous floors (§2.15)
}

export function encodeAck(a: Ack): Uint8Array {
  assertSid(a.sid, OP.ACK);
  return new ByteWriter().u32(a.sid).u64(a.seq).bytes();
}

export function decodeAck(body: Uint8Array): Ack {
  const r = new ByteReader(body, OP.ACK);
  const sid = r.u32();
  const seq = r.u64();
  r.exactEnd();
  return { sid, seq };
}

/* ---------- §2.16 / §2.17 delete & gone ---------- */

export interface StreamDeleteBody {
  readonly lane: string;
}

export function encodeStreamDelete(d: StreamDeleteBody): Uint8Array {
  assertLane(d.lane, OP.STREAM_DELETE, "lane name");
  return new ByteWriter().u16(d.lane.length).str(d.lane).bytes();
}

export function decodeStreamDelete(body: Uint8Array): StreamDeleteBody {
  const r = new ByteReader(body, OP.STREAM_DELETE);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  r.exactEnd();
  return { lane };
}

export function encodeStreamGone(g: StreamDeleteBody): Uint8Array {
  assertLane(g.lane, OP.STREAM_GONE, "lane name");
  return new ByteWriter().u16(g.lane.length).str(g.lane).bytes();
}

export function decodeStreamGone(body: Uint8Array): StreamDeleteBody {
  const r = new ByteReader(body, OP.STREAM_GONE);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  r.exactEnd();
  return { lane };
}

/* ============================================================
   the KV family (§2.18–§2.23)
   ============================================================ */

/** §3.2 length half: see kvKey() in codec_kv.go — BAD_KEY, non-fatal. */
const assertKey = (key: string, _op: number): void => {
  if (key.length < 1 || key.length > MAX_KEY) {
    throw new WireError(
      ERR.BAD_KEY,
      false,
      `key ${key.length} bytes out of range [1,${MAX_KEY}]`,
    );
  }
};

const encodeLaneKey = (lane: string, key: string): ByteWriter =>
  new ByteWriter().u16(lane.length).str(lane).u16(key.length).str(key);

export interface KVSet {
  readonly lane: string;
  readonly key: string;
  readonly payload: Uint8Array;
}

/** KV_SET: rides the same lane sequence space; the receipt is §2.11's (§2.18). */
export function encodeKVSet(s: KVSet): Uint8Array {
  assertLane(s.lane, OP.KV_SET, "lane name");
  assertKey(s.key, OP.KV_SET);
  clockRoom(OP.KV_SET, 2 + s.lane.length + 2 + s.key.length + 4, s.payload.length);
  return encodeLaneKey(s.lane, s.key).u32(s.payload.length).data(s.payload).bytes();
}

export interface KVPointer {
  readonly lane: string;
  readonly key: string;
}

export function encodeKVGet(g: KVPointer): Uint8Array {
  assertLane(g.lane, OP.KV_GET, "lane name");
  assertKey(g.key, OP.KV_GET);
  return encodeLaneKey(g.lane, g.key).bytes();
}

export function encodeKVDelete(d: KVPointer): Uint8Array {
  assertLane(d.lane, OP.KV_DELETE, "lane name");
  assertKey(d.key, OP.KV_DELETE);
  return encodeLaneKey(d.lane, d.key).bytes();
}

export function encodeKVKeys(lane: string): Uint8Array {
  assertLane(lane, OP.KV_KEYS, "lane name");
  return new ByteWriter().u16(lane.length).str(lane).bytes();
}

export interface KVValue {
  readonly lane: string;
  readonly key: string;
  readonly seq: number; // the set that wrote this value; 0 when not found
  readonly found: boolean;
  readonly payload?: Uint8Array; // rides only when FOUND — flag, not length, is truth
}

export function encodeKVValue(v: KVValue): Uint8Array {
  assertLane(v.lane, OP.KV_VALUE, "lane name");
  assertKey(v.key, OP.KV_VALUE);
  if (!v.found && v.seq !== 0) {
    throw new WireError(ERR.MALFORMED, false, "not-found carries seq 0", OP.KV_VALUE);
  }
  const w = encodeLaneKey(v.lane, v.key);
  w.u64(v.found ? v.seq : 0);
  w.u8(v.found ? FLAG_KV_FOUND : 0);
  if (v.found) {
    w.u32(v.payload?.length ?? 0);
    if (v.payload) w.data(v.payload);
  }
  return w.bytes();
}

export function decodeKVValue(body: Uint8Array): KVValue {
  const r = new ByteReader(body, OP.KV_VALUE);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const key = r.str16("key", MAX_KEY, 1);
  const seq = r.u64();
  const flags = r.u8();
  const found = (flags & FLAG_KV_FOUND) !== 0;
  let payload: Uint8Array | undefined;
  if (found) {
    payload = r.bytes(r.u32(), "payload");
  }
  r.exactEnd();
  return { lane, key, seq: found ? seq : 0, found, payload };
}

export interface KVKeyList {
  readonly lane: string;
  readonly keys: readonly string[]; // ascending bytewise, tombstones out (§2.23)
}

export function encodeKVKeyList(k: KVKeyList): Uint8Array {
  assertLane(k.lane, OP.KV_KEYLIST, "lane name");
  if (k.keys.length > 0xffff) {
    throw new WireError(ERR.TOO_LARGE, false, "u16 count overrun", OP.KV_KEYLIST);
  }
  const w = new ByteWriter();
  w.u16(k.lane.length).str(k.lane);
  w.u16(k.keys.length);
  keysAscending(k.keys).forEach((key) => {
    assertKey(key, OP.KV_KEYLIST);
    w.u16(key.length).str(key);
  });
  return w.bytes();
}

export function decodeKVKeyListBody(body: Uint8Array): KVKeyList {
  const r = new ByteReader(body, OP.KV_KEYLIST);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const count = r.u16();
  const keys: string[] = [];
  for (let i = 0; i < count; i++) keys.push(r.str16("key", MAX_KEY, 1));
  r.exactEnd();
  return { lane, keys: keysAscending(keys) };
}

export function keysAscending(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/* ============================================================
   the console family (§2.24–§2.27)
   ============================================================ */

/** §2.26 LANE_INFO: u16 laneLen|lane alone — the drill-down ask. */
export interface LaneInfoBody {
  readonly lane: string;
}

export function encodeLaneInfo(l: LaneInfoBody): Uint8Array {
  assertLane(l.lane, OP.LANE_INFO, "lane name");
  return new ByteWriter().u16(l.lane.length).str(l.lane).bytes();
}

export function decodeLaneInfo(body: Uint8Array): LaneInfoBody {
  const r = new ByteReader(body, OP.LANE_INFO);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  r.exactEnd();
  return { lane };
}

export interface YardLaneRow {
  readonly lane: string;
  readonly seq: number; // last journaled sequence; 0 for no rows yet
}

export interface YardStateBody {
  readonly version: string; // 1..32
  readonly uptimeSec: number;
  readonly sessions: number;
  readonly lanes: readonly YardLaneRow[]; // ascending bytewise
  readonly quarantined: readonly string[]; // named in full (§2.25)
}

export function encodeYardState(y: YardStateBody): Uint8Array {
  assertLen("yard version", y.version, 1, 32);
  const w = new ByteWriter();
  w.u16(y.version.length).str(y.version);
  w.u64(y.uptimeSec);
  w.u32(y.sessions);
  w.u16(y.lanes.length);
  for (const row of y.lanes) {
    assertLane(row.lane, OP.YARD_STATE, "yard lane");
    w.u16(row.lane.length).str(row.lane);
    w.u64(row.seq);
  }
  w.u16(y.quarantined.length);
  for (const lane of y.quarantined) {
    assertLane(lane, OP.YARD_STATE, "quarantined lane");
    w.u16(lane.length).str(lane);
  }
  return w.bytes();
}

export function decodeYardState(body: Uint8Array): YardStateBody {
  const r = new ByteReader(body, OP.YARD_STATE);
  const version = r.str16("version", 32, 1);
  const uptimeSec = r.u64();
  const sessions = r.u32();
  const laneCount = r.u16();
  const lanes: YardLaneRow[] = [];
  for (let i = 0; i < laneCount; i++) {
    const lane = r.str16("lane", MAX_LANE_NAME, 1);
    lanes.push({ lane, seq: r.u64() });
  }
  const qCount = r.u16();
  const quarantined: string[] = [];
  for (let i = 0; i < qCount; i++) {
    quarantined.push(r.str16("quarantined", MAX_LANE_NAME, 1));
  }
  r.exactEnd();
  return { version, uptimeSec, sessions, lanes, quarantined };
}

export interface LaneConsumerRow {
  readonly name: string;
  readonly floor: number; // highest sequence fully acknowledged — resume floor
  readonly pending: number; // delivered-but-not-acked rows right now
  readonly attached: boolean;
}

export interface LaneStateBody {
  readonly lane: string;
  readonly seq: number;
  readonly quarantined: boolean; // writes failed once; refuses until restart (§9)
  readonly journalBytes: number;
  readonly keyCount: number; // live keys, tombstones subtracted
  readonly consumers: readonly LaneConsumerRow[]; // ascending by name (§2.27)
}

export function encodeLaneState(l: LaneStateBody): Uint8Array {
  assertLane(l.lane, OP.LANE_STATE, "lane name");
  const w = new ByteWriter();
  w.u16(l.lane.length).str(l.lane);
  w.u64(l.seq);
  w.u8(l.quarantined ? FLAG_LANE_QUARANTINED : 0);
  w.u64(l.journalBytes);
  w.u32(l.keyCount);
  w.u16(l.consumers.length);
  for (const c of l.consumers) {
    assertLane(c.name, OP.LANE_STATE, "consumer name");
    w.u16(c.name.length).str(c.name);
    w.u64(c.floor);
    w.u32(c.pending);
    w.u8(c.attached ? FLAG_CONSUMER_ATTACHED : 0);
  }
  return w.bytes();
}

export function decodeLaneState(body: Uint8Array): LaneStateBody {
  const r = new ByteReader(body, OP.LANE_STATE);
  const lane = r.str16("lane", MAX_LANE_NAME, 1);
  const seq = r.u64();
  const flags = r.u8();
  const journalBytes = r.u64();
  const keyCount = r.u32();
  const count = r.u16();
  const consumers: LaneConsumerRow[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.str16("consumer", MAX_LANE_NAME, 1);
    const floor = r.u64();
    const pending = r.u32();
    const cFlags = r.u8();
    consumers.push({
      name,
      floor,
      pending,
      attached: (cFlags & FLAG_CONSUMER_ATTACHED) !== 0,
    });
  }
  r.exactEnd();
  return {
    lane,
    seq,
    quarantined: (flags & FLAG_LANE_QUARANTINED) !== 0,
    journalBytes,
    keyCount,
    consumers,
  };
}

/* ============================================================
   the auth pair (§2.28–§2.29)
   ============================================================ */

export interface Authenticate {
  readonly token: string; // 1..256 — the gate's password (§2.28)
}

export function encodeAuthenticate(a: Authenticate): Uint8Array {
  assertLen("auth token", a.token, 1, MAX_AUTH_TOKEN);
  return new ByteWriter().u16(a.token.length).str(a.token).bytes();
}

/* ============================================================
   the reader (§1 + §7): one frame at a time, the skip rule attached.

   A reader that sees wrong magic stops trusting byte offsets and closes
   fatal — there is no resync, the offset is unknowable after a desync.
   Wrong version: fatal UNSUPPORTED_VERSION. A declared body above the
   negotiated ceiling but within the protocol ceiling: discard exactly
   bodyLen bytes, keep framing, answer TOO_LARGE non-fatally (skip rule).
   Above the protocol ceiling: fatal — the offset is beyond trust.
   ============================================================ */

export interface WireFrame {
  readonly op: number;
  readonly body: Uint8Array; // empty when `skipped`
  readonly skipped: boolean; // the §7 skip: head consumed exactly
}

export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);
  private start = 0;

  softMax: number; // narrowed once WELCOME's maxBody lands

  constructor(softMax: number = YARD_MAX_BODY) {
    this.softMax = Math.min(softMax, MAX_BODY_BYTES);
  }

  /** length cap sanity: a client that hasn't seen WELCOME yet defaults
      to the yard default (§7), then upgrades once WELCOME lands. */
  setSoftMax(max: number): void {
    this.softMax = Math.min(max, MAX_BODY_BYTES);
  }

  feed(chunk: Uint8Array): void {
    if (this.start === this.buf.length) {
      this.buf = chunk.slice();
      this.start = 0;
      return;
    }
    if (chunk.length === 0) return;
    const tail = new Uint8Array(this.buf.length - this.start + chunk.length);
    tail.set(this.buf.subarray(this.start), 0);
    tail.set(chunk, this.buf.length - this.start);
    this.buf = tail;
    this.start = 0;
  }

  next(): WireFrame | null {
    if (this.buf.length - this.start < HEADER_LEN) return null;
    const h = this.buf;
    if (h[this.start] !== MAGIC1 || h[this.start + 1] !== MAGIC2) {
      throw new WireError(
        ERR.MALFORMED,
        true,
        `bad magic 0x${h[this.start].toString(16)} 0x${h[this.start + 1].toString(16)} at offset ${this.start}`,
      );
    }
    if (h[this.start + 2] !== VERSION) {
      throw new WireError(
        ERR.UNSUPPORTED_VERSION,
        true,
        `frame says version ${h[this.start + 2]}, mine is ${VERSION}`,
      );
    }
    const op = h[this.start + 3];
    const bodyLen =
      h[this.start + 4] * 2 ** 24 +
      ((h[this.start + 5] << 16) | (h[this.start + 6] << 8) | h[this.start + 7]);
    if (bodyLen > MAX_BODY_BYTES) {
      throw new WireError(
        ERR.TOO_LARGE,
        true,
        `frame declares ${bodyLen}-byte body, protocol ceiling is ${MAX_BODY_BYTES}`,
      );
    }
    const total = HEADER_LEN + bodyLen;
    if (this.buf.length - this.start < total) return null; // wait for the rest
    const bodyStart = this.start + HEADER_LEN;
    const bodyEnd = bodyStart + bodyLen;
    if (bodyLen > this.softMax) {
      // §7 skip rule: the next frame arrives on a clean offset because
      // the skip consumed exactly bodyLen declared bytes.
      this.start = bodyEnd;
      return { op, body: EMPTY_BODY, skipped: true };
    }
    const body = this.buf.slice(bodyStart, bodyEnd);
    this.start = bodyEnd;
    if (this.start > 4096) this.compact();
    return { op, body, skipped: false };
  }

  /** drop consumed bytes so a long session doesn't grow unbounded. */
  compact(): void {
    if (this.start === 0) return;
    if (this.start >= this.buf.length) {
      this.buf = new Uint8Array(0);
      this.start = 0;
      return;
    }
    this.buf = this.buf.slice(this.start);
    this.start = 0;
  }
}

/* ============================================================
   golden helpers — hex views the tests assert against.
   ============================================================ */

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export const fromHex = (s: string): Uint8Array => {
  const clean = s.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
