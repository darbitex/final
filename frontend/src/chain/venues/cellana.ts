import { AGGREGATOR_PACKAGE, type TokenConfig } from "../../config";
import { createRpcPool } from "../rpc-pool";
import type { VenueAdapter, VenueQuote, VenueSwapParams, VenueTxPayload } from "./types";

const rpc = createRpcPool("cellana");

// Cellana has two curves per pair: stable and volatile. We don't know
// which one is active for a given pair without probing, so cold path
// fires both in parallel and takes the one with non-zero output.
// Warm path hits only the cached active curve.
//
// Curve activation is effectively permanent per pair in production
// (Cellana doesn't migrate pairs between curves), so the 5-min TTL is
// just a safety floor. Negative cache (neither curve routes) is
// stored so we don't re-probe unroutable pairs on every refresh.
type Active = boolean | null; // true=stable, false=volatile, null=none
type CacheEntry = { active: Active; ts: number };
const curveCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function pairKey(metaIn: string, metaOut: string): string {
  const [a, b] =
    metaIn.toLowerCase() < metaOut.toLowerCase()
      ? [metaIn.toLowerCase(), metaOut.toLowerCase()]
      : [metaOut.toLowerCase(), metaIn.toLowerCase()];
  return `${a}:${b}`;
}

async function quoteCurve(
  metaIn: string,
  metaOut: string,
  amountInRaw: bigint,
  isStable: boolean,
): Promise<bigint> {
  try {
    const res = await rpc.viewFn<[string | number]>(
      "aggregator::quote_cellana",
      [],
      [metaIn, metaOut, amountInRaw.toString(), isStable],
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
  const key = pairKey(tokenIn.meta, tokenOut.meta);
  const hit = curveCache.get(key);

  // Warm path: cached active curve → 1 call.
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    if (hit.active === null) return null;
    const out = await quoteCurve(tokenIn.meta, tokenOut.meta, amountInRaw, hit.active);
    if (out === 0n) return null;
    return {
      venue: hit.active ? "Cellana (stable)" : "Cellana (volatile)",
      amountOutRaw: out,
      // No poolAddr — Cellana is queried by asset pair, not pool address.
      // The curve flag is all we need for execution.
    };
  }

  // Cold path: probe both curves in parallel. The probe IS the quote
  // for this refresh — no extra call is wasted.
  const [volatile, stable] = await Promise.all([
    quoteCurve(tokenIn.meta, tokenOut.meta, amountInRaw, false),
    quoteCurve(tokenIn.meta, tokenOut.meta, amountInRaw, true),
  ]);

  if (volatile === 0n && stable === 0n) {
    curveCache.set(key, { active: null, ts: Date.now() });
    return null;
  }

  const active = stable > volatile;
  const amountOut = active ? stable : volatile;
  curveCache.set(key, { active, ts: Date.now() });

  return {
    venue: active ? "Cellana (stable)" : "Cellana (volatile)",
    amountOutRaw: amountOut,
  };
}

function buildSwapTx(params: VenueSwapParams): VenueTxPayload {
  // Recover the active curve from cache. If the user executes within
  // the same quote cycle, cache always has the entry. Default to
  // volatile if somehow missing — safer than failing, and the min_out
  // floor will catch any surprise if the pool state drifted.
  const key = pairKey(params.tokenIn.meta, params.tokenOut.meta);
  const hit = curveCache.get(key);
  const isStable = hit?.active === true;

  return {
    function: `${AGGREGATOR_PACKAGE}::aggregator::swap_cellana`,
    typeArguments: [],
    functionArguments: [
      params.tokenIn.meta,
      params.tokenOut.meta,
      isStable,
      params.amountInRaw.toString(),
      params.minOutRaw.toString(),
      params.deadlineSecs.toString(),
    ],
  };
}

export const cellanaAdapter: VenueAdapter = {
  id: "cellana",
  label: "Cellana",
  quote,
  buildSwapTx,
};
