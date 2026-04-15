import { THALA_ADAPTER_PACKAGE, THALA_POOL_SEEDS, type TokenConfig } from "../../config";
import { createRpcPool, metaEq } from "../rpc-pool";
import type { VenueAdapter, VenueQuote, VenueSwapParams, VenueTxPayload } from "./types";

// Dedicated RPC pool — Thala's runtime pool-assets warmup + per-quote
// calls run in isolation from the Darbitex view pool on the same
// page, so a Thala RPC burst can't starve the Darbitex direct/smart
// quote calls next to it.
const rpc = createRpcPool("thala");

type ThalaPoolEntry = {
  addr: string;
  assets: string[];
};

let registry: ThalaPoolEntry[] | null = null;
let warming: Promise<void> | null = null;

async function warmup(): Promise<void> {
  if (registry !== null) return;
  if (warming) return warming;

  warming = (async () => {
    const entries: ThalaPoolEntry[] = [];
    // Parallelize the asset probes — each seed is independent and
    // beta's snapshot generator does them sequentially only because
    // it runs once at build time. Here we want fast cold boot.
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
    registry = entries;
  })();

  try {
    await warming;
  } finally {
    warming = null;
  }
}

function findPoolForPair(metaIn: string, metaOut: string): string | null {
  if (!registry) return null;
  for (const p of registry) {
    const hasIn = p.assets.some((m) => metaEq(m, metaIn));
    const hasOut = p.assets.some((m) => metaEq(m, metaOut));
    if (hasIn && hasOut) return p.addr;
  }
  return null;
}

async function quote(
  tokenIn: TokenConfig,
  tokenOut: TokenConfig,
  amountInRaw: bigint,
): Promise<VenueQuote | null> {
  if (registry === null) await warmup();
  const pool = findPoolForPair(tokenIn.meta, tokenOut.meta);
  if (!pool) return null;
  try {
    const [outStr] = await rpc.viewFn<[string | number]>(
      "adapter::quote",
      [],
      [pool, tokenIn.meta, tokenOut.meta, amountInRaw.toString()],
      THALA_ADAPTER_PACKAGE,
    );
    const outRaw = BigInt(String(outStr ?? "0"));
    if (outRaw === 0n) return null;
    return {
      venue: "Thala",
      amountOutRaw: outRaw,
      poolAddr: pool,
    };
  } catch (e) {
    return {
      venue: "Thala",
      amountOutRaw: 0n,
      error: (e as Error).message,
    };
  }
}

function buildSwapTx(params: VenueSwapParams): VenueTxPayload {
  if (!params.quote.poolAddr) {
    throw new Error("Thala quote missing poolAddr");
  }
  return {
    function: `${THALA_ADAPTER_PACKAGE}::adapter::swap_entry`,
    typeArguments: [],
    functionArguments: [
      params.quote.poolAddr,
      params.tokenIn.meta,
      params.tokenOut.meta,
      params.amountInRaw.toString(),
      params.minOutRaw.toString(),
      params.deadlineSecs.toString(),
    ],
  };
}

export const thalaAdapter: VenueAdapter = {
  id: "thala",
  label: "Thala",
  warmup,
  quote,
  buildSwapTx,
};
