import {
  AGGREGATOR_PACKAGE,
  FLASHBOT_PACKAGE,
  HYPERION_ACTIVE_TIER,
  PACKAGE,
  THALA_ADAPTER_PACKAGE,
  THALA_POOL_SEEDS,
  TOKENS,
  type TokenConfig,
} from "../config";
import { createRpcPool, metaEq } from "./rpc-pool";

export type FlashbotVenue = "thala" | "hyperion" | "cellana";

// Dedicated RPC pool — flashbot preview runs several parallel view
// calls (direct + smart quotes on two venues in two directions),
// isolated from the Arbitrage page's main "arbitrage" pool so a burst
// of preview calls can't starve the existing cycle-closure UI.
const rpc = createRpcPool("flashbot");

// Metadata seed cache for Thala pool asset pairs. Each seed's assets
// are resolved once on warmup via `adapter::pool_assets` and reused
// on every preview until the page unmounts.
type ThalaPoolEntry = {
  addr: string;
  assets: string[];
};
let thalaRegistry: ThalaPoolEntry[] | null = null;
let thalaWarming: Promise<void> | null = null;

async function warmThalaRegistry(): Promise<void> {
  if (thalaRegistry !== null) return;
  if (thalaWarming) return thalaWarming;
  thalaWarming = (async () => {
    const entries: ThalaPoolEntry[] = [];
    const probes = await Promise.allSettled(
      THALA_POOL_SEEDS.map(async (addr) => {
        const [assets] = await rpc.viewFn<[string[]]>(
          "adapter::pool_assets",
          [],
          [addr],
          THALA_ADAPTER_PACKAGE,
        );
        return { addr, assets: (assets ?? []).map(String) };
      }),
    );
    for (const r of probes) {
      if (r.status === "fulfilled" && r.value.assets.length >= 2) {
        entries.push(r.value);
      }
    }
    thalaRegistry = entries;
  })();
  try {
    await thalaWarming;
  } finally {
    thalaWarming = null;
  }
}

// Find every Thala seed pool that supports both sides of a given
// asset pair. Returns [] if registry isn't warmed yet OR no pool
// matches.
export async function findThalaPoolsForPair(
  metaIn: string,
  metaOut: string,
): Promise<string[]> {
  await warmThalaRegistry();
  if (!thalaRegistry) return [];
  return thalaRegistry
    .filter((p) => {
      const hasIn = p.assets.some((m) => metaEq(m, metaIn));
      const hasOut = p.assets.some((m) => metaEq(m, metaOut));
      return hasIn && hasOut;
    })
    .map((p) => p.addr);
}

export type FlashbotDirectionPreview = {
  /** Leg 1 output in raw units of `other_asset`. */
  leg1Out: bigint;
  /** Leg 2 output in raw units of `borrow_asset` (round-trip). */
  leg2Out: bigint;
  /** leg2Out − borrow_amount. Can be negative (stored as 0n, see `profitable`). */
  profitTotal: bigint;
  /** True if the cycle nets ≥ 0 gross profit (before split). */
  profitable: boolean;
  /** 90% × profitTotal — what the caller would actually receive. */
  callerShare: bigint;
  /** 10% × profitTotal — what the hardcoded treasury gets. */
  treasuryShare: bigint;
};

export type FlashbotPreview = {
  /** Direction A: Darbitex leg 1, Thala leg 2. */
  darbitexFirst: FlashbotDirectionPreview | null;
  /** Direction B: Thala leg 1, Darbitex leg 2. */
  thalaFirst: FlashbotDirectionPreview | null;
  /** Whichever direction has higher callerShare, or null if both are unprofitable. */
  best: {
    thalaFirst: boolean;
    preview: FlashbotDirectionPreview;
  } | null;
};

async function darbitexLeg(
  poolAddr: string,
  fromMeta: string,
  amountInRaw: bigint,
): Promise<bigint> {
  try {
    const [outStr] = await rpc.viewFn<[string]>(
      "arbitrage::quote_path",
      [],
      [[poolAddr], fromMeta, amountInRaw.toString()],
      PACKAGE,
    );
    return BigInt(String(outStr ?? "0"));
  } catch {
    return 0n;
  }
}

async function thalaLeg(
  poolAddr: string,
  fromMeta: string,
  toMeta: string,
  amountInRaw: bigint,
): Promise<bigint> {
  try {
    const [outStr] = await rpc.viewFn<[string | number]>(
      "adapter::quote",
      [],
      [poolAddr, fromMeta, toMeta, amountInRaw.toString()],
      THALA_ADAPTER_PACKAGE,
    );
    return BigInt(String(outStr ?? "0"));
  } catch {
    return 0n;
  }
}

/**
 * Off-chain preview of a flashbot cycle. Runs both directions in
 * parallel via view calls, then computes the 90/10 split for each
 * direction. The "best" pick is whichever direction yields the
 * higher caller share — if both are unprofitable, `best` is null.
 *
 * IMPORTANT: the `min_net_profit` floor on-chain is checked against
 * the caller share (post-split), not the gross profit. The frontend
 * should pass `callerShare × (1 − slippage)` as `min_net_profit`
 * when it submits the tx, to leave headroom for reserve drift
 * between preview and execution.
 */
export async function previewFlashbotCycle(params: {
  borrowAsset: TokenConfig;
  borrowAmountRaw: bigint;
  otherAsset: TokenConfig;
  darbitexPool: string;
  thalaPool: string;
}): Promise<FlashbotPreview> {
  const { borrowAsset, borrowAmountRaw, otherAsset, darbitexPool, thalaPool } =
    params;

  const [darbOut, thalaOut] = await Promise.all([
    darbitexLeg(darbitexPool, borrowAsset.meta, borrowAmountRaw),
    thalaLeg(thalaPool, borrowAsset.meta, otherAsset.meta, borrowAmountRaw),
  ]);

  const [darbitexFirstLeg2, thalaFirstLeg2] = await Promise.all([
    darbOut > 0n
      ? thalaLeg(thalaPool, otherAsset.meta, borrowAsset.meta, darbOut)
      : Promise.resolve(0n),
    thalaOut > 0n
      ? darbitexLeg(darbitexPool, otherAsset.meta, thalaOut)
      : Promise.resolve(0n),
  ]);

  const compute = (leg1: bigint, leg2: bigint): FlashbotDirectionPreview | null => {
    if (leg1 === 0n) return null;
    const profit = leg2 > borrowAmountRaw ? leg2 - borrowAmountRaw : 0n;
    const profitable = leg2 > borrowAmountRaw;
    const treasuryShare = (profit * 1000n) / 10_000n;
    const callerShare = profit - treasuryShare;
    return {
      leg1Out: leg1,
      leg2Out: leg2,
      profitTotal: profit,
      profitable,
      callerShare,
      treasuryShare,
    };
  };

  const darbitexFirst = compute(darbOut, darbitexFirstLeg2);
  const thalaFirst = compute(thalaOut, thalaFirstLeg2);

  let best: FlashbotPreview["best"] = null;
  const candidates: Array<{ thalaFirst: boolean; p: FlashbotDirectionPreview }> = [];
  if (darbitexFirst && darbitexFirst.profitable) {
    candidates.push({ thalaFirst: false, p: darbitexFirst });
  }
  if (thalaFirst && thalaFirst.profitable) {
    candidates.push({ thalaFirst: true, p: thalaFirst });
  }
  if (candidates.length > 0) {
    const winner = candidates.sort((a, b) =>
      b.p.callerShare > a.p.callerShare ? 1 : b.p.callerShare < a.p.callerShare ? -1 : 0,
    )[0];
    best = { thalaFirst: winner.thalaFirst, preview: winner.p };
  }

  return { darbitexFirst, thalaFirst, best };
}

/**
 * Build the `run_arb` entry function payload for
 * `signAndSubmitTransaction`. Callers provide the pre-computed
 * direction + min_net_profit from a preview.
 */
export function buildRunArbPayload(params: {
  borrowAsset: TokenConfig;
  borrowAmountRaw: bigint;
  otherAsset: TokenConfig;
  darbitexSwapPool: string;
  thalaSwapPool: string;
  thalaFirst: boolean;
  minNetProfitRaw: bigint;
  deadlineSecs: number;
}) {
  return {
    function: `${FLASHBOT_PACKAGE}::flashbot::run_arb`,
    typeArguments: [] as string[],
    functionArguments: [
      params.borrowAsset.meta,
      params.borrowAmountRaw.toString(),
      params.otherAsset.meta,
      params.darbitexSwapPool,
      params.thalaSwapPool,
      params.thalaFirst,
      params.minNetProfitRaw.toString(),
      params.deadlineSecs.toString(),
    ],
  };
}

// ===== Hyperion helpers =====

async function hyperionResolvePool(
  metaA: string,
  metaB: string,
): Promise<string | null> {
  try {
    const [exists] = await rpc.viewFn<[boolean]>(
      "aggregator::hyperion_pool_exists",
      [],
      [metaA, metaB, HYPERION_ACTIVE_TIER],
      AGGREGATOR_PACKAGE,
    );
    if (!exists) return null;
    const [addr] = await rpc.viewFn<[string]>(
      "aggregator::hyperion_get_pool",
      [],
      [metaA, metaB, HYPERION_ACTIVE_TIER],
      AGGREGATOR_PACKAGE,
    );
    return String(addr);
  } catch {
    return null;
  }
}

async function hyperionLeg(
  poolAddr: string,
  fromMeta: string,
  amountInRaw: bigint,
): Promise<bigint> {
  try {
    const [outStr] = await rpc.viewFn<[string | number]>(
      "aggregator::quote_hyperion",
      [],
      [poolAddr, fromMeta, amountInRaw.toString()],
      AGGREGATOR_PACKAGE,
    );
    return BigInt(String(outStr ?? "0"));
  } catch {
    return 0n;
  }
}

export async function findHyperionPoolForPair(
  metaA: string,
  metaB: string,
): Promise<string | null> {
  const [a, b] =
    metaA.toLowerCase() < metaB.toLowerCase() ? [metaA, metaB] : [metaB, metaA];
  return hyperionResolvePool(a, b);
}

// ===== Cellana helpers =====

async function cellanaLeg(
  fromMeta: string,
  toMeta: string,
  amountInRaw: bigint,
  isStable: boolean,
): Promise<bigint> {
  try {
    const [outStr] = await rpc.viewFn<[string | number]>(
      "aggregator::quote_cellana",
      [],
      [fromMeta, toMeta, amountInRaw.toString(), isStable],
      AGGREGATOR_PACKAGE,
    );
    return BigInt(String(outStr ?? "0"));
  } catch {
    return 0n;
  }
}

// Probe both curves once to discover which one(s) route the pair.
// Returns a list of viable curves (can be 0, 1, or 2 entries).
export async function findCellanaCurvesForPair(
  metaA: string,
  metaB: string,
): Promise<boolean[]> {
  const probe = 1_000_000n;
  const [volatile, stable] = await Promise.all([
    cellanaLeg(metaA, metaB, probe, false),
    cellanaLeg(metaA, metaB, probe, true),
  ]);
  const out: boolean[] = [];
  if (volatile > 0n) out.push(false);
  if (stable > 0n) out.push(true);
  return out;
}

// ===== Hyperion preview =====

export async function previewHyperionCycle(params: {
  borrowAsset: TokenConfig;
  borrowAmountRaw: bigint;
  otherAsset: TokenConfig;
  darbitexPool: string;
  hyperionPool: string;
}): Promise<FlashbotPreview> {
  const { borrowAsset, borrowAmountRaw, otherAsset, darbitexPool, hyperionPool } =
    params;

  const [darbOut, hypOut] = await Promise.all([
    darbitexLeg(darbitexPool, borrowAsset.meta, borrowAmountRaw),
    hyperionLeg(hyperionPool, borrowAsset.meta, borrowAmountRaw),
  ]);

  const [darbFirstLeg2, hypFirstLeg2] = await Promise.all([
    darbOut > 0n
      ? hyperionLeg(hyperionPool, otherAsset.meta, darbOut)
      : Promise.resolve(0n),
    hypOut > 0n
      ? darbitexLeg(darbitexPool, otherAsset.meta, hypOut)
      : Promise.resolve(0n),
  ]);

  const compute = (leg1: bigint, leg2: bigint): FlashbotDirectionPreview | null => {
    if (leg1 === 0n) return null;
    const profit = leg2 > borrowAmountRaw ? leg2 - borrowAmountRaw : 0n;
    const profitable = leg2 > borrowAmountRaw;
    const treasuryShare = (profit * 1000n) / 10_000n;
    const callerShare = profit - treasuryShare;
    return { leg1Out: leg1, leg2Out: leg2, profitTotal: profit, profitable, callerShare, treasuryShare };
  };

  const darbitexFirst = compute(darbOut, darbFirstLeg2);
  const thalaFirst = compute(hypOut, hypFirstLeg2);

  let best: FlashbotPreview["best"] = null;
  const candidates: Array<{ thalaFirst: boolean; p: FlashbotDirectionPreview }> = [];
  if (darbitexFirst && darbitexFirst.profitable) candidates.push({ thalaFirst: false, p: darbitexFirst });
  if (thalaFirst && thalaFirst.profitable) candidates.push({ thalaFirst: true, p: thalaFirst });
  if (candidates.length > 0) {
    const winner = candidates.sort((a, b) =>
      b.p.callerShare > a.p.callerShare ? 1 : b.p.callerShare < a.p.callerShare ? -1 : 0,
    )[0];
    best = { thalaFirst: winner.thalaFirst, preview: winner.p };
  }
  return { darbitexFirst, thalaFirst, best };
}

export function buildRunArbHyperionPayload(params: {
  borrowAsset: TokenConfig;
  borrowAmountRaw: bigint;
  otherAsset: TokenConfig;
  darbitexSwapPool: string;
  hyperionSwapPool: string;
  hyperionFirst: boolean;
  minNetProfitRaw: bigint;
  deadlineSecs: number;
}) {
  // borrow_is_hyperion_side_a: true iff the borrow asset address sorts
  // before the other asset address by byte order. Must match the same
  // sorting Hyperion uses internally to index its pools.
  const borrowIsSideA =
    params.borrowAsset.meta.toLowerCase() < params.otherAsset.meta.toLowerCase();
  return {
    function: `${FLASHBOT_PACKAGE}::flashbot::run_arb_hyperion`,
    typeArguments: [] as string[],
    functionArguments: [
      params.borrowAsset.meta,
      params.borrowAmountRaw.toString(),
      params.otherAsset.meta,
      params.darbitexSwapPool,
      params.hyperionSwapPool,
      borrowIsSideA,
      params.hyperionFirst,
      params.minNetProfitRaw.toString(),
      params.deadlineSecs.toString(),
    ],
  };
}

// ===== Cellana preview =====

export async function previewCellanaCycle(params: {
  borrowAsset: TokenConfig;
  borrowAmountRaw: bigint;
  otherAsset: TokenConfig;
  darbitexPool: string;
  isStable: boolean;
}): Promise<FlashbotPreview> {
  const { borrowAsset, borrowAmountRaw, otherAsset, darbitexPool, isStable } = params;

  const [darbOut, cellOut] = await Promise.all([
    darbitexLeg(darbitexPool, borrowAsset.meta, borrowAmountRaw),
    cellanaLeg(borrowAsset.meta, otherAsset.meta, borrowAmountRaw, isStable),
  ]);

  const [darbFirstLeg2, cellFirstLeg2] = await Promise.all([
    darbOut > 0n
      ? cellanaLeg(otherAsset.meta, borrowAsset.meta, darbOut, isStable)
      : Promise.resolve(0n),
    cellOut > 0n
      ? darbitexLeg(darbitexPool, otherAsset.meta, cellOut)
      : Promise.resolve(0n),
  ]);

  const compute = (leg1: bigint, leg2: bigint): FlashbotDirectionPreview | null => {
    if (leg1 === 0n) return null;
    const profit = leg2 > borrowAmountRaw ? leg2 - borrowAmountRaw : 0n;
    const profitable = leg2 > borrowAmountRaw;
    const treasuryShare = (profit * 1000n) / 10_000n;
    const callerShare = profit - treasuryShare;
    return { leg1Out: leg1, leg2Out: leg2, profitTotal: profit, profitable, callerShare, treasuryShare };
  };

  const darbitexFirst = compute(darbOut, darbFirstLeg2);
  const thalaFirst = compute(cellOut, cellFirstLeg2);

  let best: FlashbotPreview["best"] = null;
  const candidates: Array<{ thalaFirst: boolean; p: FlashbotDirectionPreview }> = [];
  if (darbitexFirst && darbitexFirst.profitable) candidates.push({ thalaFirst: false, p: darbitexFirst });
  if (thalaFirst && thalaFirst.profitable) candidates.push({ thalaFirst: true, p: thalaFirst });
  if (candidates.length > 0) {
    const winner = candidates.sort((a, b) =>
      b.p.callerShare > a.p.callerShare ? 1 : b.p.callerShare < a.p.callerShare ? -1 : 0,
    )[0];
    best = { thalaFirst: winner.thalaFirst, preview: winner.p };
  }
  return { darbitexFirst, thalaFirst, best };
}

export function buildRunArbCellanaPayload(params: {
  borrowAsset: TokenConfig;
  borrowAmountRaw: bigint;
  otherAsset: TokenConfig;
  darbitexSwapPool: string;
  isStable: boolean;
  cellanaFirst: boolean;
  minNetProfitRaw: bigint;
  deadlineSecs: number;
}) {
  return {
    function: `${FLASHBOT_PACKAGE}::flashbot::run_arb_cellana`,
    typeArguments: [] as string[],
    functionArguments: [
      params.borrowAsset.meta,
      params.borrowAmountRaw.toString(),
      params.otherAsset.meta,
      params.darbitexSwapPool,
      params.isStable,
      params.cellanaFirst,
      params.minNetProfitRaw.toString(),
      params.deadlineSecs.toString(),
    ],
  };
}

/** Helper — resolve Darbitex's canonical pool for an asset pair. */
export async function canonicalDarbitexPool(
  metaA: string,
  metaB: string,
): Promise<string | null> {
  try {
    const [addr] = await rpc.viewFn<[string]>(
      "pool_factory::canonical_pool_address_of",
      [],
      [metaA, metaB],
      PACKAGE,
    );
    const str = String(addr ?? "");
    return /^0x0+$/.test(str) ? null : str;
  } catch {
    return null;
  }
}

/** Helper for the Arbitrage page dropdowns — which symbols pair with the anchor. */
export function otherTokensFor(anchor: TokenConfig): TokenConfig[] {
  return Object.values(TOKENS).filter((t) => t.meta !== anchor.meta);
}
