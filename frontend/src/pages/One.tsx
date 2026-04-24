import { NavLink, Outlet } from "react-router-dom";

export function OneShell() {
  return (
    <div className="container">
      <h1 className="page-title">ONE</h1>
      <p className="page-sub">
        Immutable stablecoin on Aptos. Retail-first (1 ONE minimum debt). APT-backed.
        Pyth-oracled. No governance. Sealed.
      </p>
      <div className="subnav">
        <NavLink end to="/one">Overview</NavLink>
        <NavLink to="/one/trove">Trove</NavLink>
        <NavLink to="/one/sp">Stability Pool</NavLink>
        <NavLink to="/one/redeem">Redeem</NavLink>
        <NavLink to="/one/liquidate">Liquidate</NavLink>
        <NavLink to="/one/about">About ONE</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
