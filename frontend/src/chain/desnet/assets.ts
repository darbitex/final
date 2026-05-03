import type { Aptos } from "@aptos-labs/ts-sdk";
import { DESNET_PACKAGE } from "../../config";

const MOD = "assets";

// Mirror assets.move::CHUNK_SIZE_MAX. Hard-coded 30000 (~30KB).
export const CHUNK_SIZE_MAX = 30_000;

// Mirror MAX_TOTAL_SIZE = 5MB.
export const MAX_TOTAL_SIZE = 5 * 1024 * 1024;

// Mirror BRANCH_FACTOR — assets.move builds a fractal tree of internal Nodes
// pointing to up to 16 children each. For a 5MB asset that's 167 chunks at
// depth 2 (16 per node, 11 root branches). For ≤16 chunks (480KB) the tree
// is depth 1: one Node points to all chunks, root = node addr, depth = 1.
// For 1 chunk (30KB) the tree is depth 0: root = chunk addr, depth = 0.
export const BRANCH_FACTOR = 16;

export const START_UPLOAD_FN = `${DESNET_PACKAGE}::${MOD}::start_upload`;
export const DEPLOY_CHUNK_FN = `${DESNET_PACKAGE}::${MOD}::deploy_chunk`;
export const DEPLOY_NODE_FN = `${DESNET_PACKAGE}::${MOD}::deploy_node`;
export const FINALIZE_FN = `${DESNET_PACKAGE}::${MOD}::finalize`;

// ============ Tx-arg builders ============

export function startUploadArgs(mime: number, totalSize: number, creatorPid: string): unknown[] {
  return [mime, totalSize.toString(), creatorPid];
}

export function deployChunkArgs(masterAddr: string, data: Uint8Array): unknown[] {
  return [masterAddr, Array.from(data)];
}

export function deployNodeArgs(masterAddr: string, children: string[]): unknown[] {
  return [masterAddr, children];
}

export function finalizeArgs(masterAddr: string, root: string, depth: number): unknown[] {
  return [masterAddr, root, depth];
}

// ============ Plan = list of chunk slices (offset+length) computed up-front ============

export type UploadPlan = {
  totalSize: number;
  mime: number;
  chunks: Uint8Array[];          // raw chunk data (no addrs yet)
  treeShape: TreeShape;
};

export type TreeShape =
  | { depth: 0 }                                  // single chunk = root
  | { depth: 1; chunkRange: [number, number] }    // one node, up to BRANCH_FACTOR chunks
  | { depth: 2; nodeShapes: { chunkRange: [number, number] }[] };

// Slice a File into ≤30KB chunks; compute the fractal tree shape.
// Throws if file exceeds MAX_TOTAL_SIZE or zero-length.
export function planUpload(bytes: Uint8Array, mime: number): UploadPlan {
  if (bytes.length === 0) throw new Error("Empty file");
  if (bytes.length > MAX_TOTAL_SIZE) {
    throw new Error(`File too large (max ${MAX_TOTAL_SIZE / 1024 / 1024} MB)`);
  }
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += CHUNK_SIZE_MAX) {
    chunks.push(bytes.slice(off, Math.min(off + CHUNK_SIZE_MAX, bytes.length)));
  }
  const n = chunks.length;
  let treeShape: TreeShape;
  if (n === 1) {
    treeShape = { depth: 0 };
  } else if (n <= BRANCH_FACTOR) {
    treeShape = { depth: 1, chunkRange: [0, n] };
  } else {
    // Build depth-2: group chunks into nodes of up to BRANCH_FACTOR each.
    // Root node points to the resulting nodes (also up to BRANCH_FACTOR groups
    // → caps at 256 chunks = 7.5MB > 5MB cap, so root never overflows here).
    const groups: { chunkRange: [number, number] }[] = [];
    for (let i = 0; i < n; i += BRANCH_FACTOR) {
      groups.push({ chunkRange: [i, Math.min(i + BRANCH_FACTOR, n)] });
    }
    treeShape = { depth: 2, nodeShapes: groups };
  }
  return { totalSize: bytes.length, mime, chunks, treeShape };
}

// Total tx count for a plan: 1 start + N chunks + M nodes + 1 finalize.
export function txCountForPlan(plan: UploadPlan): number {
  let nodes = 0;
  if (plan.treeShape.depth === 1) nodes = 1;
  else if (plan.treeShape.depth === 2) nodes = plan.treeShape.nodeShapes.length + 1;
  return 1 + plan.chunks.length + nodes + 1;
}

// ============ Event parsing — extract object addr from tx response ============

// Parse the master_addr from a `start_upload` tx response. The Aptos SDK
// returns events on the committed tx; we grep for AssetMasterCreated.
export function extractMasterAddr(events: TxEvent[]): string | null {
  for (const e of events) {
    if (e.type.endsWith(`::${MOD}::AssetMasterCreated`)) {
      return String(e.data?.master_addr ?? "");
    }
  }
  return null;
}

export function extractChunkAddr(events: TxEvent[]): string | null {
  for (const e of events) {
    if (e.type.endsWith(`::${MOD}::AssetChunkDeployed`)) {
      return String(e.data?.chunk_addr ?? "");
    }
  }
  return null;
}

export function extractNodeAddr(events: TxEvent[]): string | null {
  for (const e of events) {
    if (e.type.endsWith(`::${MOD}::AssetNodeDeployed`)) {
      return String(e.data?.node_addr ?? "");
    }
  }
  return null;
}

export type TxEvent = { type: string; data: Record<string, unknown> };

// Read events off a confirmed tx hash. Caller has already waited for commit.
export async function eventsOfTx(aptos: Aptos, hash: string): Promise<TxEvent[]> {
  const tx = await aptos.transaction.getTransactionByHash({ transactionHash: hash });
  const evs = (tx as { events?: TxEvent[] }).events ?? [];
  return evs.map((e) => ({ type: e.type, data: e.data ?? {} }));
}
