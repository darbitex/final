import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { RemoveLiquidityModal, type RemoveTarget } from "../components/RemoveLiquidityModal";
import { TokenIcon } from "../components/TokenIcon";
import { INITIAL_POOLS, LOCKER_PACKAGE, PACKAGE, TOKENS, type TokenConfig } from "../config";
import { fetchFaBalance, fetchFaMetadata } from "../chain/balance";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
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

type LockedPositionResource = {
  position: { inner: string };
  unlock_at: string | number;
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

type LockedEntry = LpEntry & {
  lockerAddr: string;
  unlockAt: number;
};

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
    // fall through
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

type OwnedObj = { object_address?: string };

async function fetchAllOwnedObjects(owner: string): Promise<OwnedObj[]> {
  return rpc.primary.getAccountOwnedObjects({
    accountAddress: owner,
    options: { limit: 500 },
  });
}

type DiscoveryStats = {
  scanned: number;
  matchedLp: number;
  matchedLocked: number;
};

async function discoverAll(
  owner: string,
  onStats?: (s: DiscoveryStats) => void,
): Promise<{ lp: LpEntry[]; locked: LockedEntry[] }> {
  const owned = await fetchAllOwnedObjects(owner);
  console.debug("[portfolio] owned objects scanned:", owned.length);
  onStats?.({ scanned: owned.length, matchedLp: 0, matchedLocked: 0 });

  const probes = await Promise.allSettled(
    owned.map(async (obj) => {
      const objAddr = obj.object_address;
      if (!objAddr) return null;

      // Try LpPosition first
      try {
        const pos = await rpc.rotatedGetResource<LpPositionResource>(
          objAddr,
          `${PACKAGE}::pool::LpPosition`,
        );
        return { kind: "lp" as const, objectAddr: objAddr, pos };
      } catch {
        // not an LpPosition
      }

      // Try LockedPosition
      try {
        const locked = await rpc.rotatedGetResource<LockedPositionResource>(
          objAddr,
          `${LOCKER_PACKAGE}::lock::LockedPosition`,
        );
        return { kind: "locked" as const, lockerAddr: objAddr, locked };
      } catch {
        // not a LockedPosition either
      }

      return null;
    }),
  );

  const rawLp: Array<{ objectAddr: string; pos: LpPositionResource }> = [];
  const rawLocked: Array<{ lockerAddr: string; locked: LockedPositionResource }> = [];
  for (const result of probes) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const v = result.value;
    if (v.kind === "lp") rawLp.push(v);
    else if (v.kind === "locked") rawLocked.push(v);
  }

  console.debug("[portfolio] LP matches:", rawLp.length, "locked:", rawLocked.length);
  onStats?.({ scanned: owned.length, matchedLp: rawLp.length, matchedLocked: rawLocked.length });

  const poolCache = new Map<string, Awaited<ReturnType<typeof resolvePool>>>();

  async function getPool(poolAddr: string) {
    let pool = poolCache.get(poolAddr);
    if (!pool) {
      pool = await resolvePool(poolAddr);
      poolCache.set(poolAddr, pool);
    }
    return pool;
  }

  function buildEntry(objectAddr: string, poolAddr: string, shares: bigint, pool: Awaited<ReturnType<typeof resolvePool>>): LpEntry {
    let expectedA = 0n;
    let expectedB = 0n;
    if (pool.lpSupply > 0n) {
      expectedA = (pool.expectedA * shares) / pool.lpSupply;
      expectedB = (pool.expectedB * shares) / pool.lpSupply;
    }
    return {
      objectAddr, poolAddr,
      symbolA: pool.symbolA, symbolB: pool.symbolB,
      decA: pool.decA, decB: pool.decB,
      shares, expectedA, expectedB,
    };
  }

  // Resolve unlocked LP positions
  const lp: LpEntry[] = [];
  for (const { objectAddr, pos } of rawLp) {
    const poolAddr = String(pos.pool_addr);
    const pool = await getPool(poolAddr);
    const shares = BigInt(String(pos.shares ?? "0"));
    lp.push(buildEntry(objectAddr, poolAddr, shares, pool));
  }

  // Resolve locked positions — need to read the inner LpPosition via the position handle
  const locked: LockedEntry[] = [];
  for (const { lockerAddr, locked: loc } of rawLocked) {
    const posAddr = loc.position.inner;
    const unlockAt = Number(loc.unlock_at);
    try {
      const pos = await rpc.rotatedGetResource<LpPositionResource>(
        posAddr,
        `${PACKAGE}::pool::LpPosition`,
      );
      const poolAddr = String(pos.pool_addr);
      const pool = await getPool(poolAddr);
      const shares = BigInt(String(pos.shares ?? "0"));
      const entry = buildEntry(posAddr, poolAddr, shares, pool);
      locked.push({ ...entry, lockerAddr, unlockAt });
    } catch {
      locked.push({
        objectAddr: posAddr, poolAddr: "?", lockerAddr, unlockAt,
        symbolA: "?", symbolB: "?", decA: 0, decB: 0,
        shares: 0n, expectedA: 0n, expectedB: 0n,
      });
    }
  }

  return { lp, locked };
}

function formatUnlockDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function formatCountdown(ts: number): string {
  const diff = ts - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "Unlocked";
  const days = Math.floor(diff / 86400);
  if (days > 365) return `${(days / 365).toFixed(1)}y`;
  if (days > 30) return `${Math.floor(days / 30)}mo ${days % 30}d`;
  if (days > 0) return `${days}d`;
  const hrs = Math.floor(diff / 3600);
  if (hrs > 0) return `${hrs}h`;
  return `${Math.floor(diff / 60)}m`;
}

export function PortfolioPage() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();
  const aptPrice = useAptPriceUsd();
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [loadingBal, setLoadingBal] = useState(false);
  const [positions, setPositions] = useState<LpEntry[]>([]);
  const [lockedPositions, setLockedPositions] = useState<LockedEntry[]>([]);
  const [loadingLp, setLoadingLp] = useState(false);
  const [lpError, setLpError] = useState<string | null>(null);
  const [lpStats, setLpStats] = useState<DiscoveryStats | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimMsg, setClaimMsg] = useState<{ id: string; text: string; error: boolean } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Lock modal state
  const [lockTarget, setLockTarget] = useState<LpEntry | null>(null);
  const [lockDate, setLockDate] = useState("");
  const [lockAgreed, setLockAgreed] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockMsg, setLockMsg] = useState<{ text: string; error: boolean } | null>(null);

  // Redeem state
  const [redeeming, setRedeeming] = useState<string | null>(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!address) {
      setRows([]);
      setPositions([]);
      setLockedPositions([]);
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
        const { lp, locked } = await discoverAll(address, (s) => {
          if (!cancelled) setLpStats(s);
        });
        if (cancelled) return;
        setPositions(lp);
        setLockedPositions(locked);
      } catch (e) {
        if (cancelled) return;
        setLpError((e as Error).message);
      } finally {
        if (!cancelled) setLoadingLp(false);
      }
    })();

    return () => { cancelled = true; };
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
      setClaimMsg({ id: entry.objectAddr, text: `Claimed: ${result.hash.slice(0, 12)}…`, error: false });
      refresh();
    } catch (e) {
      setClaimMsg({ id: entry.objectAddr, text: (e as Error).message, error: true });
    } finally {
      setClaiming(null);
    }
  }

  async function claimLockerFees(entry: LockedEntry) {
    if (!address) return;
    setClaiming(entry.lockerAddr);
    setClaimMsg(null);
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: `${LOCKER_PACKAGE}::lock::claim_fees`,
          typeArguments: [],
          functionArguments: [entry.lockerAddr],
        },
      });
      setClaimMsg({ id: entry.lockerAddr, text: `Claimed: ${result.hash.slice(0, 12)}…`, error: false });
      refresh();
    } catch (e) {
      setClaimMsg({ id: entry.lockerAddr, text: (e as Error).message, error: true });
    } finally {
      setClaiming(null);
    }
  }

  async function redeemLocker(entry: LockedEntry) {
    if (!address) return;
    setRedeeming(entry.lockerAddr);
    setClaimMsg(null);
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: `${LOCKER_PACKAGE}::lock::redeem`,
          typeArguments: [],
          functionArguments: [entry.lockerAddr],
        },
      });
      setClaimMsg({ id: entry.lockerAddr, text: `Redeemed: ${result.hash.slice(0, 12)}…`, error: false });
      refresh();
    } catch (e) {
      setClaimMsg({ id: entry.lockerAddr, text: (e as Error).message, error: true });
    } finally {
      setRedeeming(null);
    }
  }

  async function submitLock() {
    if (!address || !lockTarget || !lockDate) return;
    setLocking(true);
    setLockMsg(null);
    try {
      const unlockTs = Math.floor(new Date(lockDate).getTime() / 1000);
      const now = Math.floor(Date.now() / 1000);
      if (unlockTs <= now) {
        setLockMsg({ text: "Unlock date must be in the future.", error: true });
        setLocking(false);
        return;
      }
      const result = await signAndSubmitTransaction({
        data: {
          function: `${LOCKER_PACKAGE}::lock::lock_position`,
          typeArguments: [],
          functionArguments: [lockTarget.objectAddr, unlockTs.toString()],
        },
      });
      setLockMsg({ text: `Locked: ${result.hash.slice(0, 12)}…`, error: false });
      setLockTarget(null);
      setLockDate("");
      setLockAgreed(false);
      refresh();
    } catch (e) {
      setLockMsg({ text: (e as Error).message, error: true });
    } finally {
      setLocking(false);
    }
  }

  function openLockModal(entry: LpEntry) {
    setLockTarget(entry);
    setLockDate("");
    setLockAgreed(false);
    setLockMsg(null);
  }

  const minDate = new Date(Date.now() + 86400_000).toISOString().split("T")[0];

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
        Your FA balances, LP positions, and locked positions on Darbitex.
        Positions auto-discovered via paginated <code>getAccountOwnedObjects</code>.
      </p>

      <div className="portfolio-addr">
        <span className="dim">Wallet</span>
        <code>{address.slice(0, 10)}…{address.slice(-6)}</code>
      </div>

      {/* ===== Balances ===== */}
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
              <TokenIcon token={r.token} size={20} /> {r.token.symbol}
            </span>
            <span className="addr-short">
              <a
                href={`https://explorer.aptoslabs.com/fungible_asset/${r.token.meta}?network=mainnet`}
                target="_blank" rel="noopener noreferrer"
              >
                {r.token.meta.slice(0, 10)}…{r.token.meta.slice(-4)}
              </a>
            </span>
            <span className="reserves">
              {r.error ? "error" : (() => {
                const f = fromRaw(r.raw, r.token.decimals);
                const u = usdValueOf(f, r.token.symbol, aptPrice);
                return <>{f.toFixed(6)}{u !== null && <span className="usd-inline"> · {formatUsd(u)}</span>}</>;
              })()}
            </span>
          </div>
        ))}
      </div>

      {/* ===== Locked Positions ===== */}
      {lockedPositions.length > 0 && (
        <>
          <h2 className="section-title">
            Locked positions
            <button type="button" className="bal-link" onClick={refresh} style={{ marginLeft: 10, fontSize: 11 }}>refresh</button>
          </h2>
          {lockedPositions.map((p) => {
            const isUnlocked = Math.floor(Date.now() / 1000) >= p.unlockAt;
            return (
              <div key={p.lockerAddr} className="lp-card locked-card">
                <div className="lp-head">
                  <span className="lp-pair">
                    <span className="pair-with-icons">
                      <TokenIcon token={TOKENS[p.symbolA] ?? { symbol: p.symbolA }} size={18} />
                      <TokenIcon token={TOKENS[p.symbolB] ?? { symbol: p.symbolB }} size={18} />
                    </span>{" "}
                    {p.symbolA}/{p.symbolB}
                  </span>
                  <span className="lock-badge">{isUnlocked ? "UNLOCKED" : `${formatCountdown(p.unlockAt)} left`}</span>
                </div>
                <div className="lp-body">
                  <div><span className="dim">Shares</span> <strong>{p.shares.toString()}</strong></div>
                  <div><span className="dim">Your {p.symbolA}</span> <strong>{fromRaw(p.expectedA, p.decA).toFixed(6)}</strong></div>
                  <div><span className="dim">Your {p.symbolB}</span> <strong>{fromRaw(p.expectedB, p.decB).toFixed(6)}</strong></div>
                  <div><span className="dim">Unlock date</span> <strong>{formatUnlockDate(p.unlockAt)}</strong></div>
                </div>
                <div className="lp-actions">
                  <button type="button" className="btn btn-secondary"
                    onClick={() => claimLockerFees(p)}
                    disabled={claiming === p.lockerAddr}
                  >
                    {claiming === p.lockerAddr ? "Claiming…" : "Claim fees"}
                  </button>
                  <button type="button" className={`btn ${isUnlocked ? "btn-primary" : "btn-secondary"}`}
                    onClick={() => redeemLocker(p)}
                    disabled={!isUnlocked || redeeming === p.lockerAddr}
                    title={isUnlocked ? "Redeem your LP position" : `Locked until ${formatUnlockDate(p.unlockAt)}`}
                  >
                    {redeeming === p.lockerAddr ? "Redeeming…" : "Redeem"}
                  </button>
                </div>
                {claimMsg && claimMsg.id === p.lockerAddr && (
                  <div className={`modal-status ${claimMsg.error ? "error" : ""}`}>{claimMsg.text}</div>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* ===== LP Positions ===== */}
      <h2 className="section-title">
        LP positions
        <button type="button" className="bal-link" onClick={refresh} style={{ marginLeft: 10, fontSize: 11 }}>refresh</button>
      </h2>
      {loadingLp && (
        <div className="hint">
          Scanning owned objects{lpStats ? ` (${lpStats.scanned} found)` : ""}…
        </div>
      )}
      {lpError && <div className="err">Failed to load positions: {lpError}</div>}
      {!loadingLp && positions.length === 0 && lockedPositions.length === 0 && !lpError && (
        <div className="hint">
          No LP positions found on this wallet.
          {lpStats && ` Scanned ${lpStats.scanned} owned objects.`}{" "}
          If you just added liquidity, the indexer may lag up to a minute — hit refresh.
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
            <a className="addr-short"
              href={`https://explorer.aptoslabs.com/object/${p.objectAddr}?network=mainnet`}
              target="_blank" rel="noopener noreferrer"
            >
              {p.objectAddr.slice(0, 10)}…{p.objectAddr.slice(-4)}
            </a>
          </div>
          <div className="lp-body">
            <div><span className="dim">Shares</span> <strong>{p.shares.toString()}</strong></div>
            <div><span className="dim">Your {p.symbolA}</span> <strong>{fromRaw(p.expectedA, p.decA).toFixed(6)}</strong></div>
            <div><span className="dim">Your {p.symbolB}</span> <strong>{fromRaw(p.expectedB, p.decB).toFixed(6)}</strong></div>
          </div>
          <div className="lp-actions">
            <button type="button" className="btn btn-secondary"
              onClick={() => claimFees(p)} disabled={claiming === p.objectAddr}
            >
              {claiming === p.objectAddr ? "Claiming…" : "Claim fees"}
            </button>
            <button type="button" className="btn btn-secondary"
              onClick={() => setRemoveTarget({
                poolAddr: p.poolAddr, symbolA: p.symbolA, symbolB: p.symbolB, decA: p.decA, decB: p.decB,
              })}
            >
              Remove
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => openLockModal(p)}>
              Lock
            </button>
          </div>
          {claimMsg && claimMsg.id === p.objectAddr && (
            <div className={`modal-status ${claimMsg.error ? "error" : ""}`}>{claimMsg.text}</div>
          )}
        </div>
      ))}

      {/* ===== Lock Modal ===== */}
      {lockTarget && (
        <div className="modal-overlay" onClick={() => setLockTarget(null)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <h3>Lock LP Position</h3>
            <p className="dim" style={{ marginBottom: 8 }}>
              {lockTarget.symbolA}/{lockTarget.symbolB} — {lockTarget.shares.toString()} shares
            </p>

            <div className="lock-warning">
              <strong>Before you lock, please read carefully:</strong>
              <ul>
                <li>Your LP position <strong>cannot be withdrawn</strong> until the unlock date. There is no early exit, no admin override, and no cancellation.</li>
                <li>LP fees remain claimable at any time while locked.</li>
                <li>The unlock date <strong>cannot be changed</strong> after locking — it cannot be shortened or extended.</li>
                <li>If you transfer the locked position to another wallet, <strong>the original wallet permanently loses access</strong>.</li>
                <li>This lock is enforced by an immutable on-chain contract with zero admin surface.</li>
              </ul>
            </div>

            <label className="lock-label">
              Unlock date
              <input type="date" className="lock-input" value={lockDate}
                onChange={(e) => setLockDate(e.target.value)} min={minDate} />
            </label>

            <label className="lock-checkbox">
              <input type="checkbox" checked={lockAgreed}
                onChange={(e) => setLockAgreed(e.target.checked)} />
              I understand and accept the consequences of locking.
            </label>

            <div className="lp-actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary"
                disabled={!lockDate || !lockAgreed || locking}
                onClick={submitLock}
              >
                {locking ? "Locking…" : "Lock position"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setLockTarget(null)}>
                Cancel
              </button>
            </div>
            {lockMsg && (
              <div className={`modal-status ${lockMsg.error ? "error" : ""}`}>{lockMsg.text}</div>
            )}
          </div>
        </div>
      )}

      <RemoveLiquidityModal
        target={removeTarget}
        onClose={() => setRemoveTarget(null)}
        onDone={() => { setRemoveTarget(null); refresh(); }}
      />
    </div>
  );
}
