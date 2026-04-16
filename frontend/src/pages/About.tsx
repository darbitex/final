export function AboutPage() {
  return (
    <div className="container about">
      <h1 className="page-title">About</h1>
      <p className="tagline">
        Decentralized Arbitrage Exchange on Aptos
      </p>

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
        vaults, LP staking &mdash; all live on-chain with zero admin surface, zero
        servers, and zero backend.
      </p>

      <h2 className="section-title">Core AMM &mdash; the two counters</h2>
      <p>
        <strong>Counter 1 &mdash; the pool.</strong> A vending machine. You put
        1 APT in, you get the exact amount of USDC the <code>x &times; y = k</code>{" "}
        curve says you get, minus a 1 bps fee that goes entirely to the LPs who
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
        The 1 bps swap fee goes 100% to LPs. There is no passive protocol fee slot.
      </p>

      <h2 className="section-title">Four execution surfaces</h2>
      <p>
        <strong>Swap</strong> &mdash; auto-routed, finds the best multi-hop path.{" "}
        <strong>Execute path</strong> &mdash; run a pre-computed path.{" "}
        <strong>Close triangle</strong> &mdash; real-capital cycle closure.{" "}
        <strong>Close triangle flash</strong> &mdash; zero-capital flash cycle.
      </p>
      <p>
        Each surface ships as an <code>entry</code> wrapper (for wallets), a
        composable <code>public fun</code> (FA-in/FA-out, for satellite packages),
        and a <code>#[view]</code> quote (for frontends). This three-tier API means
        anyone can build on Darbitex without needing permission or a core upgrade.
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
      </div>

      <h2 className="section-title">Universal flash loans</h2>
      <p>
        Every pool supports flash loans at 1 bps. Flash receipts are hot-potato
        structs &mdash; no abilities, must be consumed by <code>flash_repay</code>{" "}
        in the same transaction or the tx aborts.{" "}
        <code>close_triangle_flash</code> uses this internally for zero-capital
        cycle closure.
      </p>

      <h2 className="section-title">LP as NFT</h2>
      <p>
        LP positions are Aptos objects. <code>add_liquidity</code> uses Uniswap V2
        optimal-amount math &mdash; excess stays in your wallet.{" "}
        <code>claim_lp_fees</code> harvests accrued fees without touching principal.{" "}
        <code>remove_liquidity</code> burns the position for proportional reserves
        plus unclaimed fees. Positions are freely transferable, lockable, and
        stakeable.
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
        Token Vault and Token Factory are permanently frozen on-chain after passing
        audit.
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

      <h2 className="section-title">Prior art</h2>
      <p>
        The surplus-based fee concept is not new &mdash; CoW Protocol on Ethereum has
        charged a surplus-based fee since 2024 (50% of quote improvement via an
        off-chain solver auction). Darbitex's model is inspired by CoW; what is
        distinct is the implementation: pure on-chain DFS pathfinding in Move with no
        solver dependency, a 10% rate with no volume floor, and flash-loan triangle
        closure as a first-class user primitive.
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
        cross-venue aggregation, token factory, vault, LP staking, and LP locker are
        all deployed and verified on Aptos mainnet. This milestone is complete.
      </p>
      <p>
        <strong>2. Treasury bootstrap.</strong> When the treasury accumulates{" "}
        <strong>100 APT</strong> from organic protocol fees (the 10% surplus charge +
        satellite creation fees), those funds bootstrap the initial DARBITEX/APT
        liquidity pool on Darbitex itself.
      </p>
      <p>
        <strong>3. LP staking activation.</strong> Once the liquidity pool exists, LP
        staking reward pools go live with DARBITEX as the reward token. LP providers
        who stake earn DARBITEX. The protocol's own trading fees continuously refill
        the treasury, which continuously funds LP staking rewards.
      </p>
      <p>
        At that point Darbitex becomes a{" "}
        <strong>self-sustaining decentralized protocol</strong>: trading fees fund the
        treasury, the treasury funds LP incentives, LP incentives attract liquidity,
        liquidity enables better routing and more surplus capture, which feeds back
        into the treasury. No external funding, no team allocation, no VC &mdash;
        just a flywheel powered by actual protocol usage.
      </p>

      <h2 className="section-title">Disclaimer</h2>
      <div className="about-disclaimer">
        <p>
          Darbitex is <strong>experimental DeFi software</strong> built entirely by{" "}
          <strong>one human and one AI (Claude, by Anthropic)</strong>. Every smart
          contract, every satellite module, every line of frontend code, and every
          audit submission was produced by this two-person team. The AI-conducted
          audits (13 passes across 3 rounds) are{" "}
          <strong>AI-generated reviews, not professional security audits</strong> by
          a licensed firm. They are aids to development, not guarantees of correctness
          or safety.
        </p>
        <p>
          Darbitex is a <strong>first mover</strong> in surplus-fee AMM design on
          Aptos. There is no prior production deployment of this architecture on this
          chain. The protocol, its satellites, and its tokenomics are all experimental
          and unproven at scale. Smart contracts may contain undiscovered bugs. Funds
          deposited into pools, vaults, staking contracts, or any other on-chain
          component <strong>may be lost permanently</strong>.
        </p>
        <p>
          There is{" "}
          <strong>
            no team, no company, no legal entity, no customer support, no insurance
            fund, and no recourse mechanism
          </strong>
          . All code is published under The Unlicense (public domain). The 3-of-5
          multisig controls upgrade policy during the soak period but provides no
          warranty of any kind.
        </p>
        <p>
          <strong>
            Do not deposit more than you can afford to lose entirely.
          </strong>{" "}
          Nothing on this site or in this protocol constitutes investment advice,
          financial advice, or a solicitation to buy, sell, or hold any token. The
          $DARBITEX token, if and when launched, carries no promise of value, utility,
          or return.
        </p>
        <p>
          <strong>
            By visiting, accessing, or using Darbitex &mdash; including but not
            limited to the frontend at darbitex.wal.app, any smart contract
            interaction, and any satellite service &mdash; you acknowledge that you
            have read and understood this disclaimer, that you accept all risks, and
            that you agree to hold harmless the creators, contributors, and multisig
            signers from any and all liability, loss, or damage arising from your use
            of the protocol.
          </strong>
        </p>
        <p className="mute" style={{ marginTop: 12 }}>
          Use at your own risk. You have been warned.
        </p>
      </div>
    </div>
  );
}
