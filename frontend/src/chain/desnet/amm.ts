import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import { handleBytes } from "./profile";

const MOD = "amm";

// (apt_reserve_octas, token_reserve_raw)
export async function reserves(rpc: RpcPool, handle: string): Promise<[bigint, bigint]> {
  const r = await rpc.viewFn<[string, string]>(
    MOD + "::reserves",
    [],
    [handleBytes(handle)],
    DESNET_PACKAGE,
  );
  return [BigInt(r[0]), BigInt(r[1])];
}

export async function lpSupply(rpc: RpcPool, handle: string): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::lp_supply",
    [],
    [handleBytes(handle)],
    DESNET_PACKAGE,
  );
  return BigInt(r[0]);
}

// (fee_per_lp_apt, fee_per_lp_token) — both u128, scaled by amm::fee_acc_scale()
export async function feePerLp(rpc: RpcPool, handle: string): Promise<[bigint, bigint]> {
  const r = await rpc.viewFn<[string, string]>(
    MOD + "::fee_per_lp",
    [],
    [handleBytes(handle)],
    DESNET_PACKAGE,
  );
  return [BigInt(r[0]), BigInt(r[1])];
}

export async function tokenMetadataAddr(rpc: RpcPool, handle: string): Promise<string> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::token_metadata_addr",
    [],
    [handleBytes(handle)],
    DESNET_PACKAGE,
  );
  return String(r[0]);
}

export async function creatorPid(rpc: RpcPool, handle: string): Promise<string> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::creator_pid",
    [],
    [handleBytes(handle)],
    DESNET_PACKAGE,
  );
  return String(r[0]);
}

// Reserve addresses for a given handle's factory token. Used to compute
// circulating supply (= 1B - lp_reserve_balance - reaction_reserve_balance).
// Pulls from factory::get_token_record which returns the whole TokenRecord
// struct as JSON; we only need the two reserve fields.
export type TokenReserves = {
  lp_reserve: string;
  reaction_reserve: string;
};
export async function tokenReserves(rpc: RpcPool, handle: string): Promise<TokenReserves> {
  const r = await rpc.viewFn<[Record<string, unknown>]>(
    "factory::get_token_record",
    [],
    [handleBytes(handle)],
    DESNET_PACKAGE,
  );
  const rec = r[0];
  return {
    lp_reserve: String(rec.lp_reserve),
    reaction_reserve: String(rec.reaction_reserve),
  };
}

// Gas-free quote — shells out to the pool's view fn.
export async function quote(
  rpc: RpcPool,
  handle: string,
  amountIn: bigint,
  aptToToken: boolean,
): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::quote_swap_exact_in",
    [],
    [handleBytes(handle), amountIn.toString(), aptToToken],
    DESNET_PACKAGE,
  );
  return BigInt(r[0]);
}

// CPMM quote pure-JS (mirrors compute_amount_out, 10 bps fee). Used for live
// preview between debounced view calls.
const FEE_BPS = 10n;
const FEE_DENOM = 10000n;
export function computeAmountOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInAfterFee = amountIn * (FEE_DENOM - FEE_BPS);
  const numerator = amountInAfterFee * reserveOut;
  const denominator = reserveIn * FEE_DENOM + amountInAfterFee;
  return numerator / denominator;
}
