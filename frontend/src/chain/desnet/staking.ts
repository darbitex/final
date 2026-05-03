import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import { handleBytes } from "./profile";

const MOD = "lp_staking";

export type Position = {
  positionAddr: string;
  pool: string;
  shares: bigint;
  unlockAtSecs: number; // u64::MAX = forever-locked
  recipientPid: string;
  owner: string;
};

const UNLOCK_FOREVER_BIG = (1n << 64n) - 1n;

export function isForeverLocked(unlockAtSecs: number | bigint): boolean {
  return BigInt(unlockAtSecs) === UNLOCK_FOREVER_BIG;
}

export async function hasPosition(rpc: RpcPool, positionAddr: string): Promise<boolean> {
  const r = await rpc.viewFn<[boolean]>(
    MOD + "::has_position",
    [],
    [positionAddr],
    DESNET_PACKAGE,
  );
  return Boolean(r[0]);
}

export async function loadPosition(
  rpc: RpcPool,
  positionAddr: string,
): Promise<Position | null> {
  try {
    const [poolR, sharesR, unlockR, pidR, ownerR] = await Promise.all([
      rpc.viewFn<[string]>(MOD + "::position_pool", [], [positionAddr], DESNET_PACKAGE),
      rpc.viewFn<[string]>(MOD + "::position_shares", [], [positionAddr], DESNET_PACKAGE),
      rpc.viewFn<[string]>(MOD + "::position_unlock_at", [], [positionAddr], DESNET_PACKAGE),
      rpc.viewFn<[string]>(
        MOD + "::position_recipient_pid",
        [],
        [positionAddr],
        DESNET_PACKAGE,
      ),
      rpc.viewFn<[string]>(MOD + "::position_owner", [], [positionAddr], DESNET_PACKAGE),
    ]);
    return {
      positionAddr,
      pool: String(poolR[0]),
      shares: BigInt(sharesR[0]),
      unlockAtSecs: Number(unlockR[0]),
      recipientPid: String(pidR[0]),
      owner: String(ownerR[0]),
    };
  } catch {
    return null;
  }
}

// (pending_emission, pending_apt_fee, pending_token_fee) — all in raw u64.
export async function pendingAll(
  rpc: RpcPool,
  positionAddr: string,
): Promise<[bigint, bigint, bigint]> {
  const r = await rpc.viewFn<[string, string, string]>(
    MOD + "::position_pending_all",
    [],
    [positionAddr],
    DESNET_PACKAGE,
  );
  return [BigInt(r[0]), BigInt(r[1]), BigInt(r[2])];
}

export async function poolRatePerSec(rpc: RpcPool, poolAddr: string): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::pool_rate_per_sec",
    [],
    [poolAddr],
    DESNET_PACKAGE,
  );
  return BigInt(r[0]);
}

// LP staking pool addr is deterministic per handle — exposed via a helper view,
// but factory also publishes vault_addr_of_handle pattern. We expose the
// canonical pool resolver by reading the staking pool address-of-handle view.
export async function stakingPoolAddressOfHandle(
  rpc: RpcPool,
  handle: string,
): Promise<string> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::staking_pool_address_of_handle",
    [],
    [handleBytes(handle)],
    DESNET_PACKAGE,
  );
  return String(r[0]);
}
