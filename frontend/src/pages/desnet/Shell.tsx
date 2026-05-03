import { NavLink, Outlet } from "react-router-dom";

export function DesnetShell() {
  return (
    <div className="container">
      <h1 className="page-title">Token</h1>
      <p className="page-sub">
        Per-handle factory token + APT AMM, LP staking, liquidity portfolio,
        and protocol info. Switch to <strong>Social</strong> for timeline +
        opinion markets.
      </p>

      {/* Section pill switcher — Token vs Social */}
      <div className="subnav" style={{ marginBottom: 8 }}>
        <NavLink to="/desnet" end style={{ ...pillStyle, ...activePillStyle }}>
          Token
        </NavLink>
        <NavLink to="/desnet/social" style={pillStyle}>
          Social →
        </NavLink>
      </div>

      <div className="subnav">
        <NavLink end to="/desnet/register">Register</NavLink>
        <NavLink to="/desnet/swap">Swap</NavLink>
        <NavLink to="/desnet/liquidity">Liquidity</NavLink>
        <NavLink to="/desnet/portfolio">Portfolio</NavLink>
        <NavLink to="/desnet/about">About</NavLink>
      </div>
      <Outlet />
    </div>
  );
}

const pillStyle: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 12,
  border: "1px solid #444",
  textDecoration: "none",
  fontSize: "0.85em",
};

const activePillStyle: React.CSSProperties = {
  background: "#1a4480",
  color: "#fff",
  borderColor: "#1a4480",
};
