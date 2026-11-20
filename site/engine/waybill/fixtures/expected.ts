/* ============================================================
   expected — the waybill lock: pure data, no imports. Written
   by hand ONCE from `fixtures/lock.ts`'s printed JSON (the
   human in the loop, per the engine family's convention) and
   read by the characterization tests. Digests are byte-exact
   (fnv1a64 hex, the desk's own row framing).
   ============================================================ */

export interface WaybillLock {
  readonly receive: {
    readonly files: number;
    readonly orders: number;
    readonly refusals: readonly string[];
  };
  readonly canonical: {
    readonly alderline: string;
    readonly kelrick: string;
  };
  readonly lanes: {
    readonly orders: string;
    readonly dead: string;
  };
  readonly mint: {
    readonly advice945: string;
    readonly notice856: string;
  };
}

export const WAYBILL_LOCK: WaybillLock = {
  receive: {
    files: 7,
    orders: 2,
    refusals: [
      "ROUTE_MISS@ISA06",
      "ENVELOPE@ISA06",
      "COUNTS@SE",
      "MAP_MISS@W06.2",
      "REF_CHARS@ref",
    ],
  },
  canonical: {
    alderline: "af88b5f90334156b",
    kelrick: "6a74fc5499a66352",
  },
  lanes: {
    orders: "d3d483f9798f71dd",
    dead: "1c53a5b193459df6",
  },
  mint: {
    advice945: "a6f23729f524715f",
    notice856: "36ab3896926ed50d",
  },
};
