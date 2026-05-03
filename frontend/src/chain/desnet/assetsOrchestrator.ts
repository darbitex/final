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

import type { Aptos } from "@aptos-labs/ts-sdk";
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

// ============ B2 — placeholder (not yet on chain) ============
//
// Becomes live once `assets.move` v0.3.4 ships additive `public fun *_pub`
// variants returning addresses + a `orchestrator_tier(): u8 = 2` view.
// The placeholder below preserves the user-facing API (3-way picker on
// Feed.tsx) and throws a clear, non-cryptic error if the user selects it
// before the bytecode is live.

class B2OrchestratorImpl implements AssetOrchestrator {
  readonly tier: 2 = 2;

  async upload(): Promise<UploadResult> {
    throw new Error(
      "Tier 2 (bundled Move script) is not yet live on chain. " +
        "Ships in `assets.move` v0.3.4 via additive `public fun *_pub` mirrors. " +
        "Use Tier 1 (multi-tx) until then.",
    );
  }
}

// ============ B3 — placeholder (not yet on chain) ============
//
// Requires the bigger `assets.move` refactor: switch to
// `object::create_named_object` with deterministic seeds (`bcs(master||idx)`).
// JS pre-computes all addresses via `sha3_256(creator || seed || 0xFE)` and
// never reads events. Whole upload + create_mint fits in one tx for ≤900 KB.

class B3OrchestratorImpl implements AssetOrchestrator {
  readonly tier: 3 = 3;

  async upload(): Promise<UploadResult> {
    throw new Error(
      "Tier 3 (deterministic-addr single-tx) is not yet live on chain. " +
        "Requires `assets.move` refactor to `create_named_object` (see DeSNet v0.4.0 backlog). " +
        "Use Tier 1 today; Tier 2 once v0.3.4 ships.",
    );
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
