import { useCallback, useEffect, useState } from "react";
import { createRpcPool, fromRaw } from "./rpc-pool";
import { useAddress } from "../wallet/useConnect";

// Dedicated RPC pool for FA balance reads. Shared across every page
// that shows balances (Swap input side, Add/Create liquidity modals,
// Portfolio) so they all schedule through one semaphore distinct from
// the per-page view pools. This prevents balance polling from
// contending with quote/route calls.
const rpc = createRpcPool("balance");

// Canonical FA balance read: `0x1::primary_fungible_store::balance`
// view with the Metadata object address. More reliable than the
// GraphQL indexer path (`getCurrentFungibleAssetBalances`) which can
// return stale or empty results depending on indexer lag.
export async function fetchFaBalance(owner: string, metadata: string): Promise<bigint> {
  try {
    const res = await rpc.rotatedView<[string | number]>({
      function: "0x1::primary_fungible_store::balance",
      typeArguments: ["0x1::fungible_asset::Metadata"],
      functionArguments: [owner, metadata],
    });
    return BigInt(String(res[0] ?? "0"));
  } catch {
    return 0n;
  }
}

export type FaBalanceState = {
  raw: bigint;
  formatted: number;
  loading: boolean;
  refresh: () => void;
};

export function useFaBalance(
  metadata: string | null,
  decimals: number,
): FaBalanceState {
  const address = useAddress();
  const [raw, setRaw] = useState<bigint>(0n);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!address || !metadata) {
      setRaw(0n);
      return;
    }
    setLoading(true);
    fetchFaBalance(address, metadata)
      .then((b) => {
        if (!cancelled) setRaw(b);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, metadata, tick]);

  return { raw, formatted: fromRaw(raw, decimals), loading, refresh };
}
