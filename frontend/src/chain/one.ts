import type { RpcPool } from "./rpc-pool";
import { ONE_PACKAGE } from "../config";

const MOD = "ONE";

export type Totals = {
  totalDebt: bigint;
  totalSp: bigint;
  productFactor: bigint;
  rewardIndexOne: bigint;
  rewardIndexColl: bigint;
};

export async function oneTotals(rpc: RpcPool): Promise<Totals> {
  const r = await rpc.viewFn<[string, string, string, string, string]>(
    MOD + "::totals",
    [],
    [],
    ONE_PACKAGE,
  );
  return {
    totalDebt: BigInt(r[0]),
    totalSp: BigInt(r[1]),
    productFactor: BigInt(r[2]),
    rewardIndexOne: BigInt(r[3]),
    rewardIndexColl: BigInt(r[4]),
  };
}

export async function onePrice8dec(rpc: RpcPool): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::price", [], [], ONE_PACKAGE);
  return BigInt(r[0]);
}

export async function oneIsSealed(rpc: RpcPool): Promise<boolean> {
  const r = await rpc.viewFn<[boolean]>(MOD + "::is_sealed", [], [], ONE_PACKAGE);
  return r[0];
}

export async function oneReadWarning(rpc: RpcPool): Promise<string> {
  const r = await rpc.viewFn<[string]>(MOD + "::read_warning", [], [], ONE_PACKAGE);
  const hex = r[0].startsWith("0x") ? r[0].slice(2) : r[0];
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export async function oneTroveOf(
  rpc: RpcPool,
  addr: string,
): Promise<{ collateral: bigint; debt: bigint }> {
  const r = await rpc.viewFn<[string, string]>(
    MOD + "::trove_of",
    [],
    [addr],
    ONE_PACKAGE,
  );
  return { collateral: BigInt(r[0]), debt: BigInt(r[1]) };
}

export async function oneSpOf(
  rpc: RpcPool,
  addr: string,
): Promise<{ effectiveBalance: bigint; pendingOne: bigint; pendingColl: bigint }> {
  const r = await rpc.viewFn<[string, string, string]>(
    MOD + "::sp_of",
    [],
    [addr],
    ONE_PACKAGE,
  );
  return {
    effectiveBalance: BigInt(r[0]),
    pendingOne: BigInt(r[1]),
    pendingColl: BigInt(r[2]),
  };
}

export async function oneReserveBalance(rpc: RpcPool): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::reserve_balance", [], [], ONE_PACKAGE);
  return BigInt(r[0]);
}

export async function oneCloseCost(rpc: RpcPool, addr: string): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::close_cost",
    [],
    [addr],
    ONE_PACKAGE,
  );
  return BigInt(r[0]);
}

export async function oneTroveHealth(
  rpc: RpcPool,
  addr: string,
): Promise<{ collateral: bigint; debt: bigint; crBps: bigint }> {
  const r = await rpc.viewFn<[string, string, string]>(
    MOD + "::trove_health",
    [],
    [addr],
    ONE_PACKAGE,
  );
  return {
    collateral: BigInt(r[0]),
    debt: BigInt(r[1]),
    crBps: BigInt(r[2]),
  };
}
