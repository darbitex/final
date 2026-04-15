import { useCallback, useEffect, useState } from "react";
import { AddLiquidityModal, type AddTarget } from "../components/AddLiquidityModal";
import { CreatePoolModal } from "../components/CreatePoolModal";
import { RemoveLiquidityModal, type RemoveTarget } from "../components/RemoveLiquidityModal";
import { PACKAGE } from "../config";
import { fetchFaMetadata } from "../chain/balance";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";

const rpc = createRpcPool("pools");

type PoolRow = {
  address: string;
  symbolA: string;
  symbolB: string;
  decA: number;
  decB: number;
  reserveA: bigint;
  reserveB: bigint;
  error?: string;
};

type PoolResource = {
  reserve_a: string | number;
  reserve_b: string | number;
  lp_supply: string | number;
  metadata_a: { inner: string };
  metadata_b: { inner: string };
};

async function loadPoolRow(addr: string): Promise<PoolRow> {
  try {
    const data = await rpc.rotatedGetResource<PoolResource>(
      addr,
      `${PACKAGE}::pool::Pool`,
    );
    const [metaA, metaB] = await Promise.all([
      fetchFaMetadata(data.metadata_a.inner),
      fetchFaMetadata(data.metadata_b.inner),
    ]);
    return {
      address: addr,
      symbolA: metaA?.symbol ?? "?",
      symbolB: metaB?.symbol ?? "?",
      decA: metaA?.decimals ?? 0,
      decB: metaB?.decimals ?? 0,
      reserveA: BigInt(String(data.reserve_a ?? "0")),
      reserveB: BigInt(String(data.reserve_b ?? "0")),
    };
  } catch (e) {
    return {
      address: addr,
      symbolA: "?",
      symbolB: "?",
      decA: 0,
      decB: 0,
      reserveA: 0n,
      reserveB: 0n,
      error: (e as Error).message,
    };
  }
}

export function PoolsPage() {
  const [rows, setRows] = useState<PoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (refreshKey === 0) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);

    (async () => {
      try {
        const [all] = await rpc.viewFn<[string[]]>(
          "pool_factory::get_all_pools",
          [],
          [],
        );
        if (cancelled) return;

        // Parallel Pool-resource reads, throttled by the per-page
        // semaphore inside rotatedGetResource. Each read yields both
        // reserves and the metadata_a/metadata_b object addresses in
        // one round-trip, replacing the old "get_all_pools + N×
        // pool::reserves" fanout.
        const loaded = await Promise.all(all.map((addr) => loadPoolRow(String(addr))));
        if (cancelled) return;
        setRows(loaded);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <div className="container">
      <h1 className="page-title">Pools</h1>
      <p className="page-sub">
        Permissionless canonical pools on Darbitex. Any wallet can create a new pool, seed
        liquidity, or burn a position — every surface below is public entry with no admin
        gate.
      </p>

      <div className="pool-actions-top">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreateOpen(true)}
        >
          + Create pool
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {(loading || refreshing) && rows.length === 0 && (
        <div className="hint">Loading pools…</div>
      )}
      {error && <div className="err">Failed to load pools: {error}</div>}
      {!loading && rows.length > 0 && (
        <div className="hint">
          {rows.length} pool{rows.length === 1 ? "" : "s"} on-chain
          {refreshing ? " · refreshing…" : ""}
        </div>
      )}

      <div className="pool-cards">
        {rows.map((r) => {
          const reserveLine = r.error
            ? "error"
            : `${fromRaw(r.reserveA, r.decA).toFixed(4)} ${r.symbolA} / ${fromRaw(r.reserveB, r.decB).toFixed(4)} ${r.symbolB}`;
          return (
            <div key={r.address} className="pool-card">
              <div className="pool-card-head">
                <span className="lp-pair">
                  {r.symbolA}/{r.symbolB}
                </span>
                <a
                  className="addr-short"
                  href={`https://explorer.aptoslabs.com/account/${r.address}?network=mainnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {r.address.slice(0, 10)}…{r.address.slice(-4)}
                </a>
              </div>
              <div className="pool-card-reserves">
                <span className="dim">Reserves</span>
                <strong>{reserveLine}</strong>
              </div>
              <div className="pool-card-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setAddTarget({
                      poolAddr: r.address,
                      symbolA: r.symbolA,
                      symbolB: r.symbolB,
                    })
                  }
                >
                  Add liquidity
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setRemoveTarget({
                      poolAddr: r.address,
                      symbolA: r.symbolA,
                      symbolB: r.symbolB,
                      decA: r.decA,
                      decB: r.decB,
                    })
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <CreatePoolModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <AddLiquidityModal
        target={addTarget}
        onClose={() => setAddTarget(null)}
        onDone={() => {
          setAddTarget(null);
          refresh();
        }}
      />
      <RemoveLiquidityModal
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onDone={() => {
          setRemoveTarget(null);
          refresh();
        }}
      />
    </div>
  );
}
