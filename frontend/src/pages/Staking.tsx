import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { TokenIcon } from "../components/TokenIcon";
import { PACKAGE, STAKING_PACKAGE, TOKENS, INITIAL_POOLS } from "../config";
import { fetchFaMetadata, useFaBalance } from "../chain/balance";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";

const rpc = createRpcPool("staking");

type StakeEntry = {
  addr: string;
  rewardPoolAddr: string;
  sourceAddr: string;
  shares: number;
  pending: number;
  lockedVariant: boolean;
  rewardSymbol: string;
  rewardDecimals: number;
  poolAddr: string;
};

type PoolEntry = {
  addr: string;
  poolAddr: string;
  rewardToken: string;
  rewardSymbol: string;
  maxRate: number;
  totalStaked: number;
  rewardBalance: number;
  committed: number;
  rewardDecimals: number;
  stakedFractionBps: number;
  emissionRatePerSec: number;
};

function resolveToken(meta: string): { symbol: string; decimals: number } {
  const norm = meta.replace(/^0x0+/, "0x").toLowerCase();
  for (const t of Object.values(TOKENS)) {
    if (t.meta.replace(/^0x0+/, "0x").toLowerCase() === norm) {
      return { symbol: t.symbol, decimals: t.decimals };
    }
  }
  return { symbol: meta.slice(0, 10) + "\u2026", decimals: 8 };
}

async function resolveCustomToken(meta: string): Promise<{ symbol: string; decimals: number } | null> {
  const known = resolveToken(meta);
  if (!known.symbol.endsWith("\u2026")) return known;
  try {
    const [symbol] = await rpc.rotatedView<[string]>({
      function: "0x1::fungible_asset::symbol",
      typeArguments: [],
      functionArguments: [meta],
    });
    const [decimalsRaw] = await rpc.rotatedView<[string]>({
      function: "0x1::fungible_asset::decimals",
      typeArguments: [],
      functionArguments: [meta],
    });
    return { symbol, decimals: Number(decimalsRaw) };
  } catch {
    return null;
  }
}

function fmtAmount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(n < 1 ? 6 : 2);
}

// ===== Token Selector (custom token support) =====

const CUSTOM_KEY = "__custom__";

function TokenSelector({
  value,
  customAddr,
  customInfo,
  onChange,
  onCustomAddrChange,
  label,
}: {
  value: string;
  customAddr: string;
  customInfo: { symbol: string; decimals: number } | null;
  onChange: (key: string) => void;
  onCustomAddrChange: (addr: string) => void;
  label?: string;
}) {
  const tokenList = Object.entries(TOKENS);
  const selectedToken = value !== CUSTOM_KEY ? TOKENS[value] : null;
  return (
    <>
      <label className="lock-label">
        {label ?? "Token"}
        <span className="token-select-with-icon" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          {selectedToken ? (
            <TokenIcon token={selectedToken} size={20} />
          ) : customInfo ? (
            <TokenIcon token={{ symbol: customInfo.symbol }} size={20} />
          ) : null}
          <select
            className="lock-input"
            style={{ marginTop: 0, flex: 1 }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            {tokenList.map(([k, t]) => (
              <option key={k} value={k}>{t.symbol}</option>
            ))}
            <option value={CUSTOM_KEY}>Custom token...</option>
          </select>
        </span>
      </label>
      {value === CUSTOM_KEY && (
        <>
          <label className="lock-label">
            FA metadata address
            <input
              className="lock-input"
              type="text"
              placeholder="0x..."
              value={customAddr}
              onChange={(e) => onCustomAddrChange(e.target.value)}
            />
          </label>
          {customAddr && customInfo && (
            <div style={{ fontSize: 11, color: "#00cc55", marginTop: 4 }}>
              {customInfo.symbol} ({customInfo.decimals} decimals)
            </div>
          )}
          {customAddr && !customInfo && customAddr.length > 10 && (
            <div style={{ fontSize: 11, color: "#ff4444", marginTop: 4 }}>
              Token not found
            </div>
          )}
        </>
      )}
    </>
  );
}

function useTokenSelector(initial: string = "APT") {
  const [tokenKey, setTokenKey] = useState(initial);
  const [customAddr, setCustomAddr] = useState("");
  const [customInfo, setCustomInfo] = useState<{ symbol: string; decimals: number } | null>(null);

  const handleCustomAddrChange = useCallback(async (addr: string) => {
    setCustomAddr(addr);
    setCustomInfo(null);
    const trimmed = addr.trim();
    if (!trimmed || trimmed.length < 10) return;
    const info = await resolveCustomToken(trimmed);
    setCustomInfo(info);
  }, []);

  const getTokenMeta = useCallback((): string | null => {
    if (tokenKey === CUSTOM_KEY) {
      return customInfo ? customAddr.trim() : null;
    }
    return TOKENS[tokenKey]?.meta ?? null;
  }, [tokenKey, customAddr, customInfo]);

  const getDecimals = useCallback((): number => {
    if (tokenKey === CUSTOM_KEY) return customInfo?.decimals ?? 8;
    return TOKENS[tokenKey]?.decimals ?? 8;
  }, [tokenKey, customInfo]);

  const getSymbol = useCallback((): string => {
    if (tokenKey === CUSTOM_KEY) return customInfo?.symbol ?? "?";
    return TOKENS[tokenKey]?.symbol ?? "?";
  }, [tokenKey, customInfo]);

  return {
    tokenKey, setTokenKey, customAddr, customInfo,
    handleCustomAddrChange, getTokenMeta, getDecimals, getSymbol,
  };
}

// ===== Data fetching =====

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
      const [rewardPoolAddr, sourceAddr, sharesRaw, lockedVariant] =
        await rpc.rotatedView<[string, string, string, boolean]>({
          function: `${STAKING_PACKAGE}::staking::stake_info`,
          typeArguments: [],
          functionArguments: [addr],
        });

      const [poolAddr, rewardToken] =
        await rpc.rotatedView<[string, string, string, string, string, string]>({
          function: `${STAKING_PACKAGE}::staking::reward_pool_info`,
          typeArguments: [],
          functionArguments: [rewardPoolAddr],
        });

      const pendingRaw = await rpc.rotatedView<[string]>({
        function: `${STAKING_PACKAGE}::staking::stake_pending_reward`,
        typeArguments: [],
        functionArguments: [addr],
      });

      const rwd = resolveToken(rewardToken);
      results.push({
        addr,
        rewardPoolAddr,
        sourceAddr,
        shares: Number(sharesRaw),
        pending: fromRaw(pendingRaw[0], rwd.decimals),
        lockedVariant: Boolean(lockedVariant),
        rewardSymbol: rwd.symbol,
        rewardDecimals: rwd.decimals,
        poolAddr,
      });
    } catch {
      // not an LpStakePosition
    }
  }
  return results;
}

async function fetchRewardPools(): Promise<PoolEntry[]> {
  try {
    const events = await fetch("https://api.mainnet.aptoslabs.com/v1/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          events(
            where: {type: {_eq: "${STAKING_PACKAGE}::staking::LpRewardPoolCreated"}}
            order_by: {transaction_version: desc}
            limit: 50
          ) { data }
        }`,
      }),
    }).then((r) => r.json());

    const poolEvents = events?.data?.events ?? [];
    const results: PoolEntry[] = [];

    for (const ev of poolEvents) {
      const d = ev.data as {
        reward_pool_addr: string;
        pool_addr: string;
        reward_token: string;
      };
      try {
        const [poolAddr, rewardToken, maxRateRaw, totalStakedRaw, physRaw, committedRaw] =
          await rpc.rotatedView<[string, string, string, string, string, string]>({
            function: `${STAKING_PACKAGE}::staking::reward_pool_info`,
            typeArguments: [],
            functionArguments: [d.reward_pool_addr],
          });
        const [fractionRaw] = await rpc.rotatedView<[string]>({
          function: `${STAKING_PACKAGE}::staking::staked_fraction_bps`,
          typeArguments: [],
          functionArguments: [d.reward_pool_addr],
        });
        const [emissionRaw] = await rpc.rotatedView<[string]>({
          function: `${STAKING_PACKAGE}::staking::current_emission_rate_per_sec`,
          typeArguments: [],
          functionArguments: [d.reward_pool_addr],
        });
        const rwd = resolveToken(rewardToken);
        results.push({
          addr: d.reward_pool_addr,
          poolAddr,
          rewardToken,
          rewardSymbol: rwd.symbol,
          maxRate: fromRaw(maxRateRaw, rwd.decimals),
          totalStaked: Number(totalStakedRaw),
          rewardBalance: fromRaw(physRaw, rwd.decimals),
          committed: fromRaw(committedRaw, rwd.decimals),
          rewardDecimals: rwd.decimals,
          stakedFractionBps: Number(fractionRaw),
          emissionRatePerSec: fromRaw(emissionRaw, rwd.decimals),
        });
      } catch {
        // pool may not exist anymore
      }
    }
    return results;
  } catch {
    return [];
  }
}

function resolvePoolLabel(poolAddr: string): string {
  const p = INITIAL_POOLS.find(
    (ip) => ip.address.toLowerCase() === poolAddr.toLowerCase(),
  );
  return p ? `${p.symbolA}/${p.symbolB}` : poolAddr.slice(0, 10) + "\u2026";
}

type DarbitexPoolEntry = {
  address: string;
  symbolA: string;
  symbolB: string;
};

type PoolResourceShape = {
  metadata_a: { inner: string };
  metadata_b: { inner: string };
};

async function fetchAllDarbitexPools(): Promise<DarbitexPoolEntry[]> {
  try {
    const [addrs] = await rpc.viewFn<[string[]]>(
      "pool_factory::get_all_pools",
      [],
      [],
    );
    const loaded = await Promise.all(
      addrs.map(async (addr) => {
        try {
          const data = await rpc.rotatedGetResource<PoolResourceShape>(
            String(addr),
            `${PACKAGE}::pool::Pool`,
          );
          const [metaA, metaB] = await Promise.all([
            fetchFaMetadata(data.metadata_a.inner),
            fetchFaMetadata(data.metadata_b.inner),
          ]);
          return {
            address: String(addr),
            symbolA: metaA?.symbol ?? "?",
            symbolB: metaB?.symbol ?? "?",
          };
        } catch {
          return {
            address: String(addr),
            symbolA: "?",
            symbolB: "?",
          };
        }
      }),
    );
    return loaded;
  } catch {
    return [];
  }
}

export function StakingBody() {
  const address = useAddress();
  const { signAndSubmitTransaction, connected } = useWallet();
  const aptPrice = useAptPriceUsd();

  const [stakes, setStakes] = useState<StakeEntry[]>([]);
  const [pools, setPools] = useState<PoolEntry[]>([]);
  const [darbitexPools, setDarbitexPools] = useState<DarbitexPoolEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAllDarbitexPools().then((list) => {
      if (!cancelled) setDarbitexPools(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Create reward pool state
  const [createPoolAddr, setCreatePoolAddr] = useState("");
  const [createCustomPoolAddr, setCreateCustomPoolAddr] = useState("");
  const rewardToken = useTokenSelector("APT");
  const rewardTokenBal = useFaBalance(rewardToken.getTokenMeta(), rewardToken.getDecimals());
  const [createMaxRate, setCreateMaxRate] = useState("");

  // Deposit rewards state
  const [depositPoolAddr, setDepositPoolAddr] = useState("");
  const [depositAmount, setDepositAmount] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        address ? fetchUserStakes(address) : Promise.resolve([]),
        fetchRewardPools(),
      ]);
      setStakes(s);
      setPools(p);
    } catch (e) {
      console.error("[staking]", e);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleClaimRewards = useCallback(async (stakeAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::claim_rewards`,
          typeArguments: [],
          functionArguments: [stakeAddr],
        },
      });
      setMsg({ text: `Rewards claimed: ${r.hash.slice(0, 12)}\u2026`, error: false });
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadData]);

  const handleClaimLpFees = useCallback(async (stakeAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::claim_lp_fees`,
          typeArguments: [],
          functionArguments: [stakeAddr],
        },
      });
      setMsg({ text: `LP fees claimed: ${r.hash.slice(0, 12)}\u2026`, error: false });
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadData]);

  const handleUnstake = useCallback(async (stake: StakeEntry) => {
    setMsg(null);
    try {
      const fn = stake.lockedVariant ? "unstake_locked" : "unstake_naked";
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::${fn}`,
          typeArguments: [],
          functionArguments: [stake.addr],
        },
      });
      setMsg({ text: `Unstaked: ${r.hash.slice(0, 12)}\u2026`, error: false });
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadData]);

  const CUSTOM_POOL = "__custom_pool__";

  const getSelectedPoolAddr = useCallback((): string | null => {
    if (createPoolAddr === CUSTOM_POOL) {
      return createCustomPoolAddr.trim() || null;
    }
    return createPoolAddr || null;
  }, [createPoolAddr, createCustomPoolAddr]);

  const handleCreateRewardPool = useCallback(async () => {
    const poolAddr = getSelectedPoolAddr();
    const rewardMeta = rewardToken.getTokenMeta();
    const rewardDecimals = rewardToken.getDecimals();
    const maxRateRaw = Math.floor(Number(createMaxRate) * 10 ** rewardDecimals);
    if (!poolAddr || !rewardMeta || !maxRateRaw || !address) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::create_lp_reward_pool`,
          typeArguments: [],
          functionArguments: [
            poolAddr,
            rewardMeta,
            maxRateRaw.toString(),
          ],
        },
      });
      setMsg({ text: `Pool created: ${r.hash.slice(0, 12)}\u2026`, error: false });
      setCreateMaxRate("");
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [address, getSelectedPoolAddr, rewardToken, createMaxRate, signAndSubmitTransaction, loadData]);

  const handleDepositRewards = useCallback(async () => {
    const pool = pools.find((p) => p.addr === depositPoolAddr);
    if (!pool || !address) return;
    const raw = Math.floor(Number(depositAmount) * 10 ** pool.rewardDecimals);
    if (!raw) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::deposit_rewards`,
          typeArguments: [],
          functionArguments: [depositPoolAddr, raw.toString()],
        },
      });
      setMsg({ text: `Deposited: ${r.hash.slice(0, 12)}\u2026`, error: false });
      setDepositAmount("");
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [address, depositPoolAddr, depositAmount, pools, signAndSubmitTransaction, loadData]);

  return (
    <>
      <p className="page-sub">
        Stake Darbitex LP positions, earn rewards. Claim LP swap fees while staked.
      </p>

      {msg && (
        <div className={`modal-status ${msg.error ? "error" : ""}`} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {!address && (
        <p className="page-sub">Connect your wallet to view your staked positions.</p>
      )}

      {/* Reward Pools Directory */}
      <div className="card" style={{ padding: 16 }}>
        <h2 className="section-title">Reward Pools</h2>
        <p style={{ fontSize: 11, color: "#666", marginBottom: 10 }}>
          Active LP staking reward pools. Stake your LP positions from the Portfolio page.
        </p>
        {loading ? (
          <div className="dim" style={{ fontSize: 12 }}>Loading\u2026</div>
        ) : pools.length === 0 ? (
          <div className="dim" style={{ fontSize: 12 }}>No reward pools yet.</div>
        ) : (
          <div className="vault-directory">
            <div className="vault-dir-header" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr 80px" }}>
              <span>Pool</span>
              <span>Reward</span>
              <span>Staked %</span>
              <span>Emit/sec</span>
              <span>Balance</span>
            </div>
            {pools.map((p) => (
              <div key={p.addr} className="vault-dir-row" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr 80px" }}>
                <span><strong>{resolvePoolLabel(p.poolAddr)}</strong></span>
                <span>{p.rewardSymbol}</span>
                <span>{(p.stakedFractionBps / 100).toFixed(2)}%</span>
                <span>{fmtAmount(p.emissionRatePerSec)}</span>
                <span>{fmtAmount(p.rewardBalance)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Your Staked Positions */}
      {address && stakes.length > 0 && (
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <h2 className="section-title">Your Staked Positions</h2>
          {stakes.map((s) => (
            <div key={s.addr} className="vault-row">
              <div className="vault-row-info">
                <strong>{s.shares.toLocaleString()} shares</strong>
                <span className="dim">
                  {resolvePoolLabel(s.poolAddr)}
                  {s.lockedVariant && (
                    <span style={{ color: "#ff8800", marginLeft: 6, fontSize: 11 }}>· locked LP</span>
                  )}
                </span>
                {s.pending > 0 && (
                  <span style={{ color: "#00cc55", fontSize: 11 }}>
                    {fmtAmount(s.pending)} {s.rewardSymbol} pending
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  className="btn btn-secondary"
                  disabled={s.pending <= 0}
                  onClick={() => handleClaimRewards(s.addr)}
                >
                  Claim
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleClaimLpFees(s.addr)}
                >
                  LP Fees
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleUnstake(s)}
                >
                  Unstake
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Deposit Rewards */}
      {address && pools.length > 0 && (
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <h2 className="section-title">Deposit Rewards</h2>
          <p style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>
            Top up reward balance for an existing pool. Anyone can deposit.
          </p>
          <label className="lock-label">
            Reward Pool
            <select
              className="lock-input"
              value={depositPoolAddr}
              onChange={(e) => setDepositPoolAddr(e.target.value)}
            >
              <option value="">Select a pool...</option>
              {pools.map((p) => (
                <option key={p.addr} value={p.addr}>
                  {resolvePoolLabel(p.poolAddr)} — {p.rewardSymbol} rewards ({p.addr.slice(0, 10)}\u2026)
                </option>
              ))}
            </select>
          </label>
          {depositPoolAddr && (
            <label className="lock-label">
              Amount ({pools.find((p) => p.addr === depositPoolAddr)?.rewardSymbol})
              <input
                className="lock-input"
                type="number"
                placeholder="0.00"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
              />
            </label>
          )}
          <button
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 12 }}
            disabled={!depositPoolAddr || !depositAmount}
            onClick={handleDepositRewards}
          >
            Deposit Rewards
          </button>
        </div>
      )}

      {/* Create LP Reward Pool */}
      {address && (
        <div className="card" style={{ padding: 16, marginTop: 12 }}>
          <h2 className="section-title">Create LP Reward Pool</h2>
          <p style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>
            Create a reward pool for a Darbitex LP pool. Stakers earn the reward token over time while their LP position accrues swap fees.
          </p>
          <label className="lock-label">
            Darbitex Pool
            <select
              className="lock-input"
              value={createPoolAddr}
              onChange={(e) => setCreatePoolAddr(e.target.value)}
            >
              <option value="">
                {darbitexPools.length === 0 ? "Loading pools\u2026" : "Select a pool..."}
              </option>
              {darbitexPools.map((p) => (
                <option key={p.address} value={p.address}>
                  {p.symbolA}/{p.symbolB} ({p.address.slice(0, 10)}\u2026)
                </option>
              ))}
              <option value={CUSTOM_POOL}>Custom pool address...</option>
            </select>
          </label>
          {createPoolAddr === CUSTOM_POOL && (
            <label className="lock-label">
              Pool address
              <input
                className="lock-input"
                type="text"
                placeholder="0x..."
                value={createCustomPoolAddr}
                onChange={(e) => setCreateCustomPoolAddr(e.target.value)}
              />
            </label>
          )}
          <TokenSelector
            value={rewardToken.tokenKey}
            customAddr={rewardToken.customAddr}
            customInfo={rewardToken.customInfo}
            onChange={rewardToken.setTokenKey}
            onCustomAddrChange={rewardToken.handleCustomAddrChange}
            label="Reward token"
          />
          {connected && (
            <div className="bal-static" style={{ marginTop: 6, fontSize: 12 }}>
              Balance: {rewardTokenBal.loading ? "\u2026" : rewardTokenBal.formatted.toFixed(6)} {rewardToken.getSymbol()}
              {(() => {
                const u = usdValueOf(rewardTokenBal.formatted, rewardToken.getSymbol(), aptPrice);
                return u !== null ? <span className="usd-inline"> · {formatUsd(u)}</span> : null;
              })()}
            </div>
          )}
          <label className="lock-label">
            Max rate (reward tokens per second at 100% staked)
            <input
              className="lock-input"
              type="number"
              placeholder="0.001"
              value={createMaxRate}
              onChange={(e) => setCreateMaxRate(e.target.value)}
            />
          </label>
          <div style={{ marginTop: 10, fontSize: 11, color: "#888", lineHeight: 1.5 }}>
            Emission scales with adoption: <code>rate = total_staked / pool.lp_supply × max_rate_per_sec</code>.
            No stake-target knob, no creation fee. Per-staker share is independent of how many others stake;
            the formula is decimal-agnostic — choose <code>max_rate_per_sec</code> in raw reward-token units.
          </div>
          <button
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 12 }}
            disabled={
              !getSelectedPoolAddr() || !createMaxRate ||
              (rewardToken.tokenKey === CUSTOM_KEY && !rewardToken.customInfo)
            }
            onClick={handleCreateRewardPool}
          >
            Create LP Reward Pool
          </button>
        </div>
      )}

    </>
  );
}
