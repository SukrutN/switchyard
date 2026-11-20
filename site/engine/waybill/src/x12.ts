/* ============================================================
   x12 — the document's metal: separators, segments, envelopes.

   The parser and the writer mirror each other so the round-trip
   law holds: parse → re-emit = identical bytes (the control
   segments excepted, and only where a caller renumbers).

   Laws this layer owns:
   · Separators are read from the file, never guessed: element
     separator is the byte after "ISA"; the ISA16 element is the
     component separator; the segment terminator is the byte that
     closes the ISA. ISA is exactly 106 bytes including its
     terminator, and nothing else gets a say.
   · ISA fields are fixed-width and space-padded; the padding is
     not data. Parsing keeps the literal widths; the writer
     rebuilds them.
   · Segments are text between terminators; a bare blank piece is
     blank (files sometimes end pretty), any control byte inside
     segment data is a crime.
   · Envelope counting: SE owns its segment count (itself and its
     ST included), GE the set count, IEA the group count, and the
     pairs answer each other's control numbers.

   The standard itself is paid ANSI; the envelope law and the
   counts are the parts every implementation shares — they hold
   here against the fixture documents, hand-built.
   ============================================================ */

export type X12Code = "X12_PARSE" | "ENVELOPE" | "COUNTS";

/** where the metal refused: the code is the promise, at names
    the segment (or envelope position) that gave up. */
export interface X12Die {
  readonly code: X12Code;
  readonly at: string; // e.g. "ISA" or "SE" or "LX[2]/W01"
  readonly detail: string;
}

export class X12Error extends Error implements X12Die {
  readonly code: X12Code;
  readonly at: string;
  readonly detail: string;

  constructor(die: X12Die) {
    super(`${die.code} at ${die.at}: ${die.detail}`);
    this.name = "X12Error";
    this.code = die.code;
    this.at = die.at;
    this.detail = die.detail;
  }
}

/** delimiters, as read from the file or chosen by the writer. */
export interface Delims {
  readonly elem: string;
  readonly comp: string;
  /** the repetition separator — version 5010's ISA11; absent in 4010 */
  readonly rep?: string;
  readonly segTerm: string;
}

/** one segment. elems[i] is element i+1 (E01 is elems[0]); the
    array keeps trailing empty elements so a re-join is exact. */
export interface Segment {
  readonly tag: string;
  readonly elems: readonly string[];
}

/** one transaction set: ST elements, body, SE elements. */
export interface TxSet {
  readonly st: readonly string[];
  readonly body: readonly Segment[];
  readonly se: readonly string[];
}

export interface Group {
  readonly gs: readonly string[];
  readonly txs: readonly TxSet[];
  readonly ge: readonly string[];
}

export interface Envelope {
  /** ISA01..ISA16, literal — the fixed widths carry their padding */
  readonly isa: readonly string[];
  readonly groups: readonly Group[];
  readonly iea: readonly string[];
  readonly delims: Delims;
  readonly trailingTerminator: boolean;
}

/** ISA element widths, ISA01..ISA16 — the one fixed-length law in
    the whole standard, and the round-trip leans on it. */
export const ISA_W = [2, 10, 2, 10, 2, 15, 2, 15, 6, 4, 1, 5, 9, 1, 1, 1];

export const ISA_TOTAL = 106; // bytes including the terminator

/* ============================================================
   the parser
   ============================================================ */

function die(code: X12Code, at: string, detail: string): never {
  throw new X12Error({ code, at, detail });
}

export function parseX12(input: Uint8Array): Envelope {
  if (input.length < ISA_TOTAL) {
    die("X12_PARSE", "<File>", `${input.length} bytes — too short to hold an ISA`);
  }
  const text = new TextDecoder().decode(input);
  if (text.length < ISA_TOTAL) {
    die("X12_PARSE", "<File>", `${text.length} chars — too short to hold an ISA`);
  }
  if (text.slice(0, 3) !== "ISA") {
    die("X12_PARSE", "<File>", `file opens with ${JSON.stringify(text.slice(0, 3))}, want ISA`);
  }
  const elemSep = text[3];
  if (!isDataChar(elemSep)) {
    die("X12_PARSE", "ISA", `element separator ${JSON.stringify(elemSep)} is not a separator`);
  }
  const inner = text.slice(4, ISA_TOTAL - 1); // drop "ISA" + sep + the terminator
  const isa = inner.split(elemSep);
  if (isa.length !== 16) {
    die("X12_PARSE", "ISA", `${isa.length} elements, want exactly 16`);
  }
  for (let i = 0; i < 16; i++) {
    if (isa[i].length !== ISA_W[i]) {
      die(
        "ENVELOPE",
        `ISA${String(i + 1).padStart(2, "0")}`,
        `field is ${isa[i].length} wide, want ${ISA_W[i]}`,
      );
    }
  }
  const segTerm = text[ISA_TOTAL - 1];
  if (segTerm.length !== 1 || segTerm === " ") {
    die("X12_PARSE", "ISA", `segment terminator ${JSON.stringify(segTerm)} is not a separator`);
  }
  if (isa[15].length !== 1) {
    die("X12_PARSE", "ISA16", `${isa[15].length} wide, want 1`);
  }
  const delims: Delims = {
    elem: elemSep,
    comp: isa[15],
    // 5010 moved the repetition separator into ISA11; 4010 carries
    // the standard identifier there and has no repetitions.
    rep: isa[10].trim() === "U" ? undefined : isa[10],
    segTerm,
  };
  if (new Set([elemSep, isa[15], segTerm]).size !== 3) {
    die(
      "X12_PARSE",
      "ISA",
      `separators collide: ${JSON.stringify([elemSep, isa[15], segTerm])}`,
    );
  }

  const rest = text.slice(ISA_TOTAL);
  const pieces = rest.split(segTerm);
  if (pieces.length === 0) {
    die("ENVELOPE", "<File>", "no segments after the ISA");
  }
  // a file that ends with its terminator ends with a blank piece;
  // any other blank segment is a pretty-printed crime
  const trailing = pieces[pieces.length - 1] === "";
  if (trailing) pieces.pop();
  const segments = pieces.map((piece, ix) => toSegment(piece, `#${ix + 2}`, delims));
  if (segments.length === 0) {
    die("ENVELOPE", "<File>", "no segments after the ISA");
  }

  // walk: GS* ST/SE* GE* ... IEA
  let cursor = 0;
  const groups: Group[] = [];
  let ieaVar: readonly string[] | undefined = undefined;
  while (cursor < segments.length) {
    const seg = segments[cursor];
    if (seg.tag === "IEA") {
      if (ieaVar !== undefined) {
        die("ENVELOPE", "IEA", "a second IEA — one interchange per file");
      }
      ieaVar = seg.elems;
      cursor += 1;
      continue;
    }
    if (seg.tag !== "GS") {
      die("ENVELOPE", "GS", `expected GS, found ${seg.tag}`);
    }
    const gs = seg.elems;
    cursor += 1;
    const txs: TxSet[] = [];
    while (cursor < segments.length && segments[cursor].tag === "ST") {
      const st = segments[cursor].elems;
      cursor += 1;
      const body: Segment[] = [];
      let seVar: readonly string[] | undefined = undefined;
      while (cursor < segments.length) {
        const s = segments[cursor];
        if (s.tag === "SE") {
          seVar = s.elems;
          cursor += 1;
          break;
        }
        if (s.tag === "GS" || s.tag === "GE" || s.tag === "IEA") {
          break;
        }
        body.push(s);
        cursor += 1;
      }
      const se = seVar ?? die("ENVELOPE", "SE", `transaction ${st[1] ?? "?"} never closed by an SE`);
      const count = body.length + 2;
      if (Number(se[0]) !== count) {
        die(
          "COUNTS",
          "SE",
          `SE01 says ${se[0]} but ST..SE holds ${count} segments (incl. ST and SE)`,
        );
      }
      txs.push({ st, body, se });
    }
    let geVar: readonly string[] | undefined = undefined;
    if (cursor < segments.length && segments[cursor].tag === "GE") {
      geVar = segments[cursor].elems;
      cursor += 1;
    }
    const ge = geVar ?? die("ENVELOPE", "GE", "a group never closed by a GE");
    if (Number(ge[0]) !== txs.length) {
      die("COUNTS", "GE", `GE01 says ${ge[0]}, group holds ${txs.length}`);
    }
    groups.push({ gs, txs, ge });
  }
  // the GE count and the IEA answer each other
  if (cursor !== segments.length) {
    die("ENVELOPE", "<File>", "trailing segments after the IEA");
  }
  const iea = ieaVar ?? die("ENVELOPE", "IEA", "the interchange never opened its IEA");
  for (const g of groups) {
    if (g.ge[1] !== g.gs[5]) {
      die("COUNTS", "GE", `GE02 ${g.ge[1]} !== GS06 ${g.gs[5]}`);
    }
  }
  if (Number(iea[0]) !== groups.length) {
    die("COUNTS", "IEA", `IEA01 says ${iea[0]}, file holds ${groups.length}`);
  }
  if (iea[1] !== isa[12]) {
    die("COUNTS", "IEA", `IEA02 ${iea[1]} !== ISA13 ${isa[12]}`);
  }
  for (const g of groups) {
    if (g.txs.length === 0) die("ENVELOPE", "GS", "an empty group");
  }

  return { isa, groups, iea, delims, trailingTerminator: trailing };
}

const isDataChar = (c: string): boolean => c.length === 1 && c.charCodeAt(0) >= 0x21 && c.charCodeAt(0) <= 0x7e;

/** one piece + its delimiters → a Segment with element arity kept.
    A tag opens every segment; the element separator after it, if
    any, carries the elements. A tag-only segment is legal (all
    elements absent); a blank piece is not. */
function toSegment(piece: string, where: string, d: Delims): Segment {
  const sep = piece.indexOf(d.elem);
  const tag = sep < 0 ? piece : piece.slice(0, sep);
  if (!/^[A-Z][A-Z0-9]{1,2}$/.test(tag)) {
    die("X12_PARSE", where, `segment opens with ${JSON.stringify(tag.slice(0, 8) || piece.slice(0, 8))}, not a tag`);
  }
  if (sep < 0) {
    if (piece === "") {
      die("X12_PARSE", where, "empty segment inside the file (not the trailing one)");
    }
    return { tag, elems: [] };
  }
  const parts = piece
    .slice(sep + 1)
    .split(d.elem)
    .map((e) => { isPlain(e, where, tag); return e; });
  if (parts.length > 256) {
    die("X12_PARSE", where, `${tag} holds ${parts.length} elements — the ceiling is 256`);
  }
  return { tag, elems: parts };
}

/** element data may hold any printable char except the delimiters
    (the tokenizer already split those); control bytes are a crime. */
function isPlain(e: string, where: string, tag: string): void {
  for (let i = 0; i < e.length; i++) {
    const c = e.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      die("X12_PARSE", where, `${tag} element carries byte 0x${c.toString(16)}`);
    }
  }
}

/* ============================================================
   the writer — the parser's mirror
   ============================================================ */

/** pad an ISA element to its fixed width; the padding is not data. */
export function padIsa(index: number, value: string): string {
  const w = ISA_W[index];
  if (value.length > w) {
  die(
    "ENVELOPE",
    `ISA${String(index + 1).padStart(2, "0")}`,
    `value ${JSON.stringify(value)} exceeds width ${w}`,
  );
  }
  return value + " ".repeat(w - value.length);
}

const segText = (s: Segment, d: Delims): string => [s.tag, ...s.elems].join(d.elem);

/** build the whole interchange back; control numbers stay as the
    caller set them — no counting beyond the law's own arithmetic. */
export function encodeX12(e: Envelope): Uint8Array {
  const d = e.delims;
  const out: string[] = [];
  out.push("ISA" + d.elem + e.isa.join(d.elem) + d.segTerm);
  for (const g of e.groups) {
    out.push(["GS", ...g.gs].join(d.elem) + d.segTerm);
    for (const tx of g.txs) {
      out.push(["ST", ...tx.st].join(d.elem) + d.segTerm);
      for (const s of tx.body) out.push(segText(s, d) + d.segTerm);
      const count = tx.body.length + 2;
      out.push(["SE", String(count), tx.se[1]].join(d.elem) + d.segTerm);
    }
    out.push(["GE", String(g.txs.length), g.ge[1]].join(d.elem) + d.segTerm);
  }
  out.push(["IEA", String(e.groups.length), e.iea[1]].join(d.elem) + d.segTerm);
  let text = out.join("");
  if (!e.trailingTerminator && text.endsWith(d.segTerm)) text = text.slice(0, -1);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** the writers' envelope pieces: build with data, counts computed. */
export function buildTx(tag01: string, body: Segment[], st02: string, se02 = st02): TxSet {
  return { st: [tag01, st02], body, se: [String(body.length + 2), se02] };
}

export function seg(tag: string, ...elems: (string | number | undefined)[]): Segment {
  // an absent element INSIDE the segment keeps arity (""); an absent
  // element at the tail truncates — the writer only emits what it has
  const raw = elems.map((x) => (typeof x === "number" ? String(x) : x));
  let end = raw.length;
  while (end > 0 && raw[end - 1] === undefined) end -= 1;
  const list: string[] = [];
  for (let i = 0; i < end; i++) list.push(raw[i] ?? "");
  return { tag, elems: list };
}
