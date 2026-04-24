import { NavLink, Outlet } from "react-router-dom";

export function Liquidity() {
  return (
    <div className="container">
      <h1 className="page-title">Liquidity</h1>
      <div className="subnav">
        <NavLink end to="/liquidity/pools">Pools</NavLink>
        <NavLink to="/liquidity/portfolio">Portfolio</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
