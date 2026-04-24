import { NavLink, Outlet } from "react-router-dom";

export function Tools() {
  return (
    <div className="container arb-wide">
      <h1 className="page-title">Tools</h1>
      <div className="subnav">
        <NavLink end to="/tools/factory">Factory</NavLink>
        <NavLink to="/tools/disperse">Disperse</NavLink>
      </div>
      <Outlet />
    </div>
  );
}
