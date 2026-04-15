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

// FA metadata resolver for custom tokens pasted by the user (outside
// the TOKENS whitelist). Reads `0x1::fungible_asset::Metadata` resource
// directly. Returns null on any failure — the UI must handle fallback.
type FaMetadataResource = {
  symbol?: string;
  name?: string;
  decimals?: number | string;
  icon_uri?: string;
  project_uri?: string;
};

export type ResolvedFaMetadata = {
  meta: string;
  symbol: string;
  decimals: number;
  name?: string;
  /// FA's own icon URL, sourced from the on-chain Metadata resource.
  /// Often empty for tokens that don't bother setting it. Not
  /// guaranteed to be reachable — usually IPFS or a CDN controlled
  /// by the issuer.
  iconUri?: string;
};

const META_CACHE = new Map<string, ResolvedFaMetadata>();

// Pre-populate the metadata cache from the TOKENS whitelist so the
// common case (Pool resource with one of the whitelisted FA metadata
// addresses as metadata_a/metadata_b) resolves without an RPC round-
// trip. Custom FA tokens still fetch on first resolve.
import { TOKENS as WHITELIST_TOKENS } from "../config";
for (const t of Object.values(WHITELIST_TOKENS)) {
  META_CACHE.set(t.meta.toLowerCase(), {
    meta: t.meta,
    symbol: t.symbol,
    decimals: t.decimals,
  });
}

export async function fetchFaMetadata(
  metadata: string,
): Promise<ResolvedFaMetadata | null> {
  const key = metadata.toLowerCase();
  const cached = META_CACHE.get(key);
  if (cached) return cached;
  try {
    const d = await rpc.rotatedGetResource<FaMetadataResource>(
      metadata,
      "0x1::fungible_asset::Metadata",
    );
    const rawIcon = (d?.icon_uri ?? "").trim();
    const resolved: ResolvedFaMetadata = {
      meta: metadata,
      symbol: d?.symbol || `${metadata.slice(0, 6)}…`,
      decimals: Number.parseInt(String(d?.decimals ?? "0"), 10) || 0,
      name: d?.name,
      iconUri: rawIcon.length > 0 ? rawIcon : undefined,
    };
    META_CACHE.set(key, resolved);
    return resolved;
  } catch {
    return null;
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
