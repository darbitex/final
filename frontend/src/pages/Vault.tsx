import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { VAULT_PACKAGE, TOKENS, type TokenConfig } from "../config";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";

const rpc = createRpcPool("vault");

type Tab = "lock" | "vest" | "stake";

// ===== Types =====

type LockEntry = {
  addr: string;
  tokenMeta: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: number;
  unlockAt: number;
  canRedeem: boolean;
};

type VestEntry = {
  addr: string;
  tokenMeta: string;
  tokenSymbol: string;
  tokenDecimals: number;
  total: number;
  claimed: number;
  claimable: number;
  startTime: number;
  endTime: number;
};

type StakeEntry = {
  addr: string;
  poolAddr: string;
  amount: number;
  stakedSymbol: string;
  stakedDecimals: number;
  pending: number;
  rewardSymbol: string;
  rewardDecimals: number;
};

type DirectoryEntry = {
  tokenMeta: string;
  tokenSymbol: string;
  totalLocked: number;
  decimals: number;
  lockCount: number;
};

// ===== Helpers =====

function resolveToken(meta: string): { symbol: string; decimals: number } {
  const norm = meta.replace(/^0x0+/, "0x").toLowerCase();
  for (const t of Object.values(TOKENS)) {
    if (t.meta.replace(/^0x0+/, "0x").toLowerCase() === norm) {
      return { symbol: t.symbol, decimals: t.decimals };
    }
  }
  return { symbol: meta.slice(0, 10) + "…", decimals: 8 };
}

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-CA");
}

function fmtAmount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(n < 1 ? 6 : 2);
}

// ===== Data fetching =====

async function fetchUserLocks(owner: string): Promise<LockEntry[]> {
  const owned = await rpc.primary.getAccountOwnedObjects({
    accountAddress: owner,
    options: { limit: 500 },
  });
  const now = Math.floor(Date.now() / 1000);
  const results: LockEntry[] = [];
  for (const obj of owned) {
    const addr = obj.object_address;
    if (!addr) continue;
    try {
      const [tokenMeta, amountRaw, unlockAt] = await rpc.rotatedView<[string, string, string]>({
        function: `${VAULT_PACKAGE}::vault::lock_info`,
        typeArguments: [],
        functionArguments: [addr],
      });
      const { symbol, decimals } = resolveToken(tokenMeta);
      results.push({
        addr,
        tokenMeta,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        amount: fromRaw(amountRaw, decimals),
        unlockAt: Number(unlockAt),
        canRedeem: now >= Number(unlockAt),
      });
    } catch {
      // not a LockedTokens object
    }
  }
  return results;
}

async function fetchUserVests(owner: string): Promise<VestEntry[]> {
  const owned = await rpc.primary.getAccountOwnedObjects({
    accountAddress: owner,
    options: { limit: 500 },
  });
  const results: VestEntry[] = [];
  for (const obj of owned) {
    const addr = obj.object_address;
    if (!addr) continue;
    try {
      const [tokenMeta, totalRaw, claimedRaw, startRaw, endRaw] =
        await rpc.rotatedView<[string, string, string, string, string]>({
          function: `${VAULT_PACKAGE}::vault::vest_info`,
          typeArguments: [],
          functionArguments: [addr],
        });
      const claimableRaw = await rpc.rotatedView<[string]>({
        function: `${VAULT_PACKAGE}::vault::vest_claimable`,
        typeArguments: [],
        functionArguments: [addr],
      });
      const { symbol, decimals } = resolveToken(tokenMeta);
      results.push({
        addr,
        tokenMeta,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        total: fromRaw(totalRaw, decimals),
        claimed: fromRaw(claimedRaw, decimals),
        claimable: fromRaw(claimableRaw[0], decimals),
        startTime: Number(startRaw),
        endTime: Number(endRaw),
      });
    } catch {
      // not a VestedTokens object
    }
  }
  return results;
}

async function fetchUserStakes(owner: string): Promise<StakeEntry[]> {
  const owned = await rpc.primary.getAccountOwnedObjects({
    accountAddress: owner,
    options: { limit: 500 },
  });
  const results: StakeEntry[] = [];
  for (const obj of owned) {
    const addr = obj.object_address;
    if (!addr) continue;
    try {
      const [poolAddr, amountRaw] = await rpc.rotatedView<[string, string]>({
        function: `${VAULT_PACKAGE}::vault::stake_info`,
        typeArguments: [],
        functionArguments: [addr],
      });
      const [stakedMeta, rewardMeta, , , ,] =
        await rpc.rotatedView<[string, string, string, string, string, string]>({
          function: `${VAULT_PACKAGE}::vault::reward_pool_info`,
          typeArguments: [],
          functionArguments: [poolAddr],
        });
      const pendingRaw = await rpc.rotatedView<[string]>({
        function: `${VAULT_PACKAGE}::vault::stake_pending_reward`,
        typeArguments: [],
        functionArguments: [addr],
      });
      const stk = resolveToken(stakedMeta);
      const rwd = resolveToken(rewardMeta);
      results.push({
        addr,
        poolAddr,
        amount: fromRaw(amountRaw, stk.decimals),
        stakedSymbol: stk.symbol,
        stakedDecimals: stk.decimals,
        pending: fromRaw(pendingRaw[0], rwd.decimals),
        rewardSymbol: rwd.symbol,
        rewardDecimals: rwd.decimals,
      });
    } catch {
      // not a StakePosition object
    }
  }
  return results;
}

async function fetchLockDirectory(): Promise<DirectoryEntry[]> {
  const query = `{
    events(
      where: {type: {_eq: "${VAULT_PACKAGE}::vault::TokensLocked"}}
      order_by: {transaction_version: desc}
      limit: 200
    ) { data }
  }`;
  const redeemQuery = `{
    events(
      where: {type: {_eq: "${VAULT_PACKAGE}::vault::TokensRedeemed"}}
      limit: 200
    ) { data }
  }`;
  try {
    const [lockRes, redeemRes] = await Promise.all([
      fetch("https://api.mainnet.aptoslabs.com/v1/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }).then((r) => r.json()),
      fetch("https://api.mainnet.aptoslabs.com/v1/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: redeemQuery }),
      }).then((r) => r.json()),
    ]);
    const lockEvents = lockRes?.data?.events ?? [];
    const redeemEvents = redeemRes?.data?.events ?? [];
    const redeemedAddrs = new Set(
      redeemEvents.map((e: { data: { locker_addr: string } }) => e.data.locker_addr),
    );

    const byToken: Record<string, { total: bigint; count: number; decimals: number; symbol: string }> = {};
    for (const ev of lockEvents) {
      const d = ev.data as { token: string; amount: string; locker_addr: string };
      if (redeemedAddrs.has(d.locker_addr)) continue;
      const { symbol, decimals } = resolveToken(d.token);
      const key = d.token;
      if (!byToken[key]) byToken[key] = { total: 0n, count: 0, decimals, symbol };
      byToken[key].total += BigInt(d.amount);
      byToken[key].count += 1;
    }
    return Object.entries(byToken).map(([meta, v]) => ({
      tokenMeta: meta,
      tokenSymbol: v.symbol,
      totalLocked: fromRaw(v.total, v.decimals),
      decimals: v.decimals,
      lockCount: v.count,
    }));
  } catch {
    return [];
  }
}

// ===== Component =====

export function VaultPage() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [tab, setTab] = useState<Tab>("lock");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  // Lock state
  const [lockToken, setLockToken] = useState("APT");
  const [lockAmount, setLockAmount] = useState("");
  const [lockDate, setLockDate] = useState("");
  const [locks, setLocks] = useState<LockEntry[]>([]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [dirLoading, setDirLoading] = useState(false);

  // Vest state
  const [vestToken, setVestToken] = useState("APT");
  const [vestAmount, setVestAmount] = useState("");
  const [vestStart, setVestStart] = useState("");
  const [vestEnd, setVestEnd] = useState("");
  const [vests, setVests] = useState<VestEntry[]>([]);

  // Stake state
  const [stakes, setStakes] = useState<StakeEntry[]>([]);

  const tokenList = Object.entries(TOKENS);

  const selectedToken = (key: string): TokenConfig =>
    TOKENS[key] ?? TOKENS.APT;

  // Load user positions
  const loadPositions = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      if (tab === "lock") {
        const [l, d] = await Promise.all([fetchUserLocks(address), fetchLockDirectory()]);
        setLocks(l);
        setDirectory(d);
      } else if (tab === "vest") {
        setVests(await fetchUserVests(address));
      } else {
        setStakes(await fetchUserStakes(address));
      }
    } catch (e) {
      console.error("[vault]", e);
    } finally {
      setLoading(false);
    }
  }, [address, tab]);

  useEffect(() => {
    loadPositions();
  }, [loadPositions]);

  // Load directory on mount (public, no wallet needed)
  useEffect(() => {
    setDirLoading(true);
    fetchLockDirectory()
      .then(setDirectory)
      .catch(() => {})
      .finally(() => setDirLoading(false));
  }, []);

  // ===== Actions =====

  const handleLock = useCallback(async () => {
    const tk = selectedToken(lockToken);
    const raw = Math.floor(Number(lockAmount) * 10 ** tk.decimals);
    const unlockAt = Math.floor(new Date(lockDate).getTime() / 1000);
    if (!raw || !unlockAt || !address) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::lock_tokens`,
          typeArguments: [],
          functionArguments: [tk.meta, raw.toString(), unlockAt.toString()],
        },
      });
      setMsg({ text: `Locked: ${r.hash.slice(0, 12)}…`, error: false });
      setLockAmount("");
      setLockDate("");
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [address, lockToken, lockAmount, lockDate, signAndSubmitTransaction, loadPositions]);

  const handleRedeem = useCallback(async (lockerAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::redeem_locked`,
          typeArguments: [],
          functionArguments: [lockerAddr],
        },
      });
      setMsg({ text: `Redeemed: ${r.hash.slice(0, 12)}…`, error: false });
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadPositions]);

  const handleCreateVest = useCallback(async () => {
    const tk = selectedToken(vestToken);
    const raw = Math.floor(Number(vestAmount) * 10 ** tk.decimals);
    const start = Math.floor(new Date(vestStart).getTime() / 1000);
    const end = Math.floor(new Date(vestEnd).getTime() / 1000);
    if (!raw || !start || !end || !address) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::create_vesting`,
          typeArguments: [],
          functionArguments: [tk.meta, raw.toString(), start.toString(), end.toString()],
        },
      });
      setMsg({ text: `Vesting created: ${r.hash.slice(0, 12)}…`, error: false });
      setVestAmount("");
      setVestStart("");
      setVestEnd("");
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [address, vestToken, vestAmount, vestStart, vestEnd, signAndSubmitTransaction, loadPositions]);

  const handleClaimVest = useCallback(async (vestAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::claim_vested`,
          typeArguments: [],
          functionArguments: [vestAddr],
        },
      });
      setMsg({ text: `Claimed: ${r.hash.slice(0, 12)}…`, error: false });
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadPositions]);

  const handleClaimStake = useCallback(async (stakeAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::claim_stake_rewards`,
          typeArguments: [],
          functionArguments: [stakeAddr],
        },
      });
      setMsg({ text: `Rewards claimed: ${r.hash.slice(0, 12)}…`, error: false });
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadPositions]);

  const handleUnstake = useCallback(async (stakeAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::unstake_tokens`,
          typeArguments: [],
          functionArguments: [stakeAddr],
        },
      });
      setMsg({ text: `Unstaked: ${r.hash.slice(0, 12)}…`, error: false });
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadPositions]);

  // ===== Render =====

  return (
    <div className="container">
      <h1 className="page-title">Token Vault</h1>
      <p className="page-sub">Lock, vest, or stake any Aptos token. 1 APT creation fee.</p>

      <div className="vault-tabs">
        {(["lock", "vest", "stake"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`vault-tab ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "lock" ? "Lock" : t === "vest" ? "Vest" : "Stake"}
          </button>
        ))}
      </div>

      {msg && (
        <div className={`modal-status ${msg.error ? "error" : ""}`} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {/* ===== LOCK TAB ===== */}
      {tab === "lock" && (
        <>
          {address && (
            <div className="card" style={{ padding: 16 }}>
              <h2 className="section-title">Lock Tokens</h2>
              <label className="lock-label">
                Token
                <select
                  className="lock-input"
                  value={lockToken}
                  onChange={(e) => setLockToken(e.target.value)}
                >
                  {tokenList.map(([k, t]) => (
                    <option key={k} value={k}>{t.symbol}</option>
                  ))}
                </select>
              </label>
              <label className="lock-label">
                Amount
                <input
                  className="lock-input"
                  type="number"
                  placeholder="0.00"
                  value={lockAmount}
                  onChange={(e) => setLockAmount(e.target.value)}
                />
              </label>
              <label className="lock-label">
                Unlock date
                <input
                  className="lock-input"
                  type="datetime-local"
                  value={lockDate}
                  onChange={(e) => setLockDate(e.target.value)}
                />
              </label>
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <span className="dim">Fee:</span> <strong>1 APT</strong>
              </div>
              <button
                className="btn btn-primary"
                style={{ width: "100%", marginTop: 12 }}
                disabled={!lockAmount || !lockDate}
                onClick={handleLock}
              >
                Lock Tokens
              </button>
            </div>
          )}

          {address && locks.length > 0 && (
            <div className="card" style={{ padding: 16, marginTop: 12 }}>
              <h2 className="section-title">Your Locks</h2>
              {locks.map((l) => (
                <div key={l.addr} className="vault-row">
                  <div className="vault-row-info">
                    <strong>{l.tokenSymbol}</strong>
                    <span className="dim">{fmtAmount(l.amount)}</span>
                    <span className="dim">
                      {l.canRedeem ? "Unlocked" : `Unlock ${fmtDate(l.unlockAt)}`}
                    </span>
                  </div>
                  <button
                    className="btn btn-secondary"
                    disabled={!l.canRedeem}
                    onClick={() => handleRedeem(l.addr)}
                  >
                    {l.canRedeem ? "Redeem" : "Locked"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {loading && <div className="page-loading">Loading…</div>}

          <div className="card" style={{ padding: 16, marginTop: 12 }}>
            <h2 className="section-title">Locked Tokens Directory</h2>
            <p style={{ fontSize: 11, color: "#666", marginBottom: 10 }}>
              All tokens currently locked via Darbitex Vault.
            </p>
            {dirLoading ? (
              <div className="dim" style={{ fontSize: 12 }}>Loading directory…</div>
            ) : directory.length === 0 ? (
              <div className="dim" style={{ fontSize: 12 }}>No tokens locked yet.</div>
            ) : (
              <div className="vault-directory">
                <div className="vault-dir-header">
                  <span>Token</span>
                  <span>Total Locked</span>
                  <span>Locks</span>
                </div>
                {directory.map((d) => (
                  <div key={d.tokenMeta} className="vault-dir-row">
                    <span><strong>{d.tokenSymbol}</strong></span>
                    <span>{fmtAmount(d.totalLocked)}</span>
                    <span>{d.lockCount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ===== VEST TAB ===== */}
      {tab === "vest" && (
        <>
          {address && (
            <div className="card" style={{ padding: 16 }}>
              <h2 className="section-title">Create Vesting</h2>
              <label className="lock-label">
                Token
                <select
                  className="lock-input"
                  value={vestToken}
                  onChange={(e) => setVestToken(e.target.value)}
                >
                  {tokenList.map(([k, t]) => (
                    <option key={k} value={k}>{t.symbol}</option>
                  ))}
                </select>
              </label>
              <label className="lock-label">
                Total amount
                <input
                  className="lock-input"
                  type="number"
                  placeholder="0.00"
                  value={vestAmount}
                  onChange={(e) => setVestAmount(e.target.value)}
                />
              </label>
              <label className="lock-label">
                Start date
                <input
                  className="lock-input"
                  type="datetime-local"
                  value={vestStart}
                  onChange={(e) => setVestStart(e.target.value)}
                />
              </label>
              <label className="lock-label">
                End date
                <input
                  className="lock-input"
                  type="datetime-local"
                  value={vestEnd}
                  onChange={(e) => setVestEnd(e.target.value)}
                />
              </label>
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <span className="dim">Fee:</span> <strong>1 APT</strong>
              </div>
              <button
                className="btn btn-primary"
                style={{ width: "100%", marginTop: 12 }}
                disabled={!vestAmount || !vestStart || !vestEnd}
                onClick={handleCreateVest}
              >
                Create Vesting
              </button>
            </div>
          )}

          {address && vests.length > 0 && (
            <div className="card" style={{ padding: 16, marginTop: 12 }}>
              <h2 className="section-title">Your Vesting Positions</h2>
              {vests.map((v) => (
                <div key={v.addr} className="vault-row">
                  <div className="vault-row-info">
                    <strong>{v.tokenSymbol}</strong>
                    <span className="dim">
                      {fmtAmount(v.claimed)} / {fmtAmount(v.total)}
                    </span>
                    <span className="dim">
                      {fmtDate(v.startTime)} — {fmtDate(v.endTime)}
                    </span>
                    {v.claimable > 0 && (
                      <span style={{ color: "#00cc55", fontSize: 11 }}>
                        {fmtAmount(v.claimable)} claimable
                      </span>
                    )}
                  </div>
                  <button
                    className="btn btn-secondary"
                    disabled={v.claimable <= 0}
                    onClick={() => handleClaimVest(v.addr)}
                  >
                    {v.claimable > 0 ? "Claim" : "Vesting"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {!address && (
            <p className="page-sub">Connect your wallet to create vesting schedules.</p>
          )}
          {loading && <div className="page-loading">Loading…</div>}
        </>
      )}

      {/* ===== STAKE TAB ===== */}
      {tab === "stake" && (
        <>
          {address && stakes.length > 0 && (
            <div className="card" style={{ padding: 16 }}>
              <h2 className="section-title">Your Stake Positions</h2>
              {stakes.map((s) => (
                <div key={s.addr} className="vault-row">
                  <div className="vault-row-info">
                    <strong>{fmtAmount(s.amount)} {s.stakedSymbol}</strong>
                    <span className="dim">Pool {s.poolAddr.slice(0, 10)}…</span>
                    {s.pending > 0 && (
                      <span style={{ color: "#00cc55", fontSize: 11 }}>
                        {fmtAmount(s.pending)} {s.rewardSymbol} pending
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      className="btn btn-secondary"
                      disabled={s.pending <= 0}
                      onClick={() => handleClaimStake(s.addr)}
                    >
                      Claim
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => handleUnstake(s.addr)}
                    >
                      Unstake
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {address && stakes.length === 0 && !loading && (
            <div className="card" style={{ padding: 16 }}>
              <p className="dim" style={{ fontSize: 12 }}>No stake positions found.</p>
            </div>
          )}

          {!address && (
            <p className="page-sub">Connect your wallet to view stake positions.</p>
          )}
          {loading && <div className="page-loading">Loading…</div>}
        </>
      )}

      {!address && tab === "lock" && (
        <p className="page-sub" style={{ marginTop: 12 }}>
          Connect your wallet to lock tokens.
        </p>
      )}
    </div>
  );
}
