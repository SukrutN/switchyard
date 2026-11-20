/* ============================================================
   spur â€” a live Switchyard session in TypeScript.

   The mirror of `internal/client`: dial, knock, hello, then the
   whole Â§2 surface. Same discipline the reference client walks:

   Â· SUBSCRIBE, PUBLISH, and lane ACK carry no ack inside the
     wire; refusals arrive as ERROR frames on the error route,
     and fire-and-forget frames write straight through.
   Â· The synchronous pairs â€” PINGâ†’PONG, WELCOME, AUTH_OK, and
     the lane family's READY/RECEIPT/GONE/VALUE/KEYLIST/STATE â€”
     are round-trips that take turns, one at a time (the writer
     mutex in client.go, translated to one chained promise). The
     reply's waiter is registered before the request's bytes hit
     the socket, so no reply can arrive without a holder.
   Â· A non-fatal ERROR that lands while a round-trip holds the
     slot pairs with that round-trip AND surfaces on the error
     route â€” pairing without silently dropping (client.go).
   Â· Deliveries (DELIVER, STREAM_DELIVER) push to the handler
     registered per sid; they interleave between round-trips.
   Â· Keepalive (opts): a session silent for keepAliveMs pings
     once; silent past graceMs with no PONG kills the session
     (the client-side mirror of Â§5's idle law).

   Zero runtime deps beyond node:net / node:tls. The model yard
   (`modelyard.ts`) keeps the tests broker-less; THIS is the file
   that talks to the real Go yard.
   ============================================================ */

import { connect as tcpConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import * as w from "./wire.ts";

export interface SpurOptions {
  /** display-only handshake name (Â§2.1) â€” the yard's logs */
  name?: string;
  /** client family tag (Â§2.1, e.g. "ts-wes") */
  label?: string;
  /** Â§2.28 gate token â€” spoken before HELLO, inside TLS when one runs */
  token?: string;
  /** wrap the transport (Â§1: same frames, same layouts, nothing below knows) */
  tls?: boolean;
  /** self-signed lab certificates (spur's `-insecure` â€” a lab tool) */
  insecure?: boolean;
  /** SNI override for TLS. */
  serverName?: string;
  /** read-idle probe (Â§5 mirrored client-side); 0 = off (default) */
  keepAliveMs?: number;
  /** grace after the probe before declaring the session dead */
  graceMs?: number;
  /** the error route: every refusal, paired or not */
  onError?: (e: w.WireError) => void;
  /** session ended (gracefully or not); carries the first reason */
  onClosed?: (err: Error | undefined) => void;
}

export const DEFAULT_LABEL = "ts-wes";

/** the session ended promise surface â€” the spur's Done() mirror. */
export class SessionClosed extends Error {
  readonly reason: Error | undefined;

  constructor(reason: Error | undefined) {
    super(
      "session closed" + (reason ? `: ${reason.message}` : " (graceful)"),
    );
    this.name = "SessionClosed";
    this.reason = reason;
  }
}

/** one delivery on a plain spur subscription (Â§2.6). */
export type SubHandler = (d: w.DeliverBody) => void;

/** one delivery on a lane consumer (Â§2.14). */
export type ConsumerHandler = (d: w.LaneDelivery) => void;

interface RpcWaiter {
  /** the reply op that settles this round-trip */
  want: number;
  taken: boolean; // one-shot pairing
  resolve: (frame: w.WireFrame) => void;
  reject: (err: Error) => void;
}

interface PingWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class Spur {
  readonly host: string;
  readonly port: number;
  private opts: SpurOptions;
  private socket: ReturnType<typeof tcpConnect> | null = null;
  private reader = new w.FrameReader();
  private maxBody = w.YARD_MAX_BODY;

  private rpc: RpcWaiter | null = null;
  private pingWait: PingWaiter | null = null;
  private pinging = false;
  private lastPingAt = 0;
  private lastIn = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  private subHandlers = new Map<number, SubHandler>();
  private consumerHandlers = new Map<number, ConsumerHandler>();

  private nextSid = 1;
  private closed = false;
  private closeErr: Error | undefined;
  private closingBye = false;
  private closedCbs = new Set<() => void>();

  /** round-trips queue behind this chain â€” turn-taking without a mutex */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(host: string, port: number, opts: SpurOptions = {}) {
    this.host = host;
    this.port = port;
    this.opts = opts;
  }

  /* ============================================================
     session lifecycle
     ============================================================ */

  async open(): Promise<w.Welcome> {
    const conn = new Promise<ReturnType<typeof tcpConnect>>((resolve, reject) => {
      let sock: ReturnType<typeof tcpConnect>;
      const fail = (e: Error) => reject(e);
      if (this.opts.tls) {
        sock = tlsConnect({
          host: this.host,
          port: this.port,
          rejectUnauthorized: !this.opts.insecure,
          ...(this.opts.serverName ? { servername: this.opts.serverName } : {}),
        });
      } else {
        sock = tcpConnect({ host: this.host, port: this.port });
      }
      sock.once("error", fail);
      sock.once("connect", () => {
        sock.off("error", fail);
        resolve(sock);
      });
    });
    const sock = await conn;
    this.socket = sock;
    sock.setNoDelay(true);
    sock.on("data", (chunk: Buffer) => {
      this.feed(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    sock.once("close", () => {
      if (this.closingBye) this.die(undefined, true);
      else this.die(new Error("connection closed"), false);
    });
    sock.once("end", () => {
      if (this.closingBye) this.die(undefined, true);
      else this.die(new Error("connection ended"), false);
    });
    sock.on("error", (e) => this.die(e, false));

    if (this.opts.token) {
      // the door is behind the client after HELLO â€” the token is Â§2.28's,
      // spoken before the handshake, fatal NOT_ALLOWED otherwise.
      await this.rpcRound(
        w.OP.AUTHENTICATE,
        w.encodeAuthenticate({ token: this.opts.token }),
        () => undefined,
      );
    }
    await this.helloCall();
    this.reader.setSoftMax(this.maxBody);
    this.armKeepalive();
    return this.welcome!;
  }

  /** the handshake (Â§2.1â†’Â§2.2); WELCOME's maxBody is now authoritative. */
  private async helloCall(): Promise<w.Welcome> {
    this.welcome = await this.rpcRound(
      w.OP.HELLO,
      w.encodeHello({ name: this.opts.name ?? "", label: this.opts.label ?? DEFAULT_LABEL }),
      w.decodeWelcome,
    );
    this.maxBody = this.welcome.maxBody;
    return this.welcome;
  }

  private welcome: w.Welcome | null = null;

  get maxBodyBytes(): number {
    return this.maxBody;
  }

  get yardLabel(): string | undefined {
    return this.welcome?.serverLabel;
  }

  /** grace close: BYE, flush, end. */
  bye(): Promise<void> {
    if (this.closed || !this.socket) return Promise.resolve();
    this.closingBye = true;
    return new Promise((resolve) => {
      this.socket!.end(w.encodeFrame(w.OP.BYE, w.EMPTY_BODY), () => resolve());
    });
  }

  destroy(): void {
    this.die(new Error("destroyed"), false);
  }

  /** resolves when the session ends. */
  done(): Promise<void> {
    if (this.closed) {
      return this.closeErr ? Promise.reject(this.closeErr) : Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.closedCbs.add(() => (this.closeErr ? reject(this.closeErr) : resolve()));
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private socketwrite(bytes: Uint8Array): void {
    try {
      this.socket?.write(bytes);
    } catch (e) {
      this.die(e as Error, false);
    }
  }

  private die(err: Error | undefined, graceful: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.closeErr = graceful || !err ? undefined : err;
    this.disarmKeepalive();
    if (this.rpc) {
      const holder = this.rpc;
      this.rpc = null;
      holder.reject(new SessionClosed(err));
    }
    if (this.pingWait) {
      const p = this.pingWait;
      this.pingWait = null;
      p.reject(new SessionClosed(err));
    }
    try {
      this.socket?.destroy();
    } catch {
      // dead sockets give no quarter
    }
    this.socket = null;
    try {
      this.opts.onClosed?.(err);
    } catch {
      // listener bugs die with the caller, not the session
    }
    for (const cb of this.closedCbs) {
      try {
        cb();
      } catch {
        // as above
      }
    }
    this.closedCbs.clear();
  }

  private kill(werr: w.WireError): void {
    // a fatal frame is the last thing on the wire (Â§5)
    this.die(werr, false);
  }

  /* ============================================================
     the read side
     ============================================================ */

  private feed(chunk: Uint8Array): void {
    this.lastIn = Date.now();
    this.reader.feed(chunk);
    try {
      for (;;) {
        const frame = this.reader.next();
        if (!frame) return;
        this.dispatch(frame);
        if (this.closed) return;
      }
    } catch (e) {
      this.kill(e as w.WireError);
    }
  }

  private dispatch(frame: w.WireFrame): void {
    const op = frame.op;
    switch (op) {
      case w.OP.WELCOME: {
        this.settle(w.OP.WELCOME, frame);
        return;
      }
      case w.OP.PONG: {
        this.pinging = false;
        if (this.pingWait) {
          const p = this.pingWait;
          this.pingWait = null;
          p.resolve();
        }
        return;
      }
      case w.OP.DELIVER: {
        const d = w.decodeDeliver(frame.body);
        const h = this.subHandlers.get(d.sid);
        if (h) this.safe(() => h(d));
        return;
      }
      case w.OP.STREAM_DELIVER: {
        const d = w.decodeLaneDeliver(frame.body);
        const h = this.consumerHandlers.get(d.sid);
        if (h) this.safe(() => h(d));
        return;
      }
      case w.OP.ERROR: {
        const e = w.decodeError(frame.body);
        const werr = new w.WireError(e.code, e.fatal, e.message, undefined);
        if (werr.fatal) {
          this.kill(werr);
          return;
        }
        // pairing: the refusal joins the round-trip that could have
        // caused it (client.go) and also rides the error route.
        const holder = this.rpc;
        if (holder && !holder.taken) {
          holder.taken = true;
          this.rpc = null;
          holder.reject(werr);
        }
        this.safe(() => this.opts.onError?.(werr));
        return;
      }
      case w.OP.BYE: {
        this.die(undefined, true);
        return;
      }
      default: {
        if (w.isServerOnly(op)) {
          this.settle(op, frame);
          return;
        }
        // unknown client op code (Â§2: fatal)
        this.kill(new w.WireError(w.ERR.UNKNOWN_OP, true, `op 0x${op.toString(16)}`));
        return;
      }
    }
  }

  /** settle a server frame into the waiting round-trip, or refuse it. */
  private settle(want: number, frame: w.WireFrame): void {
    const holder = this.rpc;
    if (holder && !holder.taken && holder.want === want) {
      holder.taken = true;
      this.rpc = null;
      holder.resolve(frame);
      return;
    }
    this.kill(
      new w.WireError(
        w.ERR.MALFORMED,
        true,
        `unexpected ${w.opName(want)} (turn: ${this.rpc ? w.opName(this.rpc.want) : "none"})`,
      ),
    );
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // a handler's mistakes belong to its caller, not the line
    }
  }

  /* ============================================================
     the round-trip discipline (client.go's turn-taking)
     ============================================================ */

  private async rpcRound<T>(
    op: number,
    body: Uint8Array,
    decode: (b: Uint8Array) => T,
  ): Promise<T> {
    const want = replyFor(op);
    const run = this.chain.then(() => {
      if (this.closed) throw new SessionClosed(this.closeErr);
      return new Promise<T>((resolve, reject) => {
        if (this.rpc) {
          reject(
            new Error(
              `spur: turn already held (${w.opName(this.rpc.want)}) â€” serialize round-trips`,
            ),
          );
          return;
        }
        this.rpc = {
          want,
          taken: false,
          resolve: (frame) => {
            try {
              resolve(decode(frame.body));
            } catch (e) {
              reject(e as Error);
            }
          },
          reject,
        };
        // registered BEFORE the bytes â€” no answer without its holder.
        this.socketwrite(w.encodeFrame(op, body));
      });
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }

  /* ============================================================
     the Â§2 surface
     ============================================================ */

  /** fire-and-forget publish (Â§2.3): the write is the contract;
      refusals ride the ERROR route. Journaled writes that need the
      receipt number use streamPublish (Â§2.10â†’Â§2.11). */
  publish(subject: string, payload: Uint8Array, reply?: string): void {
    this.socketwrite(w.encodeFrame(w.OP.PUBLISH, w.encodePublish({ subject, payload, reply })));
  }

  /** subscribe (Â§2.4): no reply frame by design; DUP_SUB arrives on the
      error route. The sid is client-assigned and the DELIVER echo's key. */
  subscribe(handler: SubHandler, pattern: string): number {
    const sid = this.nextSid++;
    this.subHandlers.set(sid, handler);
    this.socketwrite(w.encodeFrame(w.OP.SUBSCRIBE, w.encodeSubscribe({ pattern, sid })));
    return sid;
  }

  unsubscribe(sid: number): void {
    this.subHandlers.delete(sid);
    this.socketwrite(w.encodeFrame(w.OP.UNSUB, w.encodeUnsub({ sid })));
  }

  /** open a durable lane (Â§2.8). STREAM_EXISTS is non-fatal on the
      error route when the lane is already there. */
  streamCreate(lane: string): Promise<number> {
    return this.rpcRound(
      w.OP.STREAM_CREATE,
      w.encodeStreamCreate({ lane }),
      (b) => w.decodeStreamReady(b).seq,
    );
  }

  /** the journaled write (Â§2.10) â€” its receipt names this publish's
      lane sequence, the "fsynced before the answer" fact (Â§2.10). */
  streamPublish(
    lane: string,
    subject: string,
    payload: Uint8Array,
    reply?: string,
  ): Promise<number> {
    return this.rpcRound(
      w.OP.STREAM_PUBLISH,
      w.encodeStreamPublish({ lane, subject, payload, reply }),
      (b) => w.decodeStreamReceipt(b).seq,
    );
  }

  /** delete a lane (Â§2.16); STREAM_GONE confirms. */
  streamDelete(lane: string): Promise<void> {
    return this.rpcRound(
      w.OP.STREAM_DELETE,
      w.encodeStreamDelete({ lane }),
      () => undefined,
    );
  }

  /** attach or resume a push consumer (Â§2.12). The settle frame says
      what the consumer expects first â€” the resume floor (Â§2.13). */
  consumerAttach(
    lane: string,
    consumer: string,
    handler: ConsumerHandler,
    opts: { filter?: string; ackWaitMillis?: number } = {},
  ): Promise<w.ConsumerReadyBody> {
    const sid = this.nextSid++;
    this.consumerHandlers.set(sid, handler);
    return this.rpcRound(
      w.OP.CONSUMER_ATTACH,
      w.encodeConsumerAttach({
        lane,
        consumer,
        filter: opts.filter,
        ackWaitMillis: opts.ackWaitMillis ?? 0,
        sid,
      }),
      (b) => w.decodeConsumerReady(b),
    );
  }

  /** Â§2.15 â€” no reply frame by contract: the floor advances silently.
      A refusal (NO_SUB) rides the error route, harmlessly ignorable. */
  ack(sid: number, seq: number): void {
    this.socketwrite(w.encodeFrame(w.OP.ACK, w.encodeAck({ sid, seq })));
  }

  /** detach a durable consumer (forget nothing; UNSUB on the sid). */
  consumerDetach(sid: number): void {
    this.consumerHandlers.delete(sid);
    this.unsubscribe(sid);
  }

  /** KV write (Â§2.18) â€” a journal row of its own kind, same receipt. */
  kvSet(lane: string, key: string, payload: Uint8Array): Promise<number> {
    return this.rpcRound(
      w.OP.KV_SET,
      w.encodeKVSet({ lane, key, payload }),
      (b) => w.decodeStreamReceipt(b).seq,
    );
  }

  kvGet(lane: string, key: string): Promise<w.KVValue> {
    return this.rpcRound(
      w.OP.KV_GET,
      w.encodeKVGet({ lane, key }),
      (b) => w.decodeKVValue(b),
    );
  }

  /** tombstone (Â§2.20) â€” idempotent; deleting a missing key still journals. */
  kvDelete(lane: string, key: string): Promise<number> {
    return this.rpcRound(
      w.OP.KV_DELETE,
      w.encodeKVDelete({ lane, key }),
      (b) => w.decodeStreamReceipt(b).seq,
    );
  }

  /** live keys of one lane, ascending bytewise (Â§2.21â†’Â§2.23). */
  kvKeys(lane: string): Promise<readonly string[]> {
    return this.rpcRound(
      w.OP.KV_KEYS,
      w.encodeKVKeys(lane),
      (b) => w.decodeKVKeyListBody(b).keys,
    );
  }

  /** the yardmaster's summary (Â§2.24â†’Â§2.25) â€” read-only. */
  yardInfo(): Promise<w.YardStateBody> {
    return this.rpcRound(w.OP.YARD_INFO, w.EMPTY_BODY, (b) => w.decodeYardState(b));
  }

  /** one lane's drill-down (Â§2.26â†’Â§2.27) â€” the depth gauge reads here. */
  laneInfo(lane: string): Promise<w.LaneStateBody> {
    return this.rpcRound(
      w.OP.LANE_INFO,
      w.encodeLaneInfo({ lane }),
      (b) => w.decodeLaneState(b),
    );
  }

  /** liveness probe (Â§2.3â†’Â§2.4). */
  async ping(): Promise<void> {
    if (this.pingWait) {
      await this.pingWait;
      return;
    }
    if (this.closed) throw new SessionClosed(this.closeErr);
    const p = new Promise<void>((resolve, reject) => {
      this.pingWait = { resolve, reject };
    });
    this.pinging = true;
    this.lastPingAt = Date.now();
    this.socketwrite(w.encodeFrame(w.OP.PING, w.EMPTY_BODY));
    try {
      await p;
    } finally {
      this.pinging = false;
    }
  }

  /* ============================================================
     keepalive (client.go's reprobe, client-side)
     ============================================================ */

  private armKeepalive(): void {
    const ms = this.opts.keepAliveMs ?? 0;
    if (ms <= 0) return;
    this.lastIn = Date.now();
    const grace = this.opts.graceMs ?? Math.ceil(ms / 2);
    this.idleTimer = setInterval(
      () => {
        if (this.closed) return;
        const now = Date.now();
        if (now - this.lastIn < ms) return;
        if (this.pinging) {
          if (now - this.lastPingAt > grace) {
            this.kill(
              new w.WireError(
                w.ERR.IDLE_TIMEOUT,
                true,
                `silent past ${ms}ms with no PONG in ${grace}ms`,
              ),
            );
          }
          return;
        }
        void this.ping().catch(() => undefined);
      },
      Math.max(250, Math.min(ms, 5_000)),
    );
    this.idleTimer.unref?.();
  }

  private disarmKeepalive(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/** which reply op settles which request â€” the Â§2 round-trip table.
    Ops without replies never enter rpcRound (they never sent it). */
function replyFor(op: number): number {
  switch (op) {
    case w.OP.HELLO:
      return w.OP.WELCOME;
    case w.OP.AUTHENTICATE:
      return w.OP.AUTH_OK;
    case w.OP.STREAM_CREATE:
      return w.OP.STREAM_READY;
    case w.OP.STREAM_PUBLISH:
      return w.OP.STREAM_RECEIPT;
    case w.OP.CONSUMER_ATTACH:
      return w.OP.CONSUMER_READY;
    case w.OP.STREAM_DELETE:
      return w.OP.STREAM_GONE;
    case w.OP.KV_SET:
    case w.OP.KV_DELETE:
      return w.OP.STREAM_RECEIPT;
    case w.OP.KV_GET:
      return w.OP.KV_VALUE;
    case w.OP.KV_KEYS:
      return w.OP.KV_KEYLIST;
    case w.OP.YARD_INFO:
      return w.OP.YARD_STATE;
    case w.OP.LANE_INFO:
      return w.OP.LANE_STATE;
    default:
      throw new Error(`op ${w.opName(op)} carries no reply frame`);
  }
}
