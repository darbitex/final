import { PACKAGE, POOL_FEE_BPS, TREASURY, TREASURY_BPS } from "../config";

export function ProtocolPage() {
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

        <div className="protocol-card small">
          <div className="protocol-label">Audit passes</div>
          <div className="protocol-big">13</div>
          <div className="protocol-note">3 rounds, 5/5 R3 auditors GREEN</div>
        </div>
      </section>

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
