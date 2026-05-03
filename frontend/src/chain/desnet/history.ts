import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import { mimeName } from "./mint";

const MOD = "history";

// Verb constants from history.move::test_verb_constants
export const VERB = {
  MINT: 0,
  SPARK: 1,
  VOICE: 2,
  ECHO: 3,
  REMIX: 4,
  PRESS: 5,
  SYNC: 6,
} as const;

export type Verb = (typeof VERB)[keyof typeof VERB];

export function verbName(v: number): string {
  switch (v) {
    case VERB.MINT: return "Mint";
    case VERB.SPARK: return "Spark";
    case VERB.VOICE: return "Voice";
    case VERB.ECHO: return "Echo";
    case VERB.REMIX: return "Remix";
    case VERB.PRESS: return "Press";
    case VERB.SYNC: return "Sync";
    default: return "?";
  }
}

// Raw history entry shape — chunk_entry_at returns (verb, ts, target?, payload, asset?)
export type HistoryEntry = {
  chunkAddr: string;
  idx: number;
  verb: number;
  timestampSecs: number;
  target: string | null;
  payloadHex: string;
  asset: string | null;
};

export async function historyExists(rpc: RpcPool, pidAddr: string): Promise<boolean> {
  try {
    const r = await rpc.viewFn<[boolean]>(
      MOD + "::history_exists",
      [],
      [pidAddr],
      DESNET_PACKAGE,
    );
    return Boolean(r[0]);
  } catch {
    return false;
  }
}

export async function totalEntries(rpc: RpcPool, pidAddr: string): Promise<number> {
  try {
    const r = await rpc.viewFn<[string]>(
      MOD + "::total_entries",
      [],
      [pidAddr],
      DESNET_PACKAGE,
    );
    return Number(r[0]);
  } catch {
    return 0;
  }
}

export async function headChunkAddr(rpc: RpcPool, pidAddr: string): Promise<string | null> {
  try {
    const r = await rpc.viewFn<[string]>(
      MOD + "::head_chunk_addr",
      [],
      [pidAddr],
      DESNET_PACKAGE,
    );
    return String(r[0]);
  } catch {
    return null;
  }
}

export async function sealedChunksList(rpc: RpcPool, pidAddr: string): Promise<string[]> {
  try {
    const r = await rpc.viewFn<[string[]]>(
      MOD + "::sealed_chunks_list",
      [],
      [pidAddr],
      DESNET_PACKAGE,
    );
    return (r[0] ?? []).map(String);
  } catch {
    return [];
  }
}

export async function chunkEntriesCount(rpc: RpcPool, chunkAddr: string): Promise<number> {
  try {
    const r = await rpc.viewFn<[string]>(
      MOD + "::chunk_entries_count",
      [],
      [chunkAddr],
      DESNET_PACKAGE,
    );
    return Number(r[0]);
  } catch {
    return 0;
  }
}

// Returns (verb, ts_secs, target?, payload_hex, asset?)
export async function chunkEntryAt(
  rpc: RpcPool,
  chunkAddr: string,
  idx: number,
): Promise<HistoryEntry | null> {
  try {
    type Optional = { vec: [string] | [] };
    const r = await rpc.viewFn<[number, string, Optional, string, Optional]>(
      MOD + "::chunk_entry_at",
      [],
      [chunkAddr, idx.toString()],
      DESNET_PACKAGE,
    );
    return {
      chunkAddr,
      idx,
      verb: Number(r[0]),
      timestampSecs: Number(r[1]),
      target: optAddr(r[2]),
      payloadHex: String(r[3]),
      asset: optAddr(r[4]),
    };
  } catch {
    return null;
  }
}

function optAddr(o: { vec: [string] | [] }): string | null {
  if (o && Array.isArray(o.vec) && o.vec.length > 0) return String(o.vec[0]);
  return null;
}

// ============ Feed loader — last N entries across head + sealed chunks ============

/// Walk newest → oldest: read head chunk first (topmost entries are newest),
/// then sealed chunks in reverse list order. Stop after `limit` entries.
///
/// Within a single chunk all entries are fetched in parallel — `limit` view
/// calls in flight at once via the rpc pool's semaphore. Across chunks we
/// stay sequential so we don't pull more than needed (early-exit once limit
/// is hit). The pool's MAX_IN_FLIGHT cap prevents storming the endpoint.
export async function loadRecentHistory(
  rpc: RpcPool,
  pidAddr: string,
  limit: number,
): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = [];
  if (!(await historyExists(rpc, pidAddr))) return out;

  const [head, sealed] = await Promise.all([
    headChunkAddr(rpc, pidAddr),
    sealedChunksList(rpc, pidAddr),
  ]);
  // Newest to oldest: head, then sealed[last]..sealed[0]
  const order: string[] = [];
  if (head) order.push(head);
  for (let i = sealed.length - 1; i >= 0; i--) order.push(sealed[i]);

  for (const chunk of order) {
    if (out.length >= limit) break;
    const count = await chunkEntriesCount(rpc, chunk);
    if (count === 0) continue;
    const need = Math.min(count, limit - out.length);
    // Fetch the newest `need` entries in this chunk in parallel.
    const indices: number[] = [];
    for (let k = 0; k < need; k++) indices.push(count - 1 - k);
    const batch = await Promise.all(indices.map((idx) => chunkEntryAt(rpc, chunk, idx)));
    for (const e of batch) {
      if (e && out.length < limit) out.push(e);
    }
  }
  return out;
}

// ============ BCS decoder for MintEvent ============

// Layout (struct MintEvent in mint.move):
//   author: address (32B)
//   seq: u64 (8B)
//   timestamp_us: u64 (8B)
//   content_kind: u8 (1B)
//   content_text: vector<u8>
//   media: Option<MintMedia>
//   parent_mint_id: Option<MintId>      MintId = (author:address, seq:u64)
//   root_mint_id: Option<MintId>
//   quote_mint_id: Option<MintId>
//   mentions: vector<address>
//   tags: vector<vector<u8>>
//   tickers: vector<address>
//   tips: vector<Tip>                   Tip = (recipient:address, token_metadata:address, amount:u64)

export type DecodedMint = {
  author: string;
  seq: number;
  timestampUs: number;
  contentKind: number;
  contentText: string;
  media: DecodedMedia | null;
  parent: { author: string; seq: number } | null;
  root: { author: string; seq: number } | null;
  quote: { author: string; seq: number } | null;
  mentions: string[];
  tags: string[];
  tickers: string[];
  tips: { recipient: string; tokenMetadata: string; amount: bigint }[];
};

export type DecodedMedia = {
  kind: number;
  mime: number;
  mimeName: string;
  inlineData: Uint8Array;
  refBackend: number;
  refBlobId: Uint8Array;
  refHash: Uint8Array;
};

export function decodeMintPayload(payloadHex: string): DecodedMint | null {
  try {
    const bytes = hexToBytes(payloadHex);
    const r = new Reader(bytes);
    return {
      author: r.address(),
      seq: Number(r.u64()),
      timestampUs: Number(r.u64()),
      contentKind: r.u8(),
      contentText: bytesToUtf8(r.bytes()),
      media: r.option(() => decodeMedia(r)),
      parent: r.option(() => ({ author: r.address(), seq: Number(r.u64()) })),
      root: r.option(() => ({ author: r.address(), seq: Number(r.u64()) })),
      quote: r.option(() => ({ author: r.address(), seq: Number(r.u64()) })),
      mentions: r.vec(() => r.address()),
      tags: r.vec(() => bytesToUtf8(r.bytes())),
      tickers: r.vec(() => r.address()),
      tips: r.vec(() => ({
        recipient: r.address(),
        tokenMetadata: r.address(),
        amount: r.u64(),
      })),
    };
  } catch {
    return null;
  }
}

function decodeMedia(r: Reader): DecodedMedia {
  const kind = r.u8();
  const mime = r.u8();
  const inlineData = r.bytes();
  const refBackend = r.u8();
  const refBlobId = r.bytes();
  const refHash = r.bytes();
  return { kind, mime, mimeName: mimeName(mime), inlineData, refBackend, refBlobId, refHash };
}

// ============ Minimal BCS reader ============

class Reader {
  private off = 0;
  constructor(private buf: Uint8Array) {}

  u8(): number {
    return this.buf[this.off++];
  }
  u16(): number {
    const v = this.buf[this.off] | (this.buf[this.off + 1] << 8);
    this.off += 2;
    return v;
  }
  u64(): bigint {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(this.buf[this.off + i]) << BigInt(i * 8);
    this.off += 8;
    return v;
  }
  uleb128(): number {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = this.buf[this.off++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return v;
  }
  bytes(): Uint8Array {
    const len = this.uleb128();
    const out = this.buf.slice(this.off, this.off + len);
    this.off += len;
    return out;
  }
  address(): string {
    const out = this.buf.slice(this.off, this.off + 32);
    this.off += 32;
    return "0x" + bytesToHex(out);
  }
  option<T>(read: () => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    return read();
  }
  vec<T>(read: () => T): T[] {
    const len = this.uleb128();
    const out: T[] = [];
    for (let i = 0; i < len; i++) out.push(read());
    return out;
  }
}

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToUtf8(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(b);
  } catch {
    return "";
  }
}
