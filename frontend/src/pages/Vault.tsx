import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { TokenIcon } from "../components/TokenIcon";
import { VAULT_PACKAGE, TOKENS } from "../config";
import { useFaBalance } from "../chain/balance";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
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

type RewardPoolEntry = {
  addr: string;
  stakedMeta: string;
  stakedSymbol: string;
  stakedDecimals: number;
  rewardMeta: string;
  rewardSymbol: string;
  rewardDecimals: number;
  maxRate: number;
  stakeTarget: number;
  totalStaked: number;
  rewardBalance: number;
};

// ===== Helpers =====

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

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-CA");
}

function fmtAmount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(n < 1 ? 6 : 2);
}

// ===== Token Selector =====

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
  const [resolving, setResolving] = useState(false);

  const handleCustomAddrChange = useCallback(async (addr: string) => {
    setCustomAddr(addr);
    setCustomInfo(null);
    const trimmed = addr.trim();
    if (!trimmed || trimmed.length < 10) return;
    setResolving(true);
    const info = await resolveCustomToken(trimmed);
    setCustomInfo(info);
    setResolving(false);
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
    tokenKey, setTokenKey, customAddr, customInfo, resolving,
    handleCustomAddrChange, getTokenMeta, getDecimals, getSymbol,
  };
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

async function fetchRewardPools(): Promise<RewardPoolEntry[]> {
  try {
    const res = await fetch("https://api.mainnet.aptoslabs.com/v1/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          events(
            where: {type: {_eq: "${VAULT_PACKAGE}::vault::RewardPoolCreated"}}
            order_by: {transaction_version: desc}
            limit: 50
          ) { data }
        }`,
      }),
    }).then((r) => r.json());

    const poolEvents = res?.data?.events ?? [];
    const results: RewardPoolEntry[] = [];

    for (const ev of poolEvents) {
      const d = ev.data as { pool_addr: string };
      try {
        const [stakedMeta, rewardMeta, maxRateRaw, stakeTargetRaw, totalStakedRaw, rewardBalRaw] =
          await rpc.rotatedView<[string, string, string, string, string, string]>({
            function: `${VAULT_PACKAGE}::vault::reward_pool_info`,
            typeArguments: [],
            functionArguments: [d.pool_addr],
          });
        const stk = resolveToken(stakedMeta);
        const rwd = resolveToken(rewardMeta);
        results.push({
          addr: d.pool_addr,
          stakedMeta,
          stakedSymbol: stk.symbol,
          stakedDecimals: stk.decimals,
          rewardMeta,
          rewardSymbol: rwd.symbol,
          rewardDecimals: rwd.decimals,
          maxRate: fromRaw(maxRateRaw, rwd.decimals),
          stakeTarget: fromRaw(stakeTargetRaw, stk.decimals),
          totalStaked: fromRaw(totalStakedRaw, stk.decimals),
          rewardBalance: fromRaw(rewardBalRaw, rwd.decimals),
        });
      } catch {
        // pool may be gone
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ===== Component =====

export function VaultPage() {
  const address = useAddress();
  const { signAndSubmitTransaction, connected } = useWallet();
  const aptPrice = useAptPriceUsd();

  const [tab, setTab] = useState<Tab>("lock");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  // Lock state
  const lockToken = useTokenSelector("APT");
  const lockBal = useFaBalance(lockToken.getTokenMeta(), lockToken.getDecimals());
  const [lockAmount, setLockAmount] = useState("");
  const [lockDate, setLockDate] = useState("");
  const [locks, setLocks] = useState<LockEntry[]>([]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);

  // Vest state
  const vestToken = useTokenSelector("APT");
  const vestBal = useFaBalance(vestToken.getTokenMeta(), vestToken.getDecimals());
  const [vestAmount, setVestAmount] = useState("");
  const [vestStart, setVestStart] = useState("");
  const [vestEnd, setVestEnd] = useState("");
  const [vests, setVests] = useState<VestEntry[]>([]);

  // Stake state
  const [stakes, setStakes] = useState<StakeEntry[]>([]);
  const [rewardPools, setRewardPools] = useState<RewardPoolEntry[]>([]);

  // Create reward pool state
  const createStakedToken = useTokenSelector("APT");
  const createRewardToken = useTokenSelector("APT");
  const [createMaxRate, setCreateMaxRate] = useState("");
  const [createStakeTarget, setCreateStakeTarget] = useState("");

  // Deposit rewards state
  const [depositPoolAddr, setDepositPoolAddr] = useState("");
  const [depositAmount, setDepositAmount] = useState("");

  // Stake tokens state
  const [stakePoolAddr, setStakePoolAddr] = useState("");
  const [stakeAmount, setStakeAmount] = useState("");

  const loadPositions = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "lock") {
        const [l, d] = await Promise.all([
          address ? fetchUserLocks(address) : Promise.resolve([]),
          fetchLockDirectory(),
        ]);
        setLocks(l);
        setDirectory(d);
      } else if (tab === "vest") {
        if (address) setVests(await fetchUserVests(address));
      } else {
        const [s, rp] = await Promise.all([
          address ? fetchUserStakes(address) : Promise.resolve([]),
          fetchRewardPools(),
        ]);
        setStakes(s);
        setRewardPools(rp);
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

  // ===== Actions =====

  const handleLock = useCallback(async () => {
    const meta = lockToken.getTokenMeta();
    const decimals = lockToken.getDecimals();
    const raw = Math.floor(Number(lockAmount) * 10 ** decimals);
    const unlockAt = Math.floor(new Date(lockDate).getTime() / 1000);
    if (!raw || !unlockAt || !address || !meta) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::lock_tokens`,
          typeArguments: [],
          functionArguments: [meta, raw.toString(), unlockAt.toString()],
        },
      });
      setMsg({ text: `Locked: ${r.hash.slice(0, 12)}\u2026`, error: false });
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
      setMsg({ text: `Redeemed: ${r.hash.slice(0, 12)}\u2026`, error: false });
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadPositions]);

  const handleCreateVest = useCallback(async () => {
    const meta = vestToken.getTokenMeta();
    const decimals = vestToken.getDecimals();
    const raw = Math.floor(Number(vestAmount) * 10 ** decimals);
    const start = Math.floor(new Date(vestStart).getTime() / 1000);
    const end = Math.floor(new Date(vestEnd).getTime() / 1000);
    if (!raw || !start || !end || !address || !meta) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::create_vesting`,
          typeArguments: [],
          functionArguments: [meta, raw.toString(), start.toString(), end.toString()],
        },
      });
      setMsg({ text: `Vesting created: ${r.hash.slice(0, 12)}\u2026`, error: false });
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
      setMsg({ text: `Claimed: ${r.hash.slice(0, 12)}\u2026`, error: false });
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadPositions]);

  const handleCreateRewardPool = useCallback(async () => {
    const stakedMeta = createStakedToken.getTokenMeta();
    const rewardMeta = createRewardToken.getTokenMeta();
    const rewardDecimals = createRewardToken.getDecimals();
    const stakedDecimals = createStakedToken.getDecimals();
    const maxRateRaw = Math.floor(Number(createMaxRate) * 10 ** rewardDecimals);
    const stakeTargetRaw = Math.floor(Number(createStakeTarget) * 10 ** stakedDecimals);
    if (!stakedMeta || !rewardMeta || !maxRateRaw || !stakeTargetRaw || !address) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::create_reward_pool`,
          typeArguments: [],
          functionArguments: [
            stakedMeta,
            rewardMeta,
            maxRateRaw.toString(),
            stakeTargetRaw.toString(),
          ],
        },
      });
      setMsg({ text: `Pool created: ${r.hash.slice(0, 12)}\u2026`, error: false });
      setCreateMaxRate("");
      setCreateStakeTarget("");
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [address, createStakedToken, createRewardToken, createMaxRate, createStakeTarget, signAndSubmitTransaction, loadPositions]);

  const handleDepositRewards = useCallback(async () => {
    const pool = rewardPools.find((p) => p.addr === depositPoolAddr);
    if (!pool || !address) return;
    const raw = Math.floor(Number(depositAmount) * 10 ** pool.rewardDecimals);
    if (!raw) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::deposit_rewards`,
          typeArguments: [],
          functionArguments: [depositPoolAddr, raw.toString()],
        },
      });
      setMsg({ text: `Deposited: ${r.hash.slice(0, 12)}\u2026`, error: false });
      setDepositAmount("");
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [address, depositPoolAddr, depositAmount, rewardPools, signAndSubmitTransaction, loadPositions]);

  const handleStakeTokens = useCallback(async () => {
    const pool = rewardPools.find((p) => p.addr === stakePoolAddr);
    if (!pool || !address) return;
    const raw = Math.floor(Number(stakeAmount) * 10 ** pool.stakedDecimals);
    if (!raw) return;
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${VAULT_PACKAGE}::vault::stake_tokens`,
          typeArguments: [],
          functionArguments: [stakePoolAddr, raw.toString()],
        },
      });
      setMsg({ text: `Staked: ${r.hash.slice(0, 12)}\u2026`, error: false });
      setStakeAmount("");
      loadPositions();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [address, stakePoolAddr, stakeAmount, rewardPools, signAndSubmitTransaction, loadPositions]);

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
      setMsg({ text: `Rewards claimed: ${r.hash.slice(0, 12)}\u2026`, error: false });
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
      setMsg({ text: `Unstaked: ${r.hash.slice(0, 12)}\u2026`, error: false });
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
          {!address && (
            <p className="page-sub">Connect your wallet to lock tokens.</p>
          )}
          {address && (
            <div className="card" style={{ padding: 16 }}>
              <h2 className="section-title">Lock Tokens</h2>
              <TokenSelector
                value={lockToken.tokenKey}
                customAddr={lockToken.customAddr}
                customInfo={lockToken.customInfo}
                onChange={lockToken.setTokenKey}
                onCustomAddrChange={lockToken.handleCustomAddrChange}
              />
              {connected && (
                <div className="bal-static" style={{ marginTop: 6, fontSize: 12 }}>
                  Balance: {lockBal.loading ? "\u2026" : lockBal.formatted.toFixed(6)} {lockToken.getSymbol()}
                  {(() => {
                    const u = usdValueOf(lockBal.formatted, lockToken.getSymbol(), aptPrice);
                    return u !== null ? <span className="usd-inline"> · {formatUsd(u)}</span> : null;
                  })()}
                </div>
              )}
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
                disabled={!lockAmount || !lockDate || (lockToken.tokenKey === CUSTOM_KEY && !lockToken.customInfo)}
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

          {loading && <div className="page-loading">Loading\u2026</div>}

          <div className="card" style={{ padding: 16, marginTop: 12 }}>
            <h2 className="section-title">Locked Tokens Directory</h2>
            <p style={{ fontSize: 11, color: "#666", marginBottom: 10 }}>
              All tokens currently locked via Darbitex Vault.
            </p>
            {loading ? (
              <div className="dim" style={{ fontSize: 12 }}>Loading directory\u2026</div>
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
              <TokenSelector
                value={vestToken.tokenKey}
                customAddr={vestToken.customAddr}
                customInfo={vestToken.customInfo}
                onChange={vestToken.setTokenKey}
                onCustomAddrChange={vestToken.handleCustomAddrChange}
              />
              {connected && (
                <div className="bal-static" style={{ marginTop: 6, fontSize: 12 }}>
                  Balance: {vestBal.loading ? "\u2026" : vestBal.formatted.toFixed(6)} {vestToken.getSymbol()}
                  {(() => {
                    const u = usdValueOf(vestBal.formatted, vestToken.getSymbol(), aptPrice);
                    return u !== null ? <span className="usd-inline"> · {formatUsd(u)}</span> : null;
                  })()}
                </div>
              )}
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
                disabled={!vestAmount || !vestStart || !vestEnd || (vestToken.tokenKey === CUSTOM_KEY && !vestToken.customInfo)}
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
          {loading && <div className="page-loading">Loading\u2026</div>}
        </>
      )}

      {/* ===== STAKE TAB ===== */}
      {tab === "stake" && (
        <>
          {/* Reward Pool Directory */}
          <div className="card" style={{ padding: 16 }}>
            <h2 className="section-title">Reward Pools</h2>
            <p style={{ fontSize: 11, color: "#666", marginBottom: 10 }}>
              Active staking reward pools. Stake tokens to earn rewards over time.
            </p>
            {loading ? (
              <div className="dim" style={{ fontSize: 12 }}>Loading\u2026</div>
            ) : rewardPools.length === 0 ? (
              <div className="dim" style={{ fontSize: 12 }}>No reward pools yet.</div>
            ) : (
              <div className="vault-directory">
                <div className="vault-dir-header" style={{ gridTemplateColumns: "1fr 1fr 1fr 80px" }}>
                  <span>Stake</span>
                  <span>Reward</span>
                  <span>Staked</span>
                  <span>Balance</span>
                </div>
                {rewardPools.map((p) => (
                  <div key={p.addr} className="vault-dir-row" style={{ gridTemplateColumns: "1fr 1fr 1fr 80px" }}>
                    <span><strong>{p.stakedSymbol}</strong></span>
                    <span>{p.rewardSymbol}</span>
                    <span>{fmtAmount(p.totalStaked)}</span>
                    <span>{fmtAmount(p.rewardBalance)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Your Stake Positions */}
          {address && stakes.length > 0 && (
            <div className="card" style={{ padding: 16, marginTop: 12 }}>
              <h2 className="section-title">Your Stake Positions</h2>
              {stakes.map((s) => (
                <div key={s.addr} className="vault-row">
                  <div className="vault-row-info">
                    <strong>{fmtAmount(s.amount)} {s.stakedSymbol}</strong>
                    <span className="dim">Pool {s.poolAddr.slice(0, 10)}\u2026</span>
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

          {/* Stake Tokens into a Pool */}
          {address && rewardPools.length > 0 && (
            <div className="card" style={{ padding: 16, marginTop: 12 }}>
              <h2 className="section-title">Stake Tokens</h2>
              <label className="lock-label">
                Reward Pool
                <select
                  className="lock-input"
                  value={stakePoolAddr}
                  onChange={(e) => setStakePoolAddr(e.target.value)}
                >
                  <option value="">Select a pool...</option>
                  {rewardPools.map((p) => (
                    <option key={p.addr} value={p.addr}>
                      Stake {p.stakedSymbol} — Earn {p.rewardSymbol} ({p.addr.slice(0, 10)}\u2026)
                    </option>
                  ))}
                </select>
              </label>
              {stakePoolAddr && (
                <label className="lock-label">
                  Amount ({rewardPools.find((p) => p.addr === stakePoolAddr)?.stakedSymbol})
                  <input
                    className="lock-input"
                    type="number"
                    placeholder="0.00"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                  />
                </label>
              )}
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <span className="dim">Fee:</span> <strong>1 APT</strong>
              </div>
              <button
                className="btn btn-primary"
                style={{ width: "100%", marginTop: 12 }}
                disabled={!stakePoolAddr || !stakeAmount}
                onClick={handleStakeTokens}
              >
                Stake
              </button>
            </div>
          )}

          {/* Deposit Rewards into a Pool */}
          {address && rewardPools.length > 0 && (
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
                  {rewardPools.map((p) => (
                    <option key={p.addr} value={p.addr}>
                      {p.rewardSymbol} rewards — {p.stakedSymbol} staking ({p.addr.slice(0, 10)}\u2026)
                    </option>
                  ))}
                </select>
              </label>
              {depositPoolAddr && (
                <label className="lock-label">
                  Amount ({rewardPools.find((p) => p.addr === depositPoolAddr)?.rewardSymbol})
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

          {/* Create Reward Pool */}
          {address && (
            <div className="card" style={{ padding: 16, marginTop: 12 }}>
              <h2 className="section-title">Create Reward Pool</h2>
              <p style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>
                Create a new staking pool. Stakers deposit the staked token and earn the reward token over time.
              </p>
              <div style={{ fontSize: 11, color: "#999", marginBottom: 4 }}>Staked token</div>
              <TokenSelector
                value={createStakedToken.tokenKey}
                customAddr={createStakedToken.customAddr}
                customInfo={createStakedToken.customInfo}
                onChange={createStakedToken.setTokenKey}
                onCustomAddrChange={createStakedToken.handleCustomAddrChange}
              />
              <div style={{ fontSize: 11, color: "#999", marginTop: 12, marginBottom: 4 }}>Reward token</div>
              <TokenSelector
                value={createRewardToken.tokenKey}
                customAddr={createRewardToken.customAddr}
                customInfo={createRewardToken.customInfo}
                onChange={createRewardToken.setTokenKey}
                onCustomAddrChange={createRewardToken.handleCustomAddrChange}
              />
              <label className="lock-label">
                Max rate (reward tokens per second at full capacity)
                <input
                  className="lock-input"
                  type="number"
                  placeholder="0.001"
                  value={createMaxRate}
                  onChange={(e) => setCreateMaxRate(e.target.value)}
                />
              </label>
              <label className="lock-label">
                Stake target (staked amount for full emission rate)
                <input
                  className="lock-input"
                  type="number"
                  placeholder="1000"
                  value={createStakeTarget}
                  onChange={(e) => setCreateStakeTarget(e.target.value)}
                />
              </label>
              <div style={{ marginTop: 10, fontSize: 12 }}>
                <span className="dim">Fee:</span> <strong>1 APT</strong>
              </div>
              <button
                className="btn btn-primary"
                style={{ width: "100%", marginTop: 12 }}
                disabled={
                  !createMaxRate || !createStakeTarget ||
                  (createStakedToken.tokenKey === CUSTOM_KEY && !createStakedToken.customInfo) ||
                  (createRewardToken.tokenKey === CUSTOM_KEY && !createRewardToken.customInfo)
                }
                onClick={handleCreateRewardPool}
              >
                Create Reward Pool
              </button>
            </div>
          )}

          {!address && (
            <p className="page-sub">Connect your wallet to stake tokens.</p>
          )}
        </>
      )}

    </div>
  );
}
