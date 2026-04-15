import { useEffect, useState } from "react";
import { INITIAL_POOLS, PACKAGE, POOL_FEE_BPS, TOKENS, TREASURY, TREASURY_BPS } from "../config";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";

const rpc = createRpcPool("protocol");

type PoolSnapshot = {
  address: string;
  symbolA: string;
  symbolB: string;
  reserveA: bigint;
  reserveB: bigint;
  lpSupply: bigint;
};

type VolumeAggregate = {
  perToken: Record<string, bigint>;
  eventCount: number;
  indexerFailed: boolean;
};

// Per-symbol decimals lookup with fallback. Used for TVL formatting —
// tokens outside the TOKENS whitelist render raw (decimals 0) which is
// clearly wrong but preferable to silently mis-scaling.
function decimalsOf(symbol: string): number {
  return TOKENS[symbol]?.decimals ?? 0;
}

export function ProtocolPage() {
  const [poolCount, setPoolCount] = useState<number | null>(null);
  const [pools, setPools] = useState<PoolSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [volume, setVolume] = useState<VolumeAggregate | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Pool count (authoritative, on-chain view).
      try {
        const [all] = await rpc.viewFn<[string[]]>("pool_factory::get_all_pools", [], []);
        if (!cancelled) setPoolCount(all.length);
      } catch {
        if (!cancelled) setPoolCount(null);
      }

      // Per-pool reserves for TVL. Uses the seed list for now — if a
      // pool outside the seed list exists, the factory count above will
      // flag the discrepancy for the viewer.
      const snapshots = await Promise.all(
        INITIAL_POOLS.map(async (p) => {
          try {
            const [rA, rB] = await rpc.viewFn<[string, string]>(
              "pool::reserves",
              [],
              [p.address],
            );
            return {
              address: p.address,
              symbolA: p.symbolA,
              symbolB: p.symbolB,
              reserveA: BigInt(rA),
              reserveB: BigInt(rB),
              lpSupply: 0n,
            };
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setPools(snapshots.filter((s): s is PoolSnapshot => s !== null));
        setLoading(false);
      }

      // Cumulative volume via the Aptos indexer events API. Final emits
      // `Swapped` events with amount_in + a_to_b per swap. ts-sdk v6.3.1
      // doesn't expose a typed getEvents method, so we use queryIndexer
      // with a raw GraphQL query. Indexer can lag or be unavailable — we
      // render an "indexer unavailable" note in that case.
      try {
        type EventRow = {
          data: { pool_addr?: string; amount_in?: string; a_to_b?: boolean };
        };
        type EventsQuery = { events: EventRow[] };
        const query = {
          query: `query SwappedEvents($type: String!) {
            events(
              where: { indexed_type: { _eq: $type } }
              limit: 500
              order_by: { transaction_version: desc }
            ) {
              data
            }
          }`,
          variables: { type: `${PACKAGE}::pool::Swapped` },
        };
        const result = await rpc.primary.queryIndexer<EventsQuery>({ query });
        if (cancelled) return;
        const perToken: Record<string, bigint> = {};
        let eventCount = 0;
        for (const ev of result.events ?? []) {
          const d = ev.data;
          const poolAddr = String(d.pool_addr ?? "").toLowerCase();
          const amtIn = BigInt(String(d.amount_in ?? "0"));
          const aToB = !!d.a_to_b;
          const poolSeed = INITIAL_POOLS.find(
            (p) => p.address.toLowerCase() === poolAddr,
          );
          if (!poolSeed) continue;
          const sideSymbol = aToB ? poolSeed.symbolA : poolSeed.symbolB;
          perToken[sideSymbol] = (perToken[sideSymbol] ?? 0n) + amtIn;
          eventCount += 1;
        }
        setVolume({ perToken, eventCount, indexerFailed: false });
      } catch {
        if (!cancelled) {
          setVolume({ perToken: {}, eventCount: 0, indexerFailed: true });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Per-token aggregated TVL across known pools.
  const tvlByToken: Record<string, bigint> = {};
  for (const p of pools) {
    tvlByToken[p.symbolA] = (tvlByToken[p.symbolA] ?? 0n) + p.reserveA;
    tvlByToken[p.symbolB] = (tvlByToken[p.symbolB] ?? 0n) + p.reserveB;
  }
  const tvlEntries = Object.entries(tvlByToken).sort(([a], [b]) => a.localeCompare(b));
  const volumeEntries = volume
    ? Object.entries(volume.perToken).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div className="container">
      <h1 className="page-title">Protocol</h1>
      <p className="page-sub">
        Darbitex — zero admin surface, hardcoded treasury, 3-of-5 publisher multisig,
        compatible upgrade policy during soak then immutable.
      </p>

      <section className="protocol-grid">
        <div className="protocol-card">
          <div className="protocol-label">Package / publisher multisig</div>
          <div className="protocol-addr">
            <a
              href={`https://explorer.aptoslabs.com/account/${PACKAGE}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {PACKAGE}
            </a>
          </div>
        </div>

        <div className="protocol-card">
          <div className="protocol-label">Treasury (hardcoded Move constant)</div>
          <div className="protocol-addr">
            <a
              href={`https://explorer.aptoslabs.com/account/${TREASURY}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {TREASURY}
            </a>
          </div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">Pools on-chain</div>
          <div className="protocol-big">{poolCount === null ? "—" : poolCount}</div>
          <div className="protocol-note">
            Live count from <code>pool_factory::get_all_pools</code>
          </div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">LP fee</div>
          <div className="protocol-big">{POOL_FEE_BPS} bps</div>
          <div className="protocol-note">100% to LPs — no passive protocol slot</div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">Treasury cut</div>
          <div className="protocol-big">{TREASURY_BPS / 100}%</div>
          <div className="protocol-note">Only on measurable surplus over the direct baseline</div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">Core modules</div>
          <div className="protocol-big">3</div>
          <div className="protocol-note">
            <code>pool</code> · <code>pool_factory</code> · <code>arbitrage</code>
          </div>
        </div>
      </section>

      <h2 className="section-title">TVL by token</h2>
      <div className="pool-table">
        <div className="pool-head">
          <span>Token</span>
          <span>Reserves summed</span>
        </div>
        {loading && <div className="hint">Loading reserves…</div>}
        {!loading && tvlEntries.length === 0 && <div className="hint">No pool data.</div>}
        {tvlEntries.map(([symbol, raw]) => (
          <div key={symbol} className="pool-row tvl-row">
            <span className="pair">{symbol}</span>
            <span className="reserves">{fromRaw(raw, decimalsOf(symbol)).toFixed(4)}</span>
          </div>
        ))}
      </div>

      <h2 className="section-title">Cumulative volume</h2>
      <div className="pool-table">
        <div className="pool-head">
          <span>Token (side in)</span>
          <span>Total volume</span>
        </div>
        {!volume && <div className="hint">Loading events…</div>}
        {volume?.indexerFailed && (
          <div className="hint">
            Indexer unavailable — volume requires the Aptos Labs indexer events API.
            Reserves above are read directly from fullnode and always live.
          </div>
        )}
        {volume && !volume.indexerFailed && volumeEntries.length === 0 && (
          <div className="hint">
            No swap events found yet. Counter starts at zero on the indexer.
          </div>
        )}
        {volume && !volume.indexerFailed && volumeEntries.length > 0 && (
          <>
            {volumeEntries.map(([symbol, raw]) => (
              <div key={symbol} className="pool-row tvl-row">
                <span className="pair">{symbol}</span>
                <span className="reserves">{fromRaw(raw, decimalsOf(symbol)).toFixed(4)}</span>
              </div>
            ))}
            <div className="hint">
              Lifetime volume from last {volume.eventCount} indexed <code>Swapped</code> events.
            </div>
          </>
        )}
      </div>

      <h2 className="section-title">Execution surfaces</h2>
      <div className="venue-table">
        <div className="venue-head">
          <span>Surface</span>
          <span>Role</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">
            <code>execute_path</code>
          </span>
          <span className="venue-out">Smart multi-hop swap along a pre-computed optimal path</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">
            <code>swap</code>
          </span>
          <span className="venue-out">Auto-routed in→out swap; finds the best path internally</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">
            <code>close_triangle</code>
          </span>
          <span className="venue-out">Real-capital cycle closure from caller's primary store</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">
            <code>close_triangle_flash</code>
          </span>
          <span className="venue-out">Flash-borrow → cycle → repay, zero up-front capital</span>
        </div>
      </div>
    </div>
  );
}
