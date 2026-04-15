import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { RemoveLiquidityModal, type RemoveTarget } from "../components/RemoveLiquidityModal";
import { TokenIcon } from "../components/TokenIcon";
import { INITIAL_POOLS, PACKAGE, TOKENS, type TokenConfig } from "../config";
import { fetchFaBalance, fetchFaMetadata } from "../chain/balance";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";

const rpc = createRpcPool("portfolio");

type BalanceRow = {
  token: TokenConfig;
  raw: bigint;
  error?: string;
};

type LpPositionResource = {
  pool_addr: string;
  shares: string | number;
};

type PoolResource = {
  reserve_a: string | number;
  reserve_b: string | number;
  lp_supply: string | number;
  metadata_a: { inner: string };
  metadata_b: { inner: string };
};

type LpEntry = {
  objectAddr: string;
  poolAddr: string;
  symbolA: string;
  symbolB: string;
  decA: number;
  decB: number;
  shares: bigint;
  expectedA: bigint;
  expectedB: bigint;
};

// Resolve a pool's display symbols + decimals. First tries the seed
// list (which already has symbols), falls back to reading the Pool
// resource and resolving each metadata address via fetchFaMetadata.
async function resolvePool(
  poolAddr: string,
): Promise<Omit<LpEntry, "objectAddr" | "shares"> & { lpSupply: bigint }> {
  const seed = INITIAL_POOLS.find(
    (p) => p.address.toLowerCase() === poolAddr.toLowerCase(),
  );

  let poolRes: PoolResource | null = null;
  try {
    poolRes = await rpc.rotatedGetResource<PoolResource>(
      poolAddr,
      `${PACKAGE}::pool::Pool`,
    );
  } catch {
    // fall through — fallback to seed symbols + zero reserves
  }

  const reserveA = BigInt(String(poolRes?.reserve_a ?? "0"));
  const reserveB = BigInt(String(poolRes?.reserve_b ?? "0"));
  const lpSupply = BigInt(String(poolRes?.lp_supply ?? "0"));

  if (seed) {
    return {
      poolAddr,
      symbolA: seed.symbolA,
      symbolB: seed.symbolB,
      decA: TOKENS[seed.symbolA]?.decimals ?? 0,
      decB: TOKENS[seed.symbolB]?.decimals ?? 0,
      expectedA: reserveA,
      expectedB: reserveB,
      lpSupply,
    };
  }

  // Non-seed pool — fetch token metadata for both sides.
  const [metaA, metaB] = await Promise.all([
    poolRes ? fetchFaMetadata(poolRes.metadata_a.inner) : null,
    poolRes ? fetchFaMetadata(poolRes.metadata_b.inner) : null,
  ]);

  return {
    poolAddr,
    symbolA: metaA?.symbol ?? "?",
    symbolB: metaB?.symbol ?? "?",
    decA: metaA?.decimals ?? 0,
    decB: metaB?.decimals ?? 0,
    expectedA: reserveA,
    expectedB: reserveB,
    lpSupply,
  };
}

type DiscoveryStats = {
  scanned: number;
  matched: number;
};

async function discoverPositions(
  owner: string,
  onStats?: (s: DiscoveryStats) => void,
): Promise<LpEntry[]> {
  // Page through owned objects with a generous limit. Default may be
  // small and cap before LpPositions are visited if the wallet holds
  // many FA stores.
  const owned = await rpc.primary.getAccountOwnedObjects({
    accountAddress: owner,
    options: { limit: 200 },
  });
  console.debug("[portfolio] owned objects scanned:", owned.length, owned);
  onStats?.({ scanned: owned.length, matched: 0 });

  // Parallelize type-probe reads — most owned objects will NOT be
  // LpPositions (FA stores dominate), so most calls throw "resource
  // not found". Sequential was too slow and burned rate limit.
  const probes = await Promise.allSettled(
    owned.map(async (obj) => {
      const objAddr = obj.object_address;
      if (!objAddr) return null;
      const pos = await rpc.rotatedGetResource<LpPositionResource>(
        objAddr,
        `${PACKAGE}::pool::LpPosition`,
      );
      return { objectAddr: objAddr, pos };
    }),
  );

  const raw: Array<{ objectAddr: string; pos: LpPositionResource }> = [];
  for (const result of probes) {
    if (result.status === "fulfilled" && result.value) {
      raw.push(result.value);
    }
  }
  console.debug("[portfolio] LpPosition matches:", raw.length, raw);
  onStats?.({ scanned: owned.length, matched: raw.length });

  // Resolve each unique pool once.
  const poolCache = new Map<string, Awaited<ReturnType<typeof resolvePool>>>();
  const entries: LpEntry[] = [];
  for (const { objectAddr, pos } of raw) {
    const poolAddr = String(pos.pool_addr);
    let pool = poolCache.get(poolAddr);
    if (!pool) {
      pool = await resolvePool(poolAddr);
      poolCache.set(poolAddr, pool);
    }
    const shares = BigInt(String(pos.shares ?? "0"));
    let expectedA = 0n;
    let expectedB = 0n;
    if (pool.lpSupply > 0n) {
      expectedA = (pool.expectedA * shares) / pool.lpSupply;
      expectedB = (pool.expectedB * shares) / pool.lpSupply;
    }
    entries.push({
      objectAddr,
      poolAddr,
      symbolA: pool.symbolA,
      symbolB: pool.symbolB,
      decA: pool.decA,
      decB: pool.decB,
      shares,
      expectedA,
      expectedB,
    });
  }
  return entries;
}

export function PortfolioPage() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [loadingBal, setLoadingBal] = useState(false);
  const [positions, setPositions] = useState<LpEntry[]>([]);
  const [loadingLp, setLoadingLp] = useState(false);
  const [lpError, setLpError] = useState<string | null>(null);
  const [lpStats, setLpStats] = useState<DiscoveryStats | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimMsg, setClaimMsg] = useState<{ id: string; text: string; error: boolean } | null>(
    null,
  );
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!address) {
      setRows([]);
      setPositions([]);
      return;
    }
    let cancelled = false;
    setLoadingBal(true);
    setLoadingLp(true);
    setLpError(null);

    (async () => {
      const tokenList = Object.values(TOKENS);
      const balResults = await Promise.all(
        tokenList.map(async (token) => {
          try {
            const raw = await fetchFaBalance(address, token.meta);
            return { token, raw };
          } catch (e) {
            return { token, raw: 0n, error: (e as Error).message };
          }
        }),
      );
      if (cancelled) return;
      setRows(balResults);
      setLoadingBal(false);
    })();

    (async () => {
      try {
        const list = await discoverPositions(address, (s) => {
          if (!cancelled) setLpStats(s);
        });
        if (cancelled) return;
        setPositions(list);
      } catch (e) {
        if (cancelled) return;
        setLpError((e as Error).message);
      } finally {
        if (!cancelled) setLoadingLp(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  async function claimFees(entry: LpEntry) {
    if (!address) return;
    setClaiming(entry.objectAddr);
    setClaimMsg(null);
    try {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::pool::claim_lp_fees_entry`,
          typeArguments: [],
          functionArguments: [entry.objectAddr, deadline.toString()],
        },
      });
      setClaimMsg({
        id: entry.objectAddr,
        text: `Claimed: ${result.hash.slice(0, 12)}…`,
        error: false,
      });
      refresh();
    } catch (e) {
      setClaimMsg({
        id: entry.objectAddr,
        text: (e as Error).message,
        error: true,
      });
    } finally {
      setClaiming(null);
    }
  }

  if (!address) {
    return (
      <div className="container">
        <h1 className="page-title">Portfolio</h1>
        <p className="page-sub">Connect your wallet to view balances and LP positions.</p>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title">Portfolio</h1>
      <p className="page-sub">
        Your FA balances and LP positions on Darbitex. Balances via{" "}
        <code>0x1::primary_fungible_store::balance</code>; positions auto-discovered via{" "}
        <code>getAccountOwnedObjects</code> filtered by LpPosition type.
      </p>

      <div className="portfolio-addr">
        <span className="dim">Wallet</span>
        <code>
          {address.slice(0, 10)}…{address.slice(-6)}
        </code>
      </div>

      <h2 className="section-title">Balances</h2>
      <div className="pool-table">
        <div className="pool-head">
          <span>Token</span>
          <span>Address</span>
          <span>Balance</span>
        </div>
        {loadingBal && rows.length === 0 && <div className="hint">Loading…</div>}
        {rows.map((r) => (
          <div key={r.token.meta} className="pool-row portfolio-row">
            <span className="pair">
              <TokenIcon token={r.token} size={20} />
              {" "}
              {r.token.symbol}
            </span>
            <span className="addr-short">
              <a
                href={`https://explorer.aptoslabs.com/fungible_asset/${r.token.meta}?network=mainnet`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {r.token.meta.slice(0, 10)}…{r.token.meta.slice(-4)}
              </a>
            </span>
            <span className="reserves">
              {r.error ? "error" : fromRaw(r.raw, r.token.decimals).toFixed(6)}
            </span>
          </div>
        ))}
      </div>

      <h2 className="section-title">
        LP positions
        <button
          type="button"
          className="bal-link"
          onClick={refresh}
          style={{ marginLeft: 10, fontSize: 11 }}
        >
          refresh
        </button>
      </h2>
      {loadingLp && (
        <div className="hint">
          Scanning owned objects{lpStats ? ` (${lpStats.scanned} found)` : ""}…
        </div>
      )}
      {lpError && <div className="err">Failed to load positions: {lpError}</div>}
      {!loadingLp && positions.length === 0 && !lpError && (
        <div className="hint">
          No LP positions matched on this wallet.
          {lpStats && ` Scanned ${lpStats.scanned} owned objects, ${lpStats.matched} matched.`}{" "}
          If you just added liquidity, the indexer may lag up to a minute before new objects
          show up in <code>getAccountOwnedObjects</code> — hit refresh. Open devtools →
          console for a raw dump of the object list.
        </div>
      )}
      {positions.map((p) => (
        <div key={p.objectAddr} className="lp-card">
          <div className="lp-head">
            <span className="lp-pair">
              <span className="pair-with-icons">
                <TokenIcon token={TOKENS[p.symbolA] ?? { symbol: p.symbolA }} size={18} />
                <TokenIcon token={TOKENS[p.symbolB] ?? { symbol: p.symbolB }} size={18} />
              </span>{" "}
              {p.symbolA}/{p.symbolB}
            </span>
            <a
              className="addr-short"
              href={`https://explorer.aptoslabs.com/object/${p.objectAddr}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {p.objectAddr.slice(0, 10)}…{p.objectAddr.slice(-4)}
            </a>
          </div>
          <div className="lp-body">
            <div>
              <span className="dim">Shares</span>
              <strong>{p.shares.toString()}</strong>
            </div>
            <div>
              <span className="dim">Your {p.symbolA}</span>
              <strong>{fromRaw(p.expectedA, p.decA).toFixed(6)}</strong>
            </div>
            <div>
              <span className="dim">Your {p.symbolB}</span>
              <strong>{fromRaw(p.expectedB, p.decB).toFixed(6)}</strong>
            </div>
          </div>
          <div className="lp-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => claimFees(p)}
              disabled={claiming === p.objectAddr}
            >
              {claiming === p.objectAddr ? "Claiming…" : "Claim fees"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() =>
                setRemoveTarget({
                  poolAddr: p.poolAddr,
                  symbolA: p.symbolA,
                  symbolB: p.symbolB,
                  decA: p.decA,
                  decB: p.decB,
                })
              }
            >
              Remove
            </button>
          </div>
          {claimMsg && claimMsg.id === p.objectAddr && (
            <div className={`modal-status ${claimMsg.error ? "error" : ""}`}>
              {claimMsg.text}
            </div>
          )}
        </div>
      ))}

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
