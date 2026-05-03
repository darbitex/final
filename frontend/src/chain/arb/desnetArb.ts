// chain/arb/desnetArb.ts — atomic 2-leg APT arb between DeSNet AMM and
// Darbitex AMM via a precompiled Move script (no on-chain package deploy).
//
// Bytecode is loaded once from /scripts/arb_apt_through_desnet.mv and
// submitted as a script payload by the user's wallet adapter.
//
// Pricing model:
//   Direction A (desnet_first=true)  : APT → DeSNet → $TOKEN → Darbitex → APT
//   Direction B (desnet_first=false) : APT → Darbitex → $TOKEN → DeSNet → APT
//
// Frontend chooses the more profitable direction at preview time and
// submits with that flag. Single tx — both legs revert together.

import {
  AccountAddress,
  Bool,
  MoveVector,
  U64,
  U8,
} from "@aptos-labs/ts-sdk";
import type { RpcPool } from "../rpc-pool";
import {
  computeAmountOut as desnetComputeAmountOut,
  reserves as desnetReserves,
  tokenMetadataAddr,
} from "../desnet/amm";

const SCRIPT_URL = "/scripts/arb_apt_through_desnet.mv";

// Promise-cache so concurrent previews/submits share one fetch.
let _bytecode: Promise<Uint8Array> | null = null;
export function loadArbScriptBytecode(): Promise<Uint8Array> {
  if (_bytecode) return _bytecode;
  _bytecode = (async () => {
    const resp = await fetch(SCRIPT_URL);
    if (!resp.ok) {
      _bytecode = null;
      throw new Error(`Failed to load arb script bytecode: ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  })();
  return _bytecode;
}

// ============ Darbitex pool quote (mirrors final/sources/pool.move) ============

const DARBITEX_FEE_BPS = 5n;
const DARBITEX_FEE_DENOM = 10_000n;

// Pool reserves (a, b) — caller must know which side is APT vs $TOKEN
// based on pool metadata (see darbitexPoolReserves below).
export type DarbitexReserves = {
  reserveA: bigint;
  reserveB: bigint;
  metaA: string;
  metaB: string;
};

export async function darbitexPoolReserves(
  rpc: RpcPool,
  poolAddr: string,
  pkgAddr: string,
): Promise<DarbitexReserves> {
  const data = await rpc.rotatedGetResource<{
    reserve_a: string | number;
    reserve_b: string | number;
    metadata_a: { inner: string };
    metadata_b: { inner: string };
  }>(poolAddr, `${pkgAddr}::pool::Pool`);
  return {
    reserveA: BigInt(String(data.reserve_a ?? "0")),
    reserveB: BigInt(String(data.reserve_b ?? "0")),
    metaA: String(data.metadata_a.inner),
    metaB: String(data.metadata_b.inner),
  };
}

// Mirror of darbitex pool::compute_amount_out. 5 bps swap fee on input.
export function darbitexComputeAmountOut(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInAfterFee = amountIn * (DARBITEX_FEE_DENOM - DARBITEX_FEE_BPS);
  const numerator = amountInAfterFee * reserveOut;
  const denominator = reserveIn * DARBITEX_FEE_DENOM + amountInAfterFee;
  return numerator / denominator;
}

// ============ Cycle preview ============

export type ArbDirection = "desnet_first" | "darbitex_first";

export type ArbPreview = {
  direction: ArbDirection;
  // intermediate $TOKEN out from leg 1
  midOut: bigint;
  // final APT out from leg 2
  finalOut: bigint;
  // gross profit = finalOut - aptIn (signed)
  profit: bigint;
  // recommended min_token_mid (slip applied to midOut)
  minTokenMid: bigint;
  // recommended min_apt_out (slip applied to finalOut)
  minAptOut: bigint;
};

const APT_FA_ADDR =
  "0x000000000000000000000000000000000000000000000000000000000000000a";

/** Whether this Darbitex pool's metadata_a is APT (else metadata_b is APT). */
function aptIsSideA(reserves: DarbitexReserves): boolean {
  const a = reserves.metaA.toLowerCase();
  const b = reserves.metaB.toLowerCase();
  if (a === APT_FA_ADDR) return true;
  if (b === APT_FA_ADDR) return false;
  throw new Error(
    `Darbitex pool ${shortAddr(reserves.metaA)}/${shortAddr(reserves.metaB)} is not an APT pair`,
  );
}

function shortAddr(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-4)}`;
}

/**
 * Compute both directions and return the recommendation.
 * @param desnetReservesAptToken (apt_reserve, token_reserve) for the DeSNet handle pool
 * @param dxReserves Darbitex pool reserves + metadata
 * @param aptIn raw APT (octa) the user commits upfront
 * @param slipBps slippage tolerance for min_token_mid/min_apt_out (e.g. 50 = 0.5%)
 */
export function previewArb(
  desnetReservesAptToken: [bigint, bigint],
  dxReserves: DarbitexReserves,
  aptIn: bigint,
  slipBps: number = 50,
): { best: ArbPreview; both: { desnet_first: ArbPreview; darbitex_first: ArbPreview } } {
  const [desnetApt, desnetToken] = desnetReservesAptToken;
  const dxAptIsA = aptIsSideA(dxReserves);
  const dxApt = dxAptIsA ? dxReserves.reserveA : dxReserves.reserveB;
  const dxToken = dxAptIsA ? dxReserves.reserveB : dxReserves.reserveA;

  // Direction A: APT → DeSNet (APT/$TOKEN) → $TOKEN → Darbitex (APT/$TOKEN) → APT
  const a_mid = desnetComputeAmountOut(desnetApt, desnetToken, aptIn);
  const a_final = darbitexComputeAmountOut(dxToken, dxApt, a_mid);

  // Direction B: APT → Darbitex → $TOKEN → DeSNet → APT
  const b_mid = darbitexComputeAmountOut(dxApt, dxToken, aptIn);
  const b_final = desnetComputeAmountOut(desnetToken, desnetApt, b_mid);

  const slipMul = BigInt(10000 - slipBps);

  const a: ArbPreview = {
    direction: "desnet_first",
    midOut: a_mid,
    finalOut: a_final,
    profit: a_final - aptIn,
    minTokenMid: (a_mid * slipMul) / 10000n,
    minAptOut: (a_final * slipMul) / 10000n,
  };
  const b: ArbPreview = {
    direction: "darbitex_first",
    midOut: b_mid,
    finalOut: b_final,
    profit: b_final - aptIn,
    minTokenMid: (b_mid * slipMul) / 10000n,
    minAptOut: (b_final * slipMul) / 10000n,
  };
  const best = a.profit >= b.profit ? a : b;
  return { best, both: { desnet_first: a, darbitex_first: b } };
}

/**
 * Auto-discover the canonical Darbitex APT pool for a given $TOKEN metadata
 * address. Returns null if no pool exists. Uses Darbitex's own
 * `pool_factory::canonical_pool_address_of(metaA, metaB)` view — symmetric
 * w.r.t. arg order, so we can pass APT-side first without worrying about
 * which side the pool registry stored.
 *
 * Returns null when the view returns 0x0 (no pool registered for this pair).
 */
export async function discoverDarbitexPoolForToken(
  rpc: RpcPool,
  tokenMetaAddr: string,
  pkgAddr: string,
): Promise<string | null> {
  try {
    const [addr] = await rpc.viewFn<[string]>(
      "pool_factory::canonical_pool_address_of",
      [],
      [APT_FA_ADDR, tokenMetaAddr],
      pkgAddr,
    );
    const s = String(addr ?? "");
    return /^0x0+$/.test(s) ? null : s;
  } catch {
    return null;
  }
}

/**
 * Combined: handle → token meta → matching Darbitex pool. Returns the pool
 * addr + the resolved token meta (caller usually needs both downstream).
 * Returns null if either lookup fails.
 */
export async function discoverArbVenue(
  rpc: RpcPool,
  desnetHandle: string,
  pkgAddr: string,
): Promise<{ tokenMetaAddr: string; darbitexPoolAddr: string } | null> {
  try {
    const tokenMetaAddr = await tokenMetadataAddr(rpc, desnetHandle);
    if (!tokenMetaAddr || /^0x0+$/.test(tokenMetaAddr)) return null;
    const darbitexPoolAddr = await discoverDarbitexPoolForToken(rpc, tokenMetaAddr, pkgAddr);
    if (!darbitexPoolAddr) return null;
    return { tokenMetaAddr, darbitexPoolAddr };
  } catch {
    return null;
  }
}

/**
 * Convenience composer — fetches reserves + token metadata + computes preview.
 */
export async function fetchAndPreview(
  rpc: RpcPool,
  desnetHandle: string,
  darbitexPoolAddr: string,
  darbitexPkgAddr: string,
  aptIn: bigint,
  slipBps?: number,
): Promise<{
  preview: ReturnType<typeof previewArb>;
  tokenMetaAddr: string;
}> {
  const [desnetR, dxR, tokenMeta] = await Promise.all([
    desnetReserves(rpc, desnetHandle),
    darbitexPoolReserves(rpc, darbitexPoolAddr, darbitexPkgAddr),
    tokenMetadataAddr(rpc, desnetHandle),
  ]);
  return {
    preview: previewArb(desnetR, dxR, aptIn, slipBps),
    tokenMetaAddr: tokenMeta,
  };
}

// ============ Script payload builder ============

/**
 * Build the arguments tuple in the order the script declares them.
 * The wallet adapter expects functionArguments as serializable values
 * (not raw tuples); we wrap each in the SDK's typed wrapper so BCS
 * encoding stays explicit and order-correct.
 */
export function buildArbScriptArgs(args: {
  desnetHandle: string;
  darbitexPoolAddr: string;
  tokenMetaAddr: string;
  aptIn: bigint;
  minTokenMid: bigint;
  minAptOut: bigint;
  minProfit: bigint;
  desnetFirst: boolean;
}) {
  const handleBytes = new TextEncoder().encode(args.desnetHandle);
  return [
    MoveVector.U8(Array.from(handleBytes)),
    AccountAddress.fromString(args.darbitexPoolAddr),
    AccountAddress.fromString(args.tokenMetaAddr),
    new U64(args.aptIn),
    new U64(args.minTokenMid),
    new U64(args.minAptOut),
    new U64(args.minProfit),
    new Bool(args.desnetFirst),
  ];
}

/**
 * Build the full transaction data payload for `signAndSubmitTransaction`.
 * Caller does NOT need to know the script hash — bytecode is fetched and
 * passed verbatim to the adapter, which recognises script payloads when
 * `bytecode` is present instead of `function`.
 */
export async function buildArbTxData(args: Parameters<typeof buildArbScriptArgs>[0]): Promise<{
  bytecode: Uint8Array;
  typeArguments: string[];
  functionArguments: ReturnType<typeof buildArbScriptArgs>;
}> {
  const bytecode = await loadArbScriptBytecode();
  return {
    bytecode,
    typeArguments: [],
    functionArguments: buildArbScriptArgs(args),
  };
}

// Suppress unused warning if SDK helpers aren't used elsewhere in this file.
export const _SDK_TYPES_UNUSED_GUARD = U8;
