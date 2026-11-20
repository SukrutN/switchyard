/* ============================================================
   iso, the classic 3D placement diagram, drawn as isometric
   SVG polygons. Pure math, no dependencies, no canvas: the
   figure on the page and the interactive pack hall share it.

   Projection: u = (x − y)·√3/2, v = (x + y)·0.5 − z, py = −v.
   Depths ascend with x+y+z, so painter order = far first.
   ============================================================ */

import type { PlacedBox } from "@/engine/boxcar-engine/index.ts";

export interface Face {
  key: string;
  side: "top" | "left" | "right";
  points: string; // SVG polygon points, 2dp
}

export interface IsoBox {
  faces: Face[];
  label: { x: number; y: number; text: string } | null;
}

const K = Math.sqrt(3) / 2;

export function project(x: number, y: number, z: number): [number, number] {
  const u = (x - y) * K;
  const v = (x + y) * 0.5 - z;
  return [u, -v];
}

function poly(points: [number, number][]): string {
  return points
    .map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`)
    .join(" ");
}

/** Faces of one box, camera-facing sides only (+x and +y plus top). */
export function boxFaces(
  box: Pick<PlacedBox, "pos" | "dims"> & { unit: { sku: string } },
  unitScale = 0.01, // ticks → cm
): IsoBox {
  const ux = box.pos.x * unitScale;
  const uy = box.pos.y * unitScale;
  const uz = box.pos.z * unitScale;
  const w = box.dims.x * unitScale;
  const d = box.dims.y * unitScale;
  const h = box.dims.z * unitScale;
  const x2 = ux + w;
  const y2 = uy + d;
  const z2 = uz + h;

  const top = [project(ux, uy, z2), project(x2, uy, z2), project(x2, y2, z2), project(ux, y2, z2)];
  const right = [project(x2, uy, z2), project(x2, y2, z2), project(x2, y2, uz), project(x2, uy, uz)];
  const left = [project(ux, y2, z2), project(x2, y2, z2), project(x2, y2, uz), project(ux, y2, uz)];

  const faces: Face[] = [
    { key: "top", side: "top", points: poly(top) },
    { key: "right", side: "right", points: poly(right) },
    { key: "left", side: "left", points: poly(left) },
  ];

  const c = project(ux + w / 2, uy + d / 2, z2);
  return {
    faces,
    label: { x: c[0], y: c[1] - 1.2, text: box.unit.sku },
  };
}

export interface IsoFrame {
  view: string; // viewBox
  grid: string[]; // floor grid polylines
  walls: { floor: string; verticals: string[]; rim: string };
}

/** The carton shell: floor grid, wall verticals, dashed rim. */
export function cartonFrame(
  w: number, // inner dims, cm
  d: number,
  h: number,
  gridStep = 5,
): IsoFrame {
  const corners: [number, number][] = [];
  const a = project(0, 0, 0);
  const b = project(w, 0, 0);
  const c = project(w, d, 0);
  const e = project(0, d, 0);
  corners.push(a, b, c, e);
  const c2 = project(w, d, h);
  const b2 = project(w, 0, h);
  const e2 = project(0, d, h);
  const a2 = project(0, 0, h);
  corners.push(b2, e2, c2, a2);

  const minX = Math.min(...corners.map((p) => p[0]));
  const maxX = Math.max(...corners.map((p) => p[0]));
  const minY = Math.min(...corners.map((p) => p[1]));
  const maxY = Math.max(...corners.map((p) => p[1]));
  const pad = 7;
  const view = `${(minX - pad).toFixed(2)} ${(minY - pad).toFixed(2)} ${(maxX - minX + pad * 2).toFixed(2)} ${(maxY - minY + pad * 2).toFixed(2)}`;

  const grid: string[] = [];
  for (let gx = gridStep; gx < w; gx += gridStep) {
    grid.push(poly([project(gx, 0, 0), project(gx, d, 0)]));
  }
  for (let gy = gridStep; gy < d; gy += gridStep) {
    grid.push(poly([project(0, gy, 0), project(w, gy, 0)]));
  }

  return {
    view,
    grid,
    walls: {
      floor: poly([a, b, c, e]),
      verticals: [
        poly([a, a2]),
        poly([b, b2]),
        poly([c, c2]),
        poly([e, e2]),
      ],
      rim: poly([a2, b2, c2, e2]),
    },
  };
}
