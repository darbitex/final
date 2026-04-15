import {
  AGGREGATOR_PACKAGE,
  HYPERION_ACTIVE_TIER,
  type TokenConfig,
} from "../../config";
import { createRpcPool } from "../rpc-pool";
import type { VenueAdapter, VenueQuote, VenueSwapParams, VenueTxPayload } from "./types";

const rpc = createRpcPool("hyperion");

// Negative + positive pair cache. The pool address for a given pair is
// stable unless the pool is destroyed/recreated — 5 minute TTL is safe.
// Caching the negative result is equally important so we don't re-probe
// pairs that Hyperion doesn't route on every quote refresh.
type PairEntry = { pool: string | null; ts: number };
const pairCache = new Map<string, PairEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function pairKey(metaA: string, metaB: string): string {
  const [a, b] =
    metaA.toLowerCase() < metaB.toLowerCase()
      ? [metaA.toLowerCase(), metaB.toLowerCase()]
      : [metaB.toLowerCase(), metaA.toLowerCase()];
  return `${a}:${b}`;
}

async function poolExists(metaA: string, metaB: string): Promise<boolean> {
  try {
    const res = await rpc.viewFn<[boolean]>(
      "aggregator::hyperion_pool_exists",
      [],
      [metaA, metaB, HYPERION_ACTIVE_TIER],
      AGGREGATOR_PACKAGE,
    );
    return Boolean(res[0]);
  } catch {
    return false;
  }
}

async function getPool(metaA: string, metaB: string): Promise<string | null> {
  try {
    const res = await rpc.viewFn<[string]>(
      "aggregator::hyperion_get_pool",
      [],
      [metaA, metaB, HYPERION_ACTIVE_TIER],
      AGGREGATOR_PACKAGE,
    );
    return String(res[0]);
  } catch {
    return null;
  }
}

async function resolvePool(metaIn: string, metaOut: string): Promise<string | null> {
  const key = pairKey(metaIn, metaOut);
  const hit = pairCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.pool;
  // Hyperion sorts the pair by address bytes internally — pass canonical
  // order for pool lookups.
  const [metaA, metaB] =
    metaIn.toLowerCase() < metaOut.toLowerCase()
      ? [metaIn, metaOut]
      : [metaOut, metaIn];
  const exists = await poolExists(metaA, metaB);
  const pool = exists ? await getPool(metaA, metaB) : null;
  pairCache.set(key, { pool, ts: Date.now() });
  return pool;
}

async function quoteSinglePool(
  pool: string,
  tokenIn: string,
  amountInRaw: bigint,
): Promise<bigint> {
  try {
    const res = await rpc.viewFn<[string | number]>(
      "aggregator::quote_hyperion",
      [],
      [pool, tokenIn, amountInRaw.toString()],
      AGGREGATOR_PACKAGE,
    );
    return BigInt(String(res[0] ?? "0"));
  } catch {
    return 0n;
  }
}

async function quote(
  tokenIn: TokenConfig,
  tokenOut: TokenConfig,
  amountInRaw: bigint,
): Promise<VenueQuote | null> {
  const pool = await resolvePool(tokenIn.meta, tokenOut.meta);
  if (!pool) return null;
  const out = await quoteSinglePool(pool, tokenIn.meta, amountInRaw);
  if (out === 0n) return null;
  return {
    venue: "Hyperion",
    amountOutRaw: out,
    poolAddr: pool,
  };
}

function buildSwapTx(params: VenueSwapParams): VenueTxPayload {
  if (!params.quote.poolAddr) {
    throw new Error("Hyperion quote missing poolAddr");
  }
  // aToB is the direction flag — true if tokenIn is the sorted-A side
  // of the pair, false if tokenIn is sorted-B. Hyperion's swap entry
  // uses this to pick the right side of the pool.
  const aToB =
    params.tokenIn.meta.toLowerCase() < params.tokenOut.meta.toLowerCase();
  return {
    function: `${AGGREGATOR_PACKAGE}::aggregator::swap_hyperion`,
    typeArguments: [],
    functionArguments: [
      params.quote.poolAddr,
      params.tokenIn.meta,
      aToB,
      params.amountInRaw.toString(),
      params.minOutRaw.toString(),
      params.deadlineSecs.toString(),
    ],
  };
}

export const hyperionAdapter: VenueAdapter = {
  id: "hyperion",
  label: "Hyperion",
  quote,
  buildSwapTx,
};
