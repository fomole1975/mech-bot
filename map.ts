// Static map model: 1 m height grids, wall/clearance mask, 2 m navigation grid, LOS raycasts.
import { readFileSync } from "node:fs"

type Prism = { kind: string; base: number; top: number; ring: number[]; holes: number[][] | number[] }

export class GameMap {
  nx: number
  ny: number
  minX: number
  minY: number
  ground: Float32Array // terrain height at 1 m vertices
  surf: Float32Array // walkable surface (ground, or top of a low building/deck)
  solid: Float32Array // top of solid column for shots/vision
  blocked: Uint8Array // 1 m: mech center cannot stand here (wall within radius)
  // nav grid (2 m)
  NX: number
  NY: number
  nodeOk: Uint8Array
  nbr: Uint8Array // bitmask of passable directions (8)
  bminX: number
  bmaxX: number
  bminY: number
  bmaxY: number

  constructor(dir: string) {
    const w = JSON.parse(readFileSync(dir + "/v2/world.json", "utf8"))
    const t = w.terrain
    this.nx = t.nx
    this.ny = t.ny
    this.minX = t.minX
    this.minY = t.minY
    const nx = this.nx, ny = this.ny, N = nx * ny
    const buf = readFileSync(dir + "/v2/terrain.i16")
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
    this.ground = new Float32Array(N)
    for (let k = 0; k < N; k++) this.ground[k] = i16[k] * (t.scale ?? 0.01)
    this.surf = new Float32Array(this.ground)
    this.solid = new Float32Array(this.ground)
    const b = w.bounds
    this.bminX = b.minX; this.bmaxX = b.maxX; this.bminY = b.minY; this.bmaxY = b.maxY
    const prisms: Prism[] = (w.prisms as Prism[]).slice().sort((a, b) => a.base - b.base)
    for (const p of prisms) this.raster(p)
    this.buildBlocked()
    this.buildNav()
  }

  private raster(p: Prism) {
    const r = p.ring
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let k = 0; k < r.length; k += 2) {
      x0 = Math.min(x0, r[k]); x1 = Math.max(x1, r[k])
      y0 = Math.min(y0, r[k + 1]); y1 = Math.max(y1, r[k + 1])
    }
    let holes: number[][] = []
    if (Array.isArray(p.holes) && p.holes.length) {
      holes = typeof p.holes[0] === "number" ? [p.holes as number[]] : (p.holes as number[][])
    }
    const i0 = Math.max(0, Math.ceil(x0 - this.minX)), i1 = Math.min(this.nx - 1, Math.floor(x1 - this.minX))
    const j0 = Math.max(0, Math.ceil(y0 - this.minY)), j1 = Math.min(this.ny - 1, Math.floor(y1 - this.minY))
    for (let j = j0; j <= j1; j++) {
      const y = this.minY + j
      for (let i = i0; i <= i1; i++) {
        const x = this.minX + i
        if (!pip(r, x, y)) continue
        let inHole = false
        for (const h of holes) if (h.length >= 6 && pip(h, x, y)) { inHole = true; break }
        if (inHole) continue
        const c = j * this.nx + i
        const g = this.ground[c]
        if (p.base <= this.surf[c] + 8.9 && p.top > this.surf[c]) this.surf[c] = p.top
        if (p.base <= g + 2.0 && p.top > this.solid[c]) this.solid[c] = p.top
      }
    }
  }

  private buildBlocked() {
    const nx = this.nx, ny = this.ny
    this.blocked = new Uint8Array(nx * ny)
    const R = 2.6
    const offs: number[][] = []
    for (let dj = -3; dj <= 3; dj++)
      for (let di = -3; di <= 3; di++) {
        const d = Math.hypot(di, dj)
        if (d <= R && d > 0) offs.push([di, dj, 1.25 + 0.7 * d])
      }
    const s = this.surf
    // map edge margin
    const mx0 = Math.ceil(this.bminX - this.minX + 3), mx1 = Math.floor(this.bmaxX - this.minX - 3)
    const my0 = Math.ceil(this.bminY - this.minY + 3), my1 = Math.floor(this.bmaxY - this.minY - 3)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i
        if (i < mx0 || i > mx1 || j < my0 || j > my1) { this.blocked[c] = 1; continue }
        const h = s[c]
        for (const o of offs) {
          const ii = i + o[0], jj = j + o[1]
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue
          if (s[jj * nx + ii] > h + o[2]) { this.blocked[c] = 1; break }
        }
      }
  }

  private buildNav() {
    this.NX = Math.floor((this.nx - 1) / 2) + 1
    this.NY = Math.floor((this.ny - 1) / 2) + 1
    const NX = this.NX, NY = this.NY
    this.nodeOk = new Uint8Array(NX * NY)
    this.nbr = new Uint8Array(NX * NY)
    for (let J = 0; J < NY; J++)
      for (let I = 0; I < NX; I++) this.nodeOk[J * NX + I] = this.blocked[2 * J * this.nx + 2 * I] ? 0 : 1
    for (let J = 0; J < NY; J++)
      for (let I = 0; I < NX; I++) {
        const n = J * NX + I
        if (!this.nodeOk[n]) continue
        let m = 0
        for (let d = 0; d < 8; d++) {
          const I2 = I + DX[d], J2 = J + DY[d]
          if (I2 < 0 || J2 < 0 || I2 >= NX || J2 >= NY) continue
          if (!this.nodeOk[J2 * NX + I2]) continue
          // 1 m samples along the edge
          const a = 2 * J * this.nx + 2 * I
          const mid = (2 * J + DY[d]) * this.nx + 2 * I + DX[d]
          const e = 2 * J2 * this.nx + 2 * I2
          if (this.blocked[mid]) continue
          const s = this.surf
          if (s[mid] - s[a] > 1.2 || s[e] - s[mid] > 1.2) continue
          m |= 1 << d
        }
        this.nbr[n] = m
      }
  }

  idx(x: number, y: number): number {
    let i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    if (i < 0) i = 0; else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0; else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }
  groundAt(x: number, y: number) { return this.ground[this.idx(x, y)] }
  surfAt(x: number, y: number) { return this.surf[this.idx(x, y)] }
  solidAt(x: number, y: number) { return this.solid[this.idx(x, y)] }
  isBlocked(x: number, y: number) { return this.blocked[this.idx(x, y)] === 1 }

  node(x: number, y: number): number {
    let I = Math.round((x - this.minX) / 2), J = Math.round((y - this.minY) / 2)
    if (I < 0) I = 0; else if (I >= this.NX) I = this.NX - 1
    if (J < 0) J = 0; else if (J >= this.NY) J = this.NY - 1
    return J * this.NX + I
  }
  nodeX(n: number) { return this.minX + 2 * (n % this.NX) }
  nodeY(n: number) { return this.minY + 2 * Math.floor(n / this.NX) }

  /** nearest walkable node within r meters (spiral), or -1 */
  nearestOk(x: number, y: number, r = 12): number {
    const n0 = this.node(x, y)
    if (this.nodeOk[n0]) return n0
    const I0 = n0 % this.NX, J0 = Math.floor(n0 / this.NX)
    const R = Math.ceil(r / 2)
    let best = -1, bd = Infinity
    for (let dj = -R; dj <= R; dj++)
      for (let di = -R; di <= R; di++) {
        const I = I0 + di, J = J0 + dj
        if (I < 0 || J < 0 || I >= this.NX || J >= this.NY) continue
        const n = J * this.NX + I
        if (!this.nodeOk[n]) continue
        const d = (this.nodeX(n) - x) ** 2 + (this.nodeY(n) - y) ** 2
        if (d < bd) { bd = d; best = n }
      }
    return best
  }

  /** line of sight between two 3D points: shots/vision through solid columns */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy)
    const steps = Math.ceil(L / 0.9)
    for (let k = 1; k < steps; k++) {
      const f = k / steps
      const x = ax + dx * f, y = ay + dy * f, z = az + dz * f
      if (this.solid[this.idx(x, y)] > z) return false
    }
    return true
  }

  /** walkable straight line on the 1 m clearance mask */
  clearLine(ax: number, ay: number, bx: number, by: number): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const steps = Math.ceil(L / 0.8)
    let prev = this.surfAt(ax, ay)
    for (let k = 1; k <= steps; k++) {
      const f = k / steps
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f
      const c = this.idx(x, y)
      if (this.blocked[c]) return false
      if (this.surf[c] - prev > 1.2) return false
      prev = this.surf[c]
    }
    return true
  }
}

export const DX = [1, 1, 0, -1, -1, -1, 0, 1]
export const DY = [0, 1, 1, 1, 0, -1, -1, -1]
export const DC = [1, 1.4142, 1, 1.4142, 1, 1.4142, 1, 1.4142]

function pip(r: number[], x: number, y: number): boolean {
  let inside = false
  const n = r.length / 2
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const xa = r[2 * a], ya = r[2 * a + 1], xb = r[2 * b], yb = r[2 * b + 1]
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside
  }
  return inside
}

/** Binary min-heap over (key, node) in typed arrays. */
class Heap {
  k: Float64Array
  v: Int32Array
  n = 0
  constructor(cap: number) { this.k = new Float64Array(cap); this.v = new Int32Array(cap) }
  push(key: number, val: number) {
    if (this.n >= this.k.length) {
      const k2 = new Float64Array(this.k.length * 2); k2.set(this.k); this.k = k2
      const v2 = new Int32Array(this.v.length * 2); v2.set(this.v); this.v = v2
    }
    let i = this.n++
    const k = this.k, v = this.v
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]; v[i] = v[p]; i = p
    }
    k[i] = key; v[i] = val
  }
  popKey = 0
  pop(): number {
    const k = this.k, v = this.v
    const top = v[0]
    this.popKey = k[0]
    const lk = k[--this.n], lv = v[this.n]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= this.n) break
      if (c + 1 < this.n && k[c + 1] < k[c]) c++
      if (k[c] >= lk) break
      k[i] = k[c]; v[i] = v[c]; i = c
    }
    k[i] = lk; v[i] = lv
    return top
  }
}

/** Dijkstra field. Incremental (time-sliced) for the global goal, bounded for local searches. */
export class Field {
  dist: Float64Array
  heap: Heap
  done = false
  stamp: Int32Array
  gen = 0
  touchedList: number[] = []
  constructor(public m: GameMap, public reverse: boolean) {
    const N = m.NX * m.NY
    this.dist = new Float64Array(N).fill(Infinity)
    this.stamp = new Int32Array(N)
    this.heap = new Heap(4096)
  }
  d(n: number): number { return this.stamp[n] === this.gen ? this.dist[n] : Infinity }
  start(sources: number[], maxD = Infinity) {
    this.gen++
    this.heap.n = 0
    this.done = false
    this.maxD = maxD
    this.touchedList.length = 0
    for (const s of sources) if (s >= 0) { this.stamp[s] = this.gen; this.dist[s] = 0; this.heap.push(0, s); this.touchedList.push(s) }
  }
  maxD = Infinity
  /** run until done or `budgetMs` passes. reverse=true: distances TO the sources (edges followed backwards). */
  run(budgetMs: number): boolean {
    const m = this.m, NX = m.NX, nbr = m.nbr, h = this.heap
    const t0 = performance.now()
    let cnt = 0
    while (h.n > 0) {
      const u = h.pop()
      const du = h.popKey
      if (du > this.d(u)) continue
      if (du > this.maxD) { h.n = 0; break }
      const I = u % NX, J = (u - I) / NX
      for (let dd = 0; dd < 8; dd++) {
        const I2 = I + DX[dd], J2 = J + DY[dd]
        if (I2 < 0 || J2 < 0 || I2 >= NX || J2 >= m.NY) continue
        const v = J2 * NX + I2
        // forward: edge u->v must exist; reverse: edge v->u must exist
        if (this.reverse) { if (!(nbr[v] & (1 << ((dd + 4) & 7)))) continue }
        else if (!(nbr[u] & (1 << dd))) continue
        const nd = du + DC[dd] * 2
        if (nd < this.d(v) - 1e-6) {
          if (this.stamp[v] !== this.gen) { this.stamp[v] = this.gen; this.touchedList.push(v) }
          this.dist[v] = nd; h.push(nd, v)
        }
      }
      if ((++cnt & 1023) === 0 && performance.now() - t0 > budgetMs) return false
    }
    this.done = true
    return true
  }
}
