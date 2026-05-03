import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import type { MoveArg, MoveFn } from "./tx";

const MOD = "mint";

// Media kind discriminator — matches mint.move::MEDIA_KIND_*.
export const MEDIA_KIND_NONE = 0;
export const MEDIA_KIND_INLINE = 1;
export const MEDIA_KIND_REF = 2;

// MIME enum — matches assets.move (and mint.move asserts on the same set).
export const MIME = {
  PNG: 1,
  JPEG: 2,
  GIF: 3,
  WEBP: 4,
  SVG: 5,
} as const;

// Backend enum — matches mint.move BACKEND_*. 3 = desnet::assets fractal-tree.
export const BACKEND_DESNET_ASSETS = 3;

export const ZERO_ADDR = "0x0";

export async function mintCount(rpc: RpcPool, pidAddr: string): Promise<number> {
  const r = await rpc.viewFn<[string]>(MOD + "::mint_count", [], [pidAddr], DESNET_PACKAGE);
  return Number(r[0]);
}

export async function nextSeq(rpc: RpcPool, pidAddr: string): Promise<number> {
  const r = await rpc.viewFn<[string]>(MOD + "::next_seq", [], [pidAddr], DESNET_PACKAGE);
  return Number(r[0]);
}

// Pure helper — file extension → MIME byte. Returns null if unsupported.
export function mimeOfFile(file: File): number | null {
  const t = file.type.toLowerCase();
  if (t === "image/png") return MIME.PNG;
  if (t === "image/jpeg" || t === "image/jpg") return MIME.JPEG;
  if (t === "image/gif") return MIME.GIF;
  if (t === "image/webp") return MIME.WEBP;
  if (t === "image/svg+xml") return MIME.SVG;
  return null;
}

export function mimeName(mime: number): string {
  switch (mime) {
    case MIME.PNG: return "image/png";
    case MIME.JPEG: return "image/jpeg";
    case MIME.GIF: return "image/gif";
    case MIME.WEBP: return "image/webp";
    case MIME.SVG: return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

export const CREATE_MINT_FN = `${DESNET_PACKAGE}::${MOD}::create_mint` as MoveFn;

// Build the 23-arg create_mint payload. Most callers pass `null` for the
// optional buckets and let this helper fill in zero-discriminated values.
export type CreateMintInput = {
  contentText: string;
  // Inline media (≤8KB). Mutually exclusive with assetMasterAddr.
  inline?: { mime: number; bytes: Uint8Array } | null;
  // Sealed desnet::assets master addr. Set this OR inline, not both.
  assetMasterAddr?: string | null;
  // Threading
  parent?: { author: string; seq: number } | null;
  quote?: { author: string; seq: number } | null;
  mentions?: string[];
  tags?: string[];
  tickers?: string[]; // PID addrs
  tips?: { recipient: string; tokenMetadata: string; amount: bigint }[];
};

// Returns the function-arguments array for signAndSubmitTransaction. Caller
// owns the transaction wrapper (function id, type args).
export function buildCreateMintArgs(i: CreateMintInput): MoveArg[] {
  const contentBytes = Array.from(new TextEncoder().encode(i.contentText));

  const useAsset = !!i.assetMasterAddr;
  const inline = i.inline;
  const mediaKind = useAsset ? MEDIA_KIND_NONE : inline ? MEDIA_KIND_INLINE : MEDIA_KIND_NONE;
  const mediaMime = useAsset ? 0 : inline ? inline.mime : 0;
  const mediaInlineData = useAsset ? [] : inline ? Array.from(inline.bytes) : [];
  const mediaRefBackend = 0;
  const mediaRefBlobId: number[] = [];
  const mediaRefHash: number[] = [];

  const parent = i.parent ?? null;
  const quote = i.quote ?? null;

  return [
    /* content_kind */ 0,
    /* content_text */ contentBytes,
    /* media_kind */ mediaKind,
    /* media_mime */ mediaMime,
    /* media_inline_data */ mediaInlineData,
    /* media_ref_backend */ mediaRefBackend,
    /* media_ref_blob_id */ mediaRefBlobId,
    /* media_ref_hash */ mediaRefHash,
    /* parent_author */ parent ? parent.author : ZERO_ADDR,
    /* parent_seq */ parent ? parent.seq.toString() : "0",
    /* parent_set */ !!parent,
    /* quote_author */ quote ? quote.author : ZERO_ADDR,
    /* quote_seq */ quote ? quote.seq.toString() : "0",
    /* quote_set */ !!quote,
    /* mentions */ i.mentions ?? [],
    /* tags */ (i.tags ?? []).map((t) => Array.from(new TextEncoder().encode(t))),
    /* tickers */ i.tickers ?? [],
    /* tip_recipients */ (i.tips ?? []).map((t) => t.recipient),
    /* tip_tokens */ (i.tips ?? []).map((t) => t.tokenMetadata),
    /* tip_amounts */ (i.tips ?? []).map((t) => t.amount.toString()),
    /* asset_master_addr */ i.assetMasterAddr ?? ZERO_ADDR,
    /* asset_master_set */ !!i.assetMasterAddr,
  ];
}
