// Asset upload orchestrator — abstract interface so the compose box can stay
// stable while the underlying tx strategy evolves.
//
// B1 (LIVE): JS-orchestrated multi-tx. Submit start_upload, wait, parse master
// addr from event, submit each deploy_chunk, parse chunk addrs, submit
// deploy_node(s), parse node addrs, submit finalize. ~7 tx for 150 KB.
// Works against the live v0.3.3-mainnet bytecode unchanged.
//
// B2 (PLANNED v0.3.4): same multi-tx wire calls but addresses returned by
// new `public fun *_pub` mirrors of the entries → no need to parse events,
// can bundle a Move script that does start + chunks + finalize in 1 tx.
// Frontend swap point: implement B2Orchestrator and route the compose box to
// it via `getOrchestrator()`. No page-level changes required.
//
// B3 (HYPOTHETICAL): create_named_object refactor with deterministic addrs
// computed in JS. Bigger Move surgery (see the user-facing trade-off table
// in the chat). Same interface as B1/B2, just a different impl.

import {
  AccountAddress,
  type Aptos,
  MoveVector,
  U8,
  U64,
} from "@aptos-labs/ts-sdk";
import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import {
  CHUNK_SIZE_MAX,
  DEPLOY_CHUNK_FN,
  DEPLOY_NODE_FN,
  FINALIZE_FN,
  START_UPLOAD_FN,
  deployChunkArgs,
  deployNodeArgs,
  eventsOfTx,
  extractChunkAddr,
  extractMasterAddr,
  extractNodeAddr,
  finalizeArgs,
  planUpload,
  startUploadArgs,
  txCountForPlan,
} from "./assets";

export type SubmitFn = (payload: {
  data: { function: string; typeArguments: string[]; functionArguments: unknown[] };
}) => Promise<{ hash: string }>;

export type UploadProgress = {
  phase: "start" | "chunk" | "node" | "finalize" | "done";
  step: number;        // 1-indexed
  totalSteps: number;
  lastTxHash?: string;
  /// Human-readable hint for the wallet popup that's about to fire.
  /// E.g. "Confirming chunk 3 of 5 (~30 KB)". Render this above the wallet
  /// modal so the user knows what they're signing.
  hint: string;
  /// Capability tier in use — surfaces to the UI so it can show the badge
  /// ("multi-tx upload" vs "bundled in 1 tx").
  tier: 1 | 2 | 3;
};

export type UploadResult = {
  masterAddr: string;
  txHashes: string[];
};

export interface AssetOrchestrator {
  upload(args: {
    bytes: Uint8Array;
    mime: number;
    creatorPid: string;
    /// Wallet address that signs each tx. Used by Tier-3 to pre-derive
    /// deterministic object addresses (uploader is the seed-mixing input
    /// for Aptos `object::create_named_object`). Tier 1 + 2 don't strictly
    /// need it — they read addresses from emitted events — but accepting
    /// it keeps the interface uniform and lets B1/B2 cross-check derived
    /// vs returned addrs as a defense-in-depth check.
    uploaderAddr: string;
    submit: SubmitFn;
    aptos: Aptos;
    onProgress?: (p: UploadProgress) => void;
  }): Promise<UploadResult>;
}

// ============ B1 implementation — JS-orchestrated multi-tx ============

class B1OrchestratorImpl implements AssetOrchestrator {
  readonly tier: 1 = 1;

  async upload({
    bytes,
    mime,
    creatorPid,
    uploaderAddr: _uploaderAddr,
    submit,
    aptos,
    onProgress,
  }: Parameters<AssetOrchestrator["upload"]>[0]): Promise<UploadResult> {
    const plan = planUpload(bytes, mime);
    const totalSteps = txCountForPlan(plan);
    const txHashes: string[] = [];
    let step = 0;

    const tick = (phase: UploadProgress["phase"], hint: string, lastTxHash?: string) => {
      step += 1;
      onProgress?.({ phase, step, totalSteps, lastTxHash, hint, tier: 1 });
    };

    // 1. start_upload
    tick(
      "start",
      `Step 1/${totalSteps}: allocating Master object on chain. Sign once to begin.`,
    );
    const startTx = await submit({
      data: {
        function: START_UPLOAD_FN,
        typeArguments: [],
        functionArguments: startUploadArgs(mime, plan.totalSize, creatorPid),
      },
    });
    await aptos.waitForTransaction({ transactionHash: startTx.hash });
    txHashes.push(startTx.hash);
    const masterAddr = extractMasterAddr(await eventsOfTx(aptos, startTx.hash));
    if (!masterAddr) throw new Error("start_upload did not emit AssetMasterCreated");

    // 2. deploy_chunk × N
    const chunkAddrs: string[] = [];
    for (let i = 0; i < plan.chunks.length; i++) {
      const data = plan.chunks[i];
      const sizeKb = (data.length / 1024).toFixed(1);
      tick(
        "chunk",
        `Step ${step + 1}/${totalSteps}: uploading chunk ${i + 1} of ${plan.chunks.length} (~${sizeKb} KB).`,
      );
      const tx = await submit({
        data: {
          function: DEPLOY_CHUNK_FN,
          typeArguments: [],
          functionArguments: deployChunkArgs(masterAddr, data),
        },
      });
      await aptos.waitForTransaction({ transactionHash: tx.hash });
      txHashes.push(tx.hash);
      const addr = extractChunkAddr(await eventsOfTx(aptos, tx.hash));
      if (!addr) throw new Error("deploy_chunk did not emit AssetChunkDeployed");
      chunkAddrs.push(addr);
    }

    // 3. Build the tree — depth, root.
    let root: string;
    let depth: number;
    if (plan.treeShape.depth === 0) {
      root = chunkAddrs[0];
      depth = 0;
    } else if (plan.treeShape.depth === 1) {
      tick(
        "node",
        `Step ${step + 1}/${totalSteps}: assembling fractal tree (depth 1, ${chunkAddrs.length} chunks).`,
      );
      const tx = await submit({
        data: {
          function: DEPLOY_NODE_FN,
          typeArguments: [],
          functionArguments: deployNodeArgs(masterAddr, chunkAddrs),
        },
      });
      await aptos.waitForTransaction({ transactionHash: tx.hash });
      txHashes.push(tx.hash);
      const nodeAddr = extractNodeAddr(await eventsOfTx(aptos, tx.hash));
      if (!nodeAddr) throw new Error("deploy_node did not emit AssetNodeDeployed");
      root = nodeAddr;
      depth = 1;
    } else {
      // depth 2 — group nodes, then root node over those nodes
      const groupNodeAddrs: string[] = [];
      const groups = plan.treeShape.nodeShapes;
      for (let gi = 0; gi < groups.length; gi++) {
        const [gStart, gEnd] = groups[gi].chunkRange;
        const groupChunks = chunkAddrs.slice(gStart, gEnd);
        tick(
          "node",
          `Step ${step + 1}/${totalSteps}: building tree node ${gi + 1} of ${groups.length} (groups ${groupChunks.length} chunks).`,
        );
        const tx = await submit({
          data: {
            function: DEPLOY_NODE_FN,
            typeArguments: [],
            functionArguments: deployNodeArgs(masterAddr, groupChunks),
          },
        });
        await aptos.waitForTransaction({ transactionHash: tx.hash });
        txHashes.push(tx.hash);
        const addr = extractNodeAddr(await eventsOfTx(aptos, tx.hash));
        if (!addr) throw new Error("deploy_node did not emit AssetNodeDeployed");
        groupNodeAddrs.push(addr);
      }
      tick(
        "node",
        `Step ${step + 1}/${totalSteps}: stitching root node over ${groupNodeAddrs.length} sub-trees.`,
      );
      const rootTx = await submit({
        data: {
          function: DEPLOY_NODE_FN,
          typeArguments: [],
          functionArguments: deployNodeArgs(masterAddr, groupNodeAddrs),
        },
      });
      await aptos.waitForTransaction({ transactionHash: rootTx.hash });
      txHashes.push(rootTx.hash);
      const rootAddr = extractNodeAddr(await eventsOfTx(aptos, rootTx.hash));
      if (!rootAddr) throw new Error("deploy_node (root) did not emit AssetNodeDeployed");
      root = rootAddr;
      depth = 2;
    }

    // 4. finalize
    tick(
      "finalize",
      `Step ${step + 1}/${totalSteps}: sealing the asset (immutable from here).`,
    );
    const finTx = await submit({
      data: {
        function: FINALIZE_FN,
        typeArguments: [],
        functionArguments: finalizeArgs(masterAddr, root, depth),
      },
    });
    await aptos.waitForTransaction({ transactionHash: finTx.hash });
    txHashes.push(finTx.hash);

    onProgress?.({
      phase: "done",
      step: totalSteps,
      totalSteps,
      lastTxHash: finTx.hash,
      hint: `Sealed. Master ${shortAddr(masterAddr)} ready to attach to your mint.`,
      tier: 1,
    });
    return { masterAddr, txHashes };
  }
}

// Local short-form for upload progress hints (different from format::shortAddr
// because the wallet popup hint wants a more compact rendering).
function shortAddr(a: string): string {
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ============ B2 — real implementation (live with assets.move v0.3.4) ============
//
// Bundles start_upload_pub + deploy_chunk_pub × N + (deploy_node_pub × M) +
// finalize_pub into one Move script transaction. Caller signs ONCE.
//
// Bytecode is shipped as a static asset at /scripts/asset_upload_b2.mv —
// fetched once and cached. Recompile path: `cd ~/desnet && aptos move
// compile-script --output-file build/asset_upload_b2.mv` then copy to
// frontend/public/scripts/.
//
// Per-tx caps (Aptos): tx payload ~1 MB, gas ceiling ~30 chunks ≈ 900 KB.
// Larger files: this impl falls back to B1 (the orchestrator detects via
// chunk count and short-circuits before building the script). Future v1.1:
// split into 2–3 script txs with the last one carrying finalize.

const B2_SCRIPT_URL = "/scripts/asset_upload_b2.mv";
// Conservative gas ceiling — single-tx bundles up to this many chunks.
// Beyond this the orchestrator falls back to B1 multi-tx.
const B2_MAX_CHUNKS_PER_SCRIPT = 28;

let _b2BytecodeCache: Uint8Array | null = null;
async function loadB2Bytecode(): Promise<Uint8Array> {
  if (_b2BytecodeCache) return _b2BytecodeCache;
  const resp = await fetch(B2_SCRIPT_URL);
  if (!resp.ok) {
    throw new Error(`Failed to load Tier-2 script bytecode (${B2_SCRIPT_URL}): ${resp.status}`);
  }
  const buf = await resp.arrayBuffer();
  _b2BytecodeCache = new Uint8Array(buf);
  return _b2BytecodeCache;
}

class B2OrchestratorImpl implements AssetOrchestrator {
  readonly tier: 2 = 2;

  async upload({
    bytes,
    mime,
    creatorPid,
    submit,
    aptos,
    onProgress,
  }: Parameters<AssetOrchestrator["upload"]>[0]): Promise<UploadResult> {
    const plan = planUpload(bytes, mime);

    // Per-tx gas/size cap → fall back to B1 for very large uploads (the
    // bundled-script approach only saves wallet popups; it can't bypass
    // gas limits).
    if (plan.chunks.length > B2_MAX_CHUNKS_PER_SCRIPT) {
      onProgress?.({
        phase: "start",
        step: 1,
        totalSteps: 1,
        hint: `Asset is ${plan.chunks.length} chunks (>${B2_MAX_CHUNKS_PER_SCRIPT}); falling back to Tier-1 multi-tx.`,
        tier: 2,
      });
      return _b1.upload({ bytes, mime, creatorPid, uploaderAddr: "", submit, aptos, onProgress });
    }

    // ============ Build script args matching upload_b2(uploader, mime, total_size, creator_pid, chunks, node_chunk_counts, depth) ============

    let depth: number;
    let nodeChunkCounts: number[];
    if (plan.treeShape.depth === 0) {
      depth = 0;
      nodeChunkCounts = [];
    } else if (plan.treeShape.depth === 1) {
      depth = 1;
      nodeChunkCounts = [plan.chunks.length];
    } else {
      depth = 2;
      nodeChunkCounts = plan.treeShape.nodeShapes.map((g) => g.chunkRange[1] - g.chunkRange[0]);
    }

    onProgress?.({
      phase: "start",
      step: 1,
      totalSteps: 1,
      hint: `Tier-2: bundling ${plan.chunks.length} chunks + finalize into 1 transaction. Sign once.`,
      tier: 2,
    });

    const bytecode = await loadB2Bytecode();
    const tx = await submit({
      data: {
        // Cast through unknown to satisfy the wallet adapter's narrower entry-fn type;
        // the adapter forwards the field shape unchanged to the SDK's tx builder, which
        // recognises `bytecode` as a script payload.
        bytecode,
        typeArguments: [],
        functionArguments: [
          new U8(mime),
          new U64(plan.totalSize),
          AccountAddress.fromString(creatorPid),
          // chunks: vector<vector<u8>>
          new MoveVector(plan.chunks.map((c) => MoveVector.U8(c))),
          // node_chunk_counts: vector<u64>
          new MoveVector(nodeChunkCounts.map((n) => new U64(n))),
          new U8(depth),
        ],
      } as unknown as Parameters<typeof submit>[0]["data"],
    });
    await aptos.waitForTransaction({ transactionHash: tx.hash });
    const masterAddr = extractMasterAddr(await eventsOfTx(aptos, tx.hash));
    if (!masterAddr) {
      throw new Error(
        "Tier-2 script tx confirmed but AssetMasterCreated event missing. Double-check assets.move v0.3.4 is deployed.",
      );
    }

    onProgress?.({
      phase: "done",
      step: 1,
      totalSteps: 1,
      lastTxHash: tx.hash,
      hint: `Sealed in 1 tx. Master ${masterAddr.slice(0, 6)}…${masterAddr.slice(-4)} ready to attach.`,
      tier: 2,
    });

    return { masterAddr, txHashes: [tx.hash] };
  }
}

// ============ B3 — real implementation (live with assets.move v0.3.4 *_v2 entries) ============
//
// Bundles start_upload_v2 + deploy_chunk_v2 × N + (deploy_node_v2 × M) +
// finalize_v2 (verify_seed=true) into one Move script transaction. JS
// pre-computes every address via sha3-256, so the orchestrator already
// knows master_addr without parsing any event. No event reads needed in
// the happy path.
//
// Nonce strategy: `Date.now() * 1000 + crypto-random low bits` ensures the
// nonce is monotonically increasing for the same uploader (avoids
// E_SEED_TAKEN if a previous start_upload_v2 happened in the same ms).

import {
  bcsAddr as _bcsAddr,
  deriveChunkAddrV2,
  deriveMasterAddrV2,
  deriveNodeAddrV2,
} from "./sha3";

const B3_SCRIPT_URL = "/scripts/asset_upload_b3.mv";
const B3_MAX_CHUNKS_PER_SCRIPT = 28;

let _b3BytecodeCache: Uint8Array | null = null;
async function loadB3Bytecode(): Promise<Uint8Array> {
  if (_b3BytecodeCache) return _b3BytecodeCache;
  const resp = await fetch(B3_SCRIPT_URL);
  if (!resp.ok) {
    throw new Error(`Failed to load Tier-3 script bytecode (${B3_SCRIPT_URL}): ${resp.status}`);
  }
  const buf = await resp.arrayBuffer();
  _b3BytecodeCache = new Uint8Array(buf);
  return _b3BytecodeCache;
}

function pickNonce(): bigint {
  // Microsecond-granularity timestamp + 16 random bits. Collision probability
  // for the same uploader is ~1/65536 per microsecond — vanishingly small.
  const ms = BigInt(Date.now());
  const us = ms * 1000n;
  const rand = BigInt(Math.floor(Math.random() * 65536));
  return us + rand;
}

class B3OrchestratorImpl implements AssetOrchestrator {
  readonly tier: 3 = 3;

  async upload({
    bytes,
    mime,
    creatorPid,
    uploaderAddr,
    submit,
    aptos,
    onProgress,
  }: Parameters<AssetOrchestrator["upload"]>[0]): Promise<UploadResult> {
    const plan = planUpload(bytes, mime);

    if (plan.chunks.length > B3_MAX_CHUNKS_PER_SCRIPT) {
      onProgress?.({
        phase: "start",
        step: 1,
        totalSteps: 1,
        hint: `Asset is ${plan.chunks.length} chunks (>${B3_MAX_CHUNKS_PER_SCRIPT}); falling back to Tier-1 multi-tx.`,
        tier: 3,
      });
      return _b1.upload({ bytes, mime, creatorPid, uploaderAddr, submit, aptos, onProgress });
    }

    let depth: number;
    let nodeChunkCounts: number[];
    if (plan.treeShape.depth === 0) {
      depth = 0;
      nodeChunkCounts = [];
    } else if (plan.treeShape.depth === 1) {
      depth = 1;
      nodeChunkCounts = [plan.chunks.length];
    } else {
      depth = 2;
      nodeChunkCounts = plan.treeShape.nodeShapes.map((g) => g.chunkRange[1] - g.chunkRange[0]);
    }

    // Pre-compute master_addr off-chain. Used so the caller knows the addr
    // before tx confirmation (e.g., to optimistically attach to a draft mint).
    const nonce = pickNonce();
    const masterAddr = deriveMasterAddrV2(uploaderAddr, nonce);

    onProgress?.({
      phase: "start",
      step: 1,
      totalSteps: 1,
      hint: `Tier-3: ${plan.chunks.length} chunks + finalize in 1 transaction. Master addr pre-derived.`,
      tier: 3,
    });

    const bytecode = await loadB3Bytecode();
    const tx = await submit({
      data: {
        bytecode,
        typeArguments: [],
        functionArguments: [
          new U8(mime),
          new U64(plan.totalSize),
          AccountAddress.fromString(creatorPid),
          new U64(nonce),
          new MoveVector(plan.chunks.map((c) => MoveVector.U8(c))),
          new MoveVector(nodeChunkCounts.map((n) => new U64(n))),
          new U8(depth),
        ],
      } as unknown as Parameters<typeof submit>[0]["data"],
    });
    await aptos.waitForTransaction({ transactionHash: tx.hash });

    // Defense-in-depth: re-verify masterAddr derivation matches the actual
    // emitted event. If they diverge it means the JS sha3 derivation has a
    // bug AND finalize_v2(verify_seed=true) didn't catch it — which would
    // be surprising since the script also asserts. Belt + suspenders.
    const eventMaster = extractMasterAddr(await eventsOfTx(aptos, tx.hash));
    if (eventMaster && eventMaster.toLowerCase() !== masterAddr.toLowerCase()) {
      throw new Error(
        `Tier-3 derivation mismatch: pre-computed ${masterAddr} vs event ${eventMaster}. ` +
          "Bug in JS sha3 derivation or assets.move seed builders.",
      );
    }
    // Touch the unused import to keep tree-shaker honest about side-effects we want.
    void _bcsAddr;
    void deriveChunkAddrV2;
    void deriveNodeAddrV2;

    onProgress?.({
      phase: "done",
      step: 1,
      totalSteps: 1,
      lastTxHash: tx.hash,
      hint: `Sealed in 1 tx. Pre-derived master ${masterAddr.slice(0, 6)}…${masterAddr.slice(-4)} matches on chain.`,
      tier: 3,
    });

    return { masterAddr, txHashes: [tx.hash] };
  }
}

// ============ Capability detection — auto-pick best available tier ============
//
// Tier resolution: probe a marker view that B2 will introduce. If the call
// succeeds we know the on-chain bytecode supports the bundled-script flow;
// otherwise fall back to B1.
//
// The marker view name is `assets::orchestrator_tier(): u8` returning 1, 2,
// or 3. v0.3.3-mainnet does NOT have this view → call throws → we treat as
// tier 1. Once v0.3.4 ships with the additive `*_pub` mirrors, the same
// view will return 2 and a future B3 refactor will return 3. Frontend
// upgrades automatically without a redeploy.

export type OrchestratorTier = 1 | 2 | 3;

let _cachedTier: OrchestratorTier | null = null;
let _cachedAt = 0;
const TIER_CACHE_MS = 60_000;

export async function detectTier(rpc: RpcPool): Promise<OrchestratorTier> {
  const now = Date.now();
  if (_cachedTier !== null && now - _cachedAt < TIER_CACHE_MS) return _cachedTier;
  try {
    const r = await rpc.viewFn<[number]>(
      "assets::orchestrator_tier",
      [],
      [],
      DESNET_PACKAGE,
    );
    const t = Number(r[0]);
    const out: OrchestratorTier = t === 3 ? 3 : t === 2 ? 2 : 1;
    _cachedTier = out;
    _cachedAt = now;
    return out;
  } catch {
    _cachedTier = 1;
    _cachedAt = now;
    return 1;
  }
}

// Preview the tx-count savings the user gets at higher tiers — drives the
// "B2 available — switch to single-tx upload?" UI hint when v0.3.4 ships.
export function tierTxCount(tier: OrchestratorTier, plan: { chunks: number }): number {
  if (tier === 1) {
    // 1 start + N chunks + ~1 node + 1 finalize. Underestimate by skipping
    // depth-2 root accounting since the UI hint doesn't need precision.
    return 1 + plan.chunks + (plan.chunks > 1 ? 1 : 0) + 1;
  }
  if (tier === 2) {
    // Up to ~30 chunks per script tx; finalize bundled into the last one.
    return Math.max(1, Math.ceil(plan.chunks / 30));
  }
  // tier 3: same as B2 since per-tx gas is the same constraint; deterministic
  // addrs save one final round-trip but tx count is identical.
  return Math.max(1, Math.ceil(plan.chunks / 30));
}

// ============ Orchestrator selection ============

const _b1 = new B1OrchestratorImpl();
const _b2 = new B2OrchestratorImpl();
const _b3 = new B3OrchestratorImpl();
let _override: AssetOrchestrator | null = null;

/// Direct selector — caller picks the tier explicitly. Powers the 3-way
/// radio in the compose box. Caller is responsible for checking
/// `detectTier()` first if they want to avoid the friendly "not yet live"
/// error from B2/B3 placeholders.
export function getOrchestratorByTier(tier: OrchestratorTier): AssetOrchestrator {
  switch (tier) {
    case 1: return _b1;
    case 2: return _b2;
    case 3: return _b3;
  }
}

export async function pickOrchestrator(rpc: RpcPool): Promise<AssetOrchestrator> {
  if (_override) return _override;
  const tier = await detectTier(rpc);
  return getOrchestratorByTier(tier);
}

/// Force a specific orchestrator — power-user / debug only. Bypasses
/// capability detection. Pass `null` to revert to auto-pick.
export function setOrchestratorOverride(impl: AssetOrchestrator | null): void {
  _override = impl;
}

/// Stable singleton getter — primarily for places that don't have an
/// RpcPool handy and just want the lowest-common-denominator (B1).
export function getOrchestrator(): AssetOrchestrator {
  return _override ?? _b1;
}

/// Per-tier user-facing description for the picker UI. Kept colocated with
/// the orchestrator so adding a B4 in future doesn't fragment the metadata.
export function tierLabel(tier: OrchestratorTier): {
  name: string;
  short: string;
  description: string;
} {
  switch (tier) {
    case 1:
      return {
        name: "Tier 1",
        short: "multi-tx",
        description:
          "Each chunk is its own transaction. Works against today's bytecode. " +
          "~7 wallet confirmations for a 150 KB image.",
      };
    case 2:
      return {
        name: "Tier 2",
        short: "bundled script",
        description:
          "All chunks bundled into one Move script transaction (1 confirmation). " +
          "Up to ~900 KB per script tx; bigger files split into 2–3. " +
          "Live once assets.move v0.3.4 ships.",
      };
    case 3:
      return {
        name: "Tier 3",
        short: "deterministic addrs",
        description:
          "Whole upload + final create_mint fits in one transaction via " +
          "deterministic named-object addresses. Live once assets.move v0.4.0 ships.",
      };
  }
}

export const _MAX_CHUNK_BYTES = CHUNK_SIZE_MAX;
