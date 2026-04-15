export function AboutPage() {
  return (
    <div className="container about">
      <h1 className="page-title">About</h1>
      <p className="tagline">
        Programmable Arbitrage AMM on Aptos — 1 bps LP fee · smart routing + cycle closure +
        flash arb · zero admin
      </p>

      <div className="about-grid">
        <div className="about-stat">
          <div className="big">1</div>
          <div className="label">BPS LP FEE</div>
        </div>
        <div className="about-stat">
          <div className="big">3</div>
          <div className="label">CORE MODULES</div>
        </div>
        <div className="about-stat">
          <div className="big">13</div>
          <div className="label">AUDIT PASSES</div>
        </div>
        <div className="about-stat">
          <div className="big">0</div>
          <div className="label">ADMIN FUNCTIONS</div>
        </div>
      </div>

      <h2 className="section-title">What is Darbitex?</h2>
      <p>
        Darbitex is a programmable arbitrage AMM on Aptos. It pairs an immutable{" "}
        <code>x × y = k</code> pool primitive with an opinionated routing layer that ships
        smart multi-hop swaps, real-capital cycle closure, and flash-loan triangle arbitrage
        as first-class on-chain operations. The protocol takes 10% of measurable surplus over
        the canonical direct baseline — and nothing when there is no baseline to improve on.
      </p>

      <h2 className="section-title">The 10% rule — only on measurable surplus</h2>
      <p>
        Darbitex charges 10% only on measurable surplus: the delta between what a routed
        trade actually produced and what a direct canonical pool swap would have produced
        for the same input. If the user swaps $1 and receives $1, we take nothing. If the
        user swaps $1 and receives $1.10 thanks to smart routing, we take $0.01.
      </p>
      <p>
        <strong>No baseline = no charge.</strong> If the canonical direct pool doesn't
        exist, there is no reference point, so the entire output goes to the caller.
        Darbitex refuses to tax trades where it is the only available path — a policy
        enforced in code, not convention.
      </p>
      <p>
        The 1 bps swap fee on the underlying pool primitive goes 100% to LPs via a
        MasterChef V2-style per-share accumulator. There is no passive protocol fee slot.
      </p>

      <h2 className="section-title">Prior art</h2>
      <p>
        The surplus-based fee concept is not new — CoW Protocol on Ethereum has charged a
        surplus-based fee since 2024 (50% of quote improvement via an off-chain solver
        auction). Darbitex's economic model is inspired by CoW; what is distinct here is
        the implementation: pure on-chain DFS pathfinding in Move with no solver
        dependency, a 10% rate with no volume floor, and flash-loan triangle closure as a
        first-class user primitive.
      </p>

      <h2 className="section-title">Universal flash loans</h2>
      <p>
        Every pool supports flash loans at the same 1 bps rate. Flash receipts are
        hot-potato structs with no abilities — they must be consumed by{" "}
        <code>flash_repay</code> in the same transaction or the tx aborts.{" "}
        <code>close_triangle_flash</code> uses this internally to close rebalancing cycles
        with zero up-front capital.
      </p>

      <h2 className="section-title">LP as NFT</h2>
      <p>
        LP positions are Aptos objects. <code>add_liquidity</code> uses Uniswap V2
        router-style optimal amount computation — any slippage buffer you provide stays in
        your wallet if it isn't needed. <code>claim_lp_fees</code> harvests accrued fees
        without touching principal, and <code>remove_liquidity</code> burns the position
        for proportional reserves plus unclaimed fees in one shot. Positions are freely
        transferable.
      </p>

      <h2 className="section-title">Audit — 13 passes across 3 rounds</h2>
      <p>
        Final went through 3 audit rounds with 13 independent AI auditor passes: Gemini 2.5
        Pro (R1 + R3), Grok 4, Qwen, Kimi K2 (R1 + R3), DeepSeek (R1 + R3), ChatGPT GPT-5
        (R1 + R2), fresh Claude Opus 4.6 web (R2 + R3), in-session Claude, and Perplexity.
        A total of 14 actionable fixes were applied across the rounds.
      </p>
      <p>
        <strong>Final verdict:</strong> all 5 R3 auditors returned 🟢 GREEN. Gemini — the
        most adversarial auditor throughout — concluded:{" "}
        <em>
          "The architecture is clean, the fallback logic is flawless, and the protection
          mechanisms against both economic manipulation and execution-halting DoS are
          mathematically sound. Proceed to publish."
        </em>
      </p>
      <p className="mute">Audits are aids, not guarantees. Read the code.</p>

      <h2 className="section-title">Fully decentralized</h2>
      <p>
        <strong>Smart contracts</strong> — on Aptos mainnet, published from a 3-of-5
        multisig. <code>upgrade_policy = "compatible"</code> during a 3–6 month soak, then
        flipped to <code>immutable</code>.
      </p>
      <p>
        <strong>Frontend</strong> — hosted on Walrus (decentralized storage on Sui).
      </p>
      <p>
        <strong>Backend</strong> — there is none. All state lives on-chain; pools, reserves,
        routes, and quotes are read directly from Aptos RPC.
      </p>
    </div>
  );
}
