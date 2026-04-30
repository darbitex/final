import { NavLink, Outlet } from "react-router-dom";

export function DShell() {
  return (
    <div className="container">
      <h1 className="page-title">D</h1>
      <p className="page-sub">
        Immutable stablecoin on Aptos. Retail-first (0.1 D minimum debt).
        APT-backed. Pyth-oracled. No governance. Sealed.
      </p>
      <div className="subnav">
        <NavLink end to="/d">Overview</NavLink>
        <NavLink to="/d/trove">Trove</NavLink>
        <NavLink to="/d/sp" title="Stability Pool">SP</NavLink>
        <NavLink to="/d/donate">Donate</NavLink>
        <NavLink to="/d/redeem">Redeem</NavLink>
        <NavLink to="/d/liquidate">Liquidate</NavLink>
        <NavLink to="/d/about">About</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
