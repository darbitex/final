import { useEffect, useState } from "react";
import { PACKAGE, POOL_FEE_BPS, TREASURY, TREASURY_BPS } from "../config";
import { fetchFaMetadata } from "../chain/balance";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";

const rpc = createRpcPool("about");

type PoolSnapshot = {
  address: string;
  symbolA: string;
  symbolB: string;
  decA: number;
  decB: number;
  reserveA: bigint;
  reserveB: bigint;
};

type PoolResourceShape = {
  reserve_a: string | number;
  reserve_b: string | number;
  metadata_a: { inner: string };
  metadata_b: { inner: string };
};

type VolumeAggregate = {
  perToken: Record<string, bigint>;
  perTokenDecimals: Record<string, number>;
  eventCount: number;
  indexerFailed: boolean;
};

export function AboutPage() {
  const [poolCount, setPoolCount] = useState<number | null>(null);
  const [pools, setPools] = useState<PoolSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [volume, setVolume] = useState<VolumeAggregate | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let addrs: string[] = [];
      try {
        const [all] = await rpc.viewFn<[string[]]>("pool_factory::get_all_pools", [], []);
        addrs = all.map((a) => String(a));
        if (!cancelled) setPoolCount(addrs.length);
      } catch {
        if (!cancelled) setPoolCount(null);
      }

      // Fetch Pool resource + FA metadata for every pool returned by the
      // factory. Live discovery — new permissionless pools (D, DARBITEX,
      // custom pairs) appear here without any frontend redeploy.
      const snapshots = await Promise.all(
        addrs.map(async (addr) => {
          try {
            const data = await rpc.rotatedGetResource<PoolResourceShape>(
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
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setPools(snapshots.filter((s): s is PoolSnapshot => s !== null));
        setLoading(false);
      }

      // Address → (symbol, decimals) per side, built from the snapshots above.
      // Lets the volume aggregator resolve symbols for any pool the factory
      // knows about, not just the INITIAL_POOLS seed list.
      const poolInfo = new Map<
        string,
        { symbolA: string; symbolB: string; decA: number; decB: number }
      >();
      for (const s of snapshots) {
        if (s) {
          poolInfo.set(s.address.toLowerCase(), {
            symbolA: s.symbolA,
            symbolB: s.symbolB,
            decA: s.decA,
            decB: s.decB,
          });
        }
      }

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
        const perTokenDecimals: Record<string, number> = {};
        let eventCount = 0;
        for (const ev of result.events ?? []) {
          const d = ev.data;
          const poolAddr = String(d.pool_addr ?? "").toLowerCase();
          const amtIn = BigInt(String(d.amount_in ?? "0"));
          const aToB = !!d.a_to_b;
          const info = poolInfo.get(poolAddr);
          if (!info) continue;
          const sideSymbol = aToB ? info.symbolA : info.symbolB;
          const sideDec = aToB ? info.decA : info.decB;
          perToken[sideSymbol] = (perToken[sideSymbol] ?? 0n) + amtIn;
          perTokenDecimals[sideSymbol] = sideDec;
          eventCount += 1;
        }
        setVolume({ perToken, perTokenDecimals, eventCount, indexerFailed: false });
      } catch {
        if (!cancelled) {
          setVolume({
            perToken: {},
            perTokenDecimals: {},
            eventCount: 0,
            indexerFailed: true,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const tvlByToken: Record<string, bigint> = {};
  const tvlDecimals: Record<string, number> = {};
  for (const p of pools) {
    tvlByToken[p.symbolA] = (tvlByToken[p.symbolA] ?? 0n) + p.reserveA;
    tvlByToken[p.symbolB] = (tvlByToken[p.symbolB] ?? 0n) + p.reserveB;
    tvlDecimals[p.symbolA] = p.decA;
    tvlDecimals[p.symbolB] = p.decB;
  }
  const tvlEntries = Object.entries(tvlByToken).sort(([a], [b]) => a.localeCompare(b));
  const volumeEntries = volume
    ? Object.entries(volume.perToken).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div className="container about">
      <h1 className="page-title">About</h1>
      <p className="tagline">Decentralized Arbitrage Exchange on Aptos</p>

      <div className="about-grid">
        <div className="about-stat">
          <div className="big">1</div>
          <div className="label">BPS LP FEE</div>
        </div>
        <div className="about-stat">
          <div className="big">9</div>
          <div className="label">ON-CHAIN MODULES</div>
        </div>
        <div className="about-stat">
          <div className="big">0</div>
          <div className="label">ADMIN FUNCTIONS</div>
        </div>
        <div className="about-stat">
          <div className="big">0</div>
          <div className="label">SERVERS</div>
        </div>
      </div>

      <h2 className="section-title">What is Darbitex?</h2>
      <p>
        Darbitex is a <strong>fully decentralized exchange ecosystem</strong> on{" "}
        <strong>Aptos</strong>. At its core is a surplus-fee AMM: an immutable{" "}
        <code>x &times; y = k</code> pool paired with a composable routing layer
        that charges <strong>10% only on measurable surplus</strong> over what a
        direct swap would have produced. No surplus, no fee.
      </p>
      <p>
        Around this core sits a constellation of <strong>satellite packages</strong>
        &mdash; each is an independent on-chain module that composes the core's
        public primitives without requiring any upgrade to the core itself.
        Cross-venue aggregation, flash arbitrage, token creation, time-locked
        vaults, LP staking, and the D stablecoin &mdash; all live on-chain with
        zero admin surface, zero servers, and zero backend.
      </p>

      <h2 className="section-title">Core AMM &mdash; the two counters</h2>
      <p>
        <strong>Counter 1 &mdash; the pool.</strong> A vending machine. You put
        1 APT in, you get the exact amount of USDC the <code>x &times; y = k</code>{" "}
        curve says you get, minus a 5 bps fee that goes entirely to the LPs who
        stocked the machine. No opinions, no strategies, no callbacks, no admin.
      </p>
      <p>
        <strong>Counter 2 &mdash; arbitrage.</strong> A smart clerk. You hand your
        APT and say "get me USDC". The clerk simulates the direct route and every
        multi-hop route, picks whichever produces more, and hands you the output.
        If the smart route beat the direct vending machine swap, the clerk keeps 10%
        of the <em>difference</em>. If there was no difference, the clerk keeps nothing.
      </p>
      <p>
        The clerk also runs flash-loan triangle arbitrage: borrow from pool A, cycle
        through B &rarr; C &rarr; A, repay the loan. 90% of profit to the caller,
        10% to treasury. Anyone can trigger it.
      </p>

      <h2 className="section-title">The 10% rule</h2>
      <p>
        Darbitex charges 10% only on <strong>measurable surplus</strong>: the delta
        between what the routed trade produced and what a direct canonical pool swap
        would have produced. Swap $1 and receive $1 &mdash; no charge. Swap $1 and
        receive $1.10 thanks to multi-hop routing &mdash; we take $0.01.
      </p>
      <p>
        <strong>No baseline = no charge.</strong> If the direct pool doesn't exist,
        there is no reference point, so the entire output goes to the caller.
        Enforced in code, not convention.
      </p>
      <p>
        The 5 bps swap fee goes 100% to LPs. There is no passive protocol fee slot.
      </p>

      <h2 className="section-title">Satellite ecosystem</h2>
      <p>
        Satellites are independent on-chain packages that compose the core's public
        primitives. Adding a new feature never requires a core upgrade.
      </p>

      <div className="about-satellites">
        <div className="about-sat">
          <strong>Cross-Venue Aggregator</strong>
          <span className="dim"> &mdash; </span>
          Compares quotes across Darbitex, Hyperion CLMM, ThalaSwap V2, and Cellana
          in parallel. Executes through whichever venue wins. Each external venue is
          wrapped in its own adapter satellite with primitive-only Move view/entry
          functions.
        </div>
        <div className="about-sat">
          <strong>Flash Arbitrage (Flashbot)</strong>
          <span className="dim"> &mdash; </span>
          Borrows from Aave V3 (0 fee), swaps through Darbitex + an external venue,
          repays, splits profit 90% caller / 10% treasury. Supports Thala, Hyperion,
          and Cellana routes. Anyone can trigger.
        </div>
        <div className="about-sat">
          <strong>Token Factory</strong>
          <span className="dim"> &mdash; </span>
          Create new FA tokens with a name and symbol. Tiered pricing (1-char:
          1000 APT down to 5+: 0.1 APT). Fixed 1B supply per token. Self-burn
          via BurnCap. No future minting. Permanently frozen on-chain.
        </div>
        <div className="about-sat">
          <strong>Token Vault</strong>
          <span className="dim"> &mdash; </span>
          Three modes for any FA token: time-based lock, linear vesting schedule,
          and staking with reward pools. Permissionless pool creation &mdash; anyone
          can set up a staking pool and deposit rewards. Permanently frozen on-chain.
        </div>
        <div className="about-sat">
          <strong>LP Staking</strong>
          <span className="dim"> &mdash; </span>
          Stake Darbitex LP positions into reward pools. Earn any reward token over
          time while still collecting LP swap fees. Anyone can create a reward pool
          for any Darbitex pool + any reward token.
        </div>
        <div className="about-sat">
          <strong>LP Locker</strong>
          <span className="dim"> &mdash; </span>
          Wraps LP positions with a time-based unlock gate. LP fees remain claimable
          while locked &mdash; only the principal is gated by the unlock timestamp.
          Used for protocol-owned liquidity locks.
        </div>
        <div className="about-sat">
          <strong>D &mdash; APT-collateralized stablecoin</strong>
          <span className="dim"> &mdash; </span>
          Retail-first, 0.1 D minimum debt, sealed. Pyth-oracled APT/USD. 200%
          MCR, 150% liquidation threshold, 10% bonus. Stability pool catches
          liquidations, 10% mint+redeem fees agnostically donated to SP, 90% to
          keyed depositors. Permissionless donate_to_sp + donate_to_reserve.
          Package <code>0x587c8084…</code>, FA <code>0x9015d5a6…</code>.
        </div>
        <div className="about-sat">
          <strong>DeSNet &mdash; decentralized social network</strong>
          <span className="dim"> &mdash; </span>
          Sister protocol on Aptos. Every profile is a transferable PID NFT,
          every profile spawns its own factory token, every social action is
          an on-chain primitive. As of v0.4 every mint can carry an{" "}
          <strong>opinion market</strong> &mdash; a perpetual no-settle{" "}
          <code>x &times; y = k</code> belief market denominated in the
          author's own token, with a 0.1% trade tax burned into deflation. 19
          modules, 3/5 multisig governance, R7 audit 5/6 GREEN. Lives at{" "}
          <code>0x7ba7ee5a…</code>. Browse the full app at{" "}
          <a href="/desnet">/desnet</a>.
        </div>
      </div>

      <h2 className="section-title">Protocol &mdash; live state</h2>
      <p className="page-sub">
        Zero admin surface, hardcoded treasury, 3-of-5 publisher multisig,
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
          <div className="protocol-note">100% to LPs &mdash; no passive protocol slot</div>
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
            <code>pool</code> &middot; <code>pool_factory</code> &middot; <code>arbitrage</code>
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
            <span className="reserves">
              {fromRaw(raw, tvlDecimals[symbol] ?? 0).toFixed(4)}
            </span>
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
            Volume tracking paused &mdash; the Aptos Labs indexer <code>events</code>{" "}
            table was deprecated 2026-09-08, and the replacement surface for
            decoded event data is still landing. Reserves above are read directly
            from fullnode and remain live.
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
                <span className="reserves">
                  {fromRaw(raw, volume?.perTokenDecimals[symbol] ?? 0).toFixed(4)}
                </span>
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
          <span className="venue-name"><code>execute_path</code></span>
          <span className="venue-out">Smart multi-hop swap along a pre-computed optimal path</span>
        </div>
        <div className="venue-row">
          <span className="venue-name"><code>swap</code></span>
          <span className="venue-out">Auto-routed in→out swap; finds the best path internally</span>
        </div>
        <div className="venue-row">
          <span className="venue-name"><code>close_triangle</code></span>
          <span className="venue-out">Real-capital cycle closure from caller's primary store</span>
        </div>
        <div className="venue-row">
          <span className="venue-name"><code>close_triangle_flash</code></span>
          <span className="venue-out">Flash-borrow → cycle → repay, zero up-front capital</span>
        </div>
      </div>

      <h2 className="section-title">Universal flash loans</h2>
      <p>
        Every pool supports flash loans at 5 bps. Flash receipts are hot-potato
        structs &mdash; no abilities, must be consumed by <code>flash_repay</code>{" "}
        in the same transaction or the tx aborts.{" "}
        <code>close_triangle_flash</code> uses this internally for zero-capital
        cycle closure.
      </p>

      <h2 className="section-title">Audit &mdash; 13 passes across 3 rounds</h2>
      <p>
        The core package went through 3 audit rounds with 13 independent AI auditor
        passes: Gemini 2.5 Pro, Grok 4, Qwen, Kimi K2, DeepSeek, ChatGPT GPT-5,
        Claude Opus 4.6, and Perplexity. 14 actionable fixes applied. All 5 R3
        auditors returned GREEN.
      </p>
      <p>
        Each satellite has its own audit trail (R1 minimum, 5 auditors each). The
        Token Vault, Token Factory, and D are permanently frozen on-chain after
        passing audit.
      </p>
      <p className="mute">Audits are aids, not guarantees. Read the code.</p>

      <h2 className="section-title">Fully decentralized</h2>
      <p>
        <strong>Smart contracts</strong> &mdash; on Aptos mainnet, published from a
        3-of-5 multisig. Launched under <code>compatible</code> upgrade policy during
        a 3&ndash;6 month soak. After the soak, upgrade policy flips to{" "}
        <code>immutable</code> &mdash; including the hardcoded treasury address and
        the 10% surplus rate.
      </p>
      <p>
        <strong>Frontend</strong> &mdash; hosted on Walrus (decentralized storage on
        Sui). No centralized server.
      </p>
      <p>
        <strong>Backend</strong> &mdash; there is none. All state lives on-chain.
        Pools, reserves, routes, and quotes are read directly from Aptos RPC.
      </p>

      <h2 className="section-title">When $DARBITEX?</h2>
      <p>
        The <strong>DARBITEX</strong> token has been created via the Token Factory
        satellite: 1 billion supply, 8 decimals. It is not yet in circulation.
      </p>
      <p>
        <strong>Launch criteria:</strong>
      </p>
      <p>
        <strong>1. POC proven.</strong> The core AMM, smart routing, flash arbitrage,
        cross-venue aggregation, token factory, vault, LP staking, LP locker, and
        the D stablecoin are all deployed and verified on Aptos mainnet. This
        milestone is complete.
      </p>
      <p>
        <strong>2. Treasury bootstrap.</strong> When the treasury accumulates{" "}
        <strong>200 APT</strong> from organic protocol fees (the 10% surplus charge +
        satellite creation fees), those funds bootstrap the initial{" "}
        <strong>D/DARBITEX</strong> liquidity pool on Darbitex itself, seeded with{" "}
        <strong>99 D / 99M DARBITEX</strong>.
      </p>
      <p>
        <strong>3. LP staking activation.</strong> Once the liquidity pool exists, LP
        staking reward pools go live with all of remaining total supply{" "}
        <strong>900M DARBITEX</strong> as the reward token, max rate{" "}
        <strong>10 per second</strong>. LP providers who stake their D/DARBITEX LP
        tokens earn DARBITEX.
      </p>
      <p style={{ marginLeft: 18 }}>
        <strong>LP staking formula (C-variant adoption emission).</strong> The pool
        emits at a rate proportional to how much of the underlying LP supply is
        actually staked. Concretely:
      </p>
      <p style={{ marginLeft: 18 }}>
        <code>emission_per_sec = total_staked / pool.lp_supply &times; max_rate_per_sec</code>
      </p>
      <p style={{ marginLeft: 18 }}>
        At 100% LP adoption (every LP token in the pool is staked) the pool pays
        out the full 10 DARBITEX/sec. At 50% adoption it pays 5/sec, at 1% it pays
        0.1/sec, and at 0% it pays nothing &mdash; emission only flows when LPs
        stake, so unspent runway never burns. This bounds the maximum emission at
        the design rate but lets adoption decide the actual rate without any
        admin lever.
      </p>
      <p style={{ marginLeft: 18 }}>
        <strong>Per-staker share is independent of how many others stake.</strong>{" "}
        Your reward at time <em>t</em> is{" "}
        <code>(your_staked / pool.lp_supply) &times; max_rate_per_sec &times; dt</code>
        . When more stakers join, total emission rises proportionally &mdash; your
        share does NOT dilute. The formula is decimal-agnostic; max_rate_per_sec
        is denominated in raw reward-token units.
      </p>
      <p style={{ marginLeft: 18 }}>
        <strong>Runway.</strong> 900M DARBITEX at 10/sec = ~1042 days (~2.85 years)
        of full-saturation emission. Realistic adoption will stretch this many
        multiples longer. The protocol's own trading fees continuously refill the
        treasury for future programs.
      </p>

      <h2 className="section-title">Disclaimer</h2>
      <div className="about-disclaimer">
        <p>
          Darbitex is <strong>experimental DeFi software</strong> built entirely by{" "}
          <strong>one human and one AI (Claude, by Anthropic)</strong>. Every smart
          contract, every satellite module, every line of frontend code, and every
          audit submission was produced by this two-person team. The AI-conducted
          audits are{" "}
          <strong>AI-generated reviews, not professional security audits</strong> by
          a licensed firm. They are aids to development, not guarantees of correctness
          or safety.
        </p>
        <p>
          Smart contracts may contain undiscovered bugs. Funds deposited into pools,
          vaults, staking contracts, troves, the D stability pool, or any other
          on-chain component <strong>may be lost permanently</strong>.
        </p>
        <p>
          There is{" "}
          <strong>
            no team, no company, no legal entity, no customer support, no insurance
            fund, and no recourse mechanism
          </strong>
          . All code is published under The Unlicense (public domain).
        </p>
        <p>
          <strong>Do not deposit more than you can afford to lose entirely.</strong>{" "}
          Nothing on this site or in this protocol constitutes investment advice.
        </p>
        <p className="mute" style={{ marginTop: 12 }}>
          Use at your own risk. You have been warned.
        </p>
      </div>
    </div>
  );
}
