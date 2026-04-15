import { useCallback, useEffect, useState } from "react";
import { AddLiquidityModal, type AddTarget } from "../components/AddLiquidityModal";
import { CreatePoolModal } from "../components/CreatePoolModal";
import { RemoveLiquidityModal, type RemoveTarget } from "../components/RemoveLiquidityModal";
import { INITIAL_POOLS, TOKENS, type PoolSeed } from "../config";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";

const rpc = createRpcPool("pools");

type PoolRow = PoolSeed & {
  reserveA?: bigint;
  reserveB?: bigint;
  error?: string;
};

function symbolDecimals(symbol: string): number {
  const t = TOKENS[symbol];
  return t ? t.decimals : 6;
}

export function PoolsPage() {
  const [rows, setRows] = useState<PoolRow[]>(() => INITIAL_POOLS.map((p) => ({ ...p })));
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [all] = await rpc.viewFn<[string[]]>("pool_factory::get_all_pools", [], []);
        if (cancelled) return;
        setDiscoveredCount(all.length);
      } catch {
        // fall through to initial seed list
      }

      const results = await Promise.all(
        INITIAL_POOLS.map(async (p) => {
          try {
            const [resA, resB] = await rpc.viewFn<[string, string]>(
              "pool::reserves",
              [],
              [p.address],
            );
            return { ...p, reserveA: BigInt(resA), reserveB: BigInt(resB) };
          } catch (e) {
            return { ...p, error: (e as Error).message };
          }
        }),
      );
      if (cancelled) return;
      setRows(results);
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
        <button type="button" className="btn btn-secondary" onClick={refresh}>
          Refresh
        </button>
      </div>

      {discoveredCount !== null && (
        <div className="hint">
          Factory reports <strong>{discoveredCount}</strong> pool
          {discoveredCount === 1 ? "" : "s"} on-chain.
        </div>
      )}

      <div className="pool-table">
        <div className="pool-head">
          <span>Pair</span>
          <span>Address</span>
          <span>Reserves</span>
          <span>Actions</span>
        </div>
        {rows.map((r) => {
          const decA = symbolDecimals(r.symbolA);
          const decB = symbolDecimals(r.symbolB);
          return (
            <div key={r.address} className="pool-row">
              <span className="pair">
                {r.symbolA}/{r.symbolB}
              </span>
              <span className="addr-short">
                <a
                  href={`https://explorer.aptoslabs.com/account/${r.address}?network=mainnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {r.address.slice(0, 10)}…{r.address.slice(-4)}
                </a>
              </span>
              <span className="reserves">
                {r.error
                  ? "error"
                  : r.reserveA !== undefined && r.reserveB !== undefined
                    ? `${fromRaw(r.reserveA, decA).toFixed(4)} / ${fromRaw(r.reserveB, decB).toFixed(4)}`
                    : "…"}
              </span>
              <span className="pool-actions">
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
                  Add
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    setRemoveTarget({
                      poolAddr: r.address,
                      symbolA: r.symbolA,
                      symbolB: r.symbolB,
                    })
                  }
                >
                  Remove
                </button>
              </span>
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
