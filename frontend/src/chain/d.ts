import type { RpcPool } from "./rpc-pool";
import { D_PACKAGE } from "../config";

const MOD = "D";

export type Totals = {
  totalDebt: bigint;
  totalSp: bigint;
  productFactor: bigint;
  rewardIndexD: bigint;
  rewardIndexColl: bigint;
};

export async function dTotals(rpc: RpcPool): Promise<Totals> {
  const r = await rpc.viewFn<[string, string, string, string, string]>(
    MOD + "::totals",
    [],
    [],
    D_PACKAGE,
  );
  return {
    totalDebt: BigInt(r[0]),
    totalSp: BigInt(r[1]),
    productFactor: BigInt(r[2]),
    rewardIndexD: BigInt(r[3]),
    rewardIndexColl: BigInt(r[4]),
  };
}

export async function dPrice8dec(rpc: RpcPool): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::price", [], [], D_PACKAGE);
  return BigInt(r[0]);
}

export async function dIsSealed(rpc: RpcPool): Promise<boolean> {
  const r = await rpc.viewFn<[boolean]>(MOD + "::is_sealed", [], [], D_PACKAGE);
  return r[0];
}

export async function dReadWarning(rpc: RpcPool): Promise<string> {
  const r = await rpc.viewFn<[string]>(MOD + "::read_warning", [], [], D_PACKAGE);
  const hex = r[0].startsWith("0x") ? r[0].slice(2) : r[0];
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export async function dTroveOf(
  rpc: RpcPool,
  addr: string,
): Promise<{ collateral: bigint; debt: bigint }> {
  const r = await rpc.viewFn<[string, string]>(
    MOD + "::trove_of",
    [],
    [addr],
    D_PACKAGE,
  );
  return { collateral: BigInt(r[0]), debt: BigInt(r[1]) };
}

export async function dSpOf(
  rpc: RpcPool,
  addr: string,
): Promise<{ effectiveBalance: bigint; pendingD: bigint; pendingColl: bigint }> {
  const r = await rpc.viewFn<[string, string, string]>(
    MOD + "::sp_of",
    [],
    [addr],
    D_PACKAGE,
  );
  return {
    effectiveBalance: BigInt(r[0]),
    pendingD: BigInt(r[1]),
    pendingColl: BigInt(r[2]),
  };
}

export async function dReserveBalance(rpc: RpcPool): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::reserve_balance", [], [], D_PACKAGE);
  return BigInt(r[0]);
}

// Total D in the SP pool *including* agnostic donations that bypass
// the keyed-deposit denominator. `totals.totalSp` only counts keyed
// deposits; donations show up as the delta.
export async function dSpPoolBalance(rpc: RpcPool): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(MOD + "::sp_pool_balance", [], [], D_PACKAGE);
  return BigInt(r[0]);
}

export async function dCloseCost(rpc: RpcPool, addr: string): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    MOD + "::close_cost",
    [],
    [addr],
    D_PACKAGE,
  );
  return BigInt(r[0]);
}

export async function dTroveHealth(
  rpc: RpcPool,
  addr: string,
): Promise<{ collateral: bigint; debt: bigint; crBps: bigint }> {
  const r = await rpc.viewFn<[string, string, string]>(
    MOD + "::trove_health",
    [],
    [addr],
    D_PACKAGE,
  );
  return {
    collateral: BigInt(r[0]),
    debt: BigInt(r[1]),
    crBps: BigInt(r[2]),
  };
}

// Generic FungibleStore balance reader. Used to surface the 3 D stores
// the protocol does NOT expose via dedicated views (fee_pool, sp_coll_pool,
// treasury) plus serves as a uniform impl for the 2 it does expose.
// Calls 0x1::fungible_asset::balance with FungibleStore type arg.
export async function faStoreBalance(
  rpc: RpcPool,
  storeAddr: string,
): Promise<bigint> {
  const r = await rpc.viewFn<[string]>(
    "fungible_asset::balance",
    ["0x1::fungible_asset::FungibleStore"],
    [storeAddr],
    "0x1",
  );
  return BigInt(r[0]);
}

export type DonationEvent = {
  donor: string;
  amount: bigint;
  txVersion: string;
};

export type DonationStats = {
  spTotalRaw: bigint;
  spCount: number;
  reserveTotalRaw: bigint;
  reserveCount: number;
  recentSp: DonationEvent[];
  recentReserve: DonationEvent[];
};

// Aggregate SPDonated + ReserveDonated events. Note: SPDonated fires both
// from explicit donate_to_sp() AND from route_fee_fa() (10% fee portion +
// cliff overflow). Total reflects ALL D that ever entered sp_pool as
// agnostic donation, which is the figure that matters for "permanently
// retired supply via liquidation burn."
export async function readDonationStats(
  rpc: RpcPool,
  limit: number = 200,
  recentN: number = 10,
): Promise<DonationStats> {
  type Row = { data: { donor?: string; amount?: string }; transaction_version: string };
  type Q = { events: Row[] };
  async function fetchEvents(eventName: string): Promise<DonationEvent[]> {
    const query = {
      query: `query Donations($type: String!, $limit: Int!) {
        events(
          where: { type: { _eq: $type } }
          order_by: { transaction_version: desc }
          limit: $limit
        ) {
          data
          transaction_version
        }
      }`,
      variables: { type: `${D_PACKAGE}::${MOD}::${eventName}`, limit },
    };
    const res = await rpc.primary.queryIndexer<Q>({ query });
    return (res.events ?? [])
      .map((row) => {
        const donor = String(row.data?.donor ?? "");
        const amount = row.data?.amount;
        if (!donor || amount == null) return null;
        return {
          donor,
          amount: BigInt(amount),
          txVersion: row.transaction_version,
        };
      })
      .filter((e): e is DonationEvent => e !== null);
  }
  const [sp, rsv] = await Promise.all([
    fetchEvents("SPDonated"),
    fetchEvents("ReserveDonated"),
  ]);
  const spTotal = sp.reduce((a, x) => a + x.amount, 0n);
  const rsvTotal = rsv.reduce((a, x) => a + x.amount, 0n);
  return {
    spTotalRaw: spTotal,
    spCount: sp.length,
    reserveTotalRaw: rsvTotal,
    reserveCount: rsv.length,
    recentSp: sp.slice(0, recentN),
    recentReserve: rsv.slice(0, recentN),
  };
}
