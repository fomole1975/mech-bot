// mechfight/1 bot: survive and kill the hunting squad one by one.
import { run, log, draw } from "./mechfight.ts"
import { GameMap, Field, DX, DY } from "./map.ts"

type V3 = number[]
const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const hyp = Math.hypot

const UPGRADE_ORDER = [
  "armor", "plating", "laser_damage", "gun_damage", "nanites", "lightning_efficiency", "gun_rate",
  "laser_charge", "lightning_range", "gun_mag", "mortar_reload", "gun_velocity", "servos",
  "lightning_chain", "mortar_splash", "mortar_velocity", "capacitor", "reactor", "jets", "gyros", "sensors", "laser_pierce",
]
const WVAL: Record<string, number> = { laser: 3, lightning: 3, mortar: 1.2, gun: 0 }

type Enemy = { id: number; pos: V3; vel: V3; hp: number; maxHp: number; cubes: number; weapons: string[]; seen: number; aim: V3; charging: boolean }
type Thing = { id: number; pos: V3; kind?: string; hp?: number; seen: number }

class Bot {
  name = "steelwarden"
  cfg: any
  map: GameMap | null = null
  local: Field | null = null
  global: Field | null = null
  gGoal = -1
  gGoalXY = [0, 0]
  rng: () => number
  enemies = new Map<number, Enemy>()
  crates = new Map<number, Thing>()
  pickups = new Map<number, Thing>()
  lastDmgT = -99
  lastDmgBearing = 0
  lastDmgBy: number | null = null
  lastDmgWeapon = ""
  dmgTaken: number[] = [] // [t, amount] pairs flattened
  jinkSign = 1
  jinkUntil = 0
  retreating = false
  coverNode = -1
  coverT = -99
  stuckT = 0
  lastPos = [0, 0]
  stuckEscapeUntil = 0
  stuckDir = [1, 0]
  laserHeld = 0
  wanderGoal: number[] | null = null
  wanderT = -99
  soundLookUntil = 0
  soundBearing = 0
  noLosSince = -1
  prevTarget: number | null = null
  tacNode = -1
  tacT = -99
  failedTake = new Map<number, number>()
  banned = new Map<number, number>() // goal id -> banned until t
  goalId = -1
  goalSince = 0
  goalBestD = Infinity
  goalBestT = 0
  t = 0
  me: any
  tick = 0

  constructor(hello: any) {
    this.cfg = hello.config
    let s = (hello.seed >>> 0) || 12345
    this.rng = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
    try {
      const t0 = performance.now()
      this.map = new GameMap(hello.map.dir)
      this.local = new Field(this.map, false)
      this.global = new Field(this.map, true)
      log(`map ready in ${(performance.now() - t0).toFixed(0)} ms`)
    } catch (e) {
      log("map load failed", e)
      this.map = null
    }
  }

  // ---------------------------------------------------------------- helpers
  zoneNow(z: any, t: number) {
    if (t < z.shrink_start) return { c: z.center, r: z.radius }
    if (t >= z.shrink_end) return { c: z.next_center, r: z.next_radius }
    const f = (t - z.shrink_start) / Math.max(1e-6, z.shrink_end - z.shrink_start)
    return {
      c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f],
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }

  /** the circle we plan inside: current one, or the next one when its shrink is near */
  safeCircle(z: any, t: number) {
    const now = this.zoneNow(z, t)
    const lead = 30
    if (t + lead >= z.shrink_start) return { c: z.next_center, r: z.next_radius, now }
    return { c: now.c, r: now.r, now }
  }

  inSafe(x: number, y: number, sc: any, margin: number) {
    return hyp(x - sc.c[0], y - sc.c[1]) < Math.max(sc.r - margin, sc.r * 0.5)
  }

  los(a: V3, b: V3) { return this.map ? this.map.los(a[0], a[1], a[2], b[0], b[1], b[2]) : true }

  /** desired [yaw, pitch] from p to q */
  aimAt(p: V3, q: V3): number[] {
    return [Math.atan2(q[1] - p[1], q[0] - p[0]), Math.atan2(q[2] - p[2], hyp(q[0] - p[0], q[1] - p[1]))]
  }

  aimErr(actual: number[], want: number[]) {
    const ca = Math.cos(actual[1]), cw = Math.cos(want[1])
    const a = [ca * Math.cos(actual[0]), ca * Math.sin(actual[0]), Math.sin(actual[1])]
    const b = [cw * Math.cos(want[0]), cw * Math.sin(want[0]), Math.sin(want[1])]
    return Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1))
  }

  /** predicted intercept point for a straight projectile */
  lead(src: V3, p: V3, v: V3, speed: number, airborne: boolean): V3 {
    let q = p
    for (let k = 0; k < 4; k++) {
      const tt = hyp(q[0] - src[0], q[1] - src[1], q[2] - src[2]) / speed + 0.05
      q = [p[0] + v[0] * tt, p[1] + v[1] * tt, p[2] + (airborne ? v[2] * tt - 11 * tt * tt : 0)]
      if (airborne && this.map) {
        const g = this.map.surfAt(q[0], q[1])
        if (q[2] < g + 2) q[2] = g + 2
      }
    }
    return q
  }

  /** mortar: [yaw, pitch, flightTime] to hit point q from tube at src, or null */
  mortarSolve(src: V3, q: V3, high: boolean): number[] | null {
    const w = this.me.weapons.find((w: any) => w && w.kind === "mortar")
    const v = w?.stats?.speed ?? 72, g = w?.stats?.gravity ?? 22
    const R = hyp(q[0] - src[0], q[1] - src[1]) - 2.5
    const H = q[2] - src[2]
    if (R < 5) return null
    const disc = v ** 4 - g * (g * R * R + 2 * H * v * v)
    if (disc < 0) return null
    const th = Math.atan((v * v + (high ? 1 : -1) * Math.sqrt(disc)) / (g * R))
    const mc = this.cfg.mech
    if (th > (mc.max_pitch ?? 1.3) || th < (mc.min_pitch ?? -0.7)) return null
    return [Math.atan2(q[1] - src[1], q[0] - src[0]), th, R / (v * Math.cos(th))]
  }

  /** check a lobbed shell path (coarse) clears geometry */
  arcClear(src: V3, yaw: number, pitch: number, T: number, q: V3): boolean {
    if (!this.map) return true
    const w = this.me.weapons.find((w: any) => w && w.kind === "mortar")
    const v = w?.stats?.speed ?? 72, g = w?.stats?.gravity ?? 22
    const vx = v * Math.cos(pitch) * Math.cos(yaw), vy = v * Math.cos(pitch) * Math.sin(yaw), vz = v * Math.sin(pitch)
    const n = Math.max(4, Math.ceil(T / 0.05))
    for (let k = 1; k < n - 1; k++) {
      const tt = (T * k) / n
      const x = src[0] + vx * tt, y = src[1] + vy * tt, z = src[2] + vz * tt - 0.5 * g * tt * tt
      if (hyp(x - q[0], y - q[1]) < 5) break
      if (this.map.solidAt(x, y) > z) return false
    }
    return true
  }

  // ---------------------------------------------------------------- navigation
  /** direction (unit) to walk toward (tx,ty), using local Dijkstra / global field */
  navDir(tx: number, ty: number, me: V3, forceGlobal = false): number[] {
    const dx = tx - me[0], dy = ty - me[1]
    const dd = hyp(dx, dy)
    if (dd < 0.5) return [0, 0]
    const direct = [dx / dd, dy / dd]
    const m = this.map, L = this.local
    if (!m || !L) return direct
    if (dd < 6 && m.clearLine(me[0], me[1], tx, ty)) return direct
    let tn = m.nearestOk(tx, ty, 10)
    if (tn < 0) return direct
    let path: number[] | null = null
    if (L.d(tn) < Infinity) path = this.backtrack(tn)
    else {
      // target outside the local field: use global field if it is for this goal, else best frontier node
      const G = this.global!
      const useG = this.gGoal >= 0 && G.done && (forceGlobal || hyp(this.gGoalXY[0] - tx, this.gGoalXY[1] - ty) < 30)
      let best = -1, bs = Infinity
      for (const n of L.touchedList) {
        const ld = L.d(n)
        if (ld === Infinity) continue
        const rest = useG ? G.d(n) : hyp(m.nodeX(n) - tx, m.nodeY(n) - ty) * 1.15
        if (rest === Infinity) continue
        const s = ld + rest
        if (s < bs) { bs = s; best = n }
      }
      if (best >= 0) path = this.backtrack(best)
    }
    if (!path || path.length === 0) return direct
    // lookahead: furthest path node with a clear straight walk
    let look = path[Math.min(path.length - 1, 1)]
    for (let k = Math.min(path.length - 1, 8); k >= 1; k--) {
      const n = path[k]
      if (m.clearLine(me[0], me[1], m.nodeX(n), m.nodeY(n))) { look = n; break }
    }
    if (path.length === 1) look = path[0]
    const lx = m.nodeX(look) - me[0], ly = m.nodeY(look) - me[1]
    const ll = hyp(lx, ly)
    if (ll < 0.3) return direct
    return [lx / ll, ly / ll]
  }

  backtrack(target: number): number[] {
    const m = this.map!, L = this.local!
    const out: number[] = [target]
    let v = target
    for (let guard = 0; guard < 400; guard++) {
      const dv = L.d(v)
      if (dv <= 0) break
      const I = v % m.NX, J = (v - I) / m.NX
      let best = -1, bd = dv
      for (let d = 0; d < 8; d++) {
        const I2 = I - DX[d], J2 = J - DY[d]
        if (I2 < 0 || J2 < 0 || I2 >= m.NX || J2 >= m.NY) continue
        const u = J2 * m.NX + I2
        if (!(m.nbr[u] & (1 << d))) continue
        const du = L.d(u)
        if (du < bd) { bd = du; best = u }
      }
      if (best < 0) break
      v = best
      out.push(v)
    }
    out.reverse()
    // out[0] = start; drop it
    return out.slice(1).length ? out.slice(1) : out
  }

  /** choose a walkable direction close to `want` */
  pickDir(want: number[], me: V3, sc: any): number[] {
    const wl = hyp(want[0], want[1])
    if (wl < 1e-3) return [0, 0]
    const m = this.map
    if (!m) return [want[0] / wl, want[1] / wl]
    const wa = Math.atan2(want[1], want[0])
    const meSafe = this.inSafe(me[0], me[1], sc, 5)
    let best = [want[0] / wl, want[1] / wl], bs = -Infinity
    for (let k = 0; k < 16; k++) {
      const off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8)
      const a = wa + off
      const dx = Math.cos(a), dy = Math.sin(a)
      let s = Math.cos(off)
      const px = me[0] + dx * 5, py = me[1] + dy * 5
      if (!m.clearLine(me[0], me[1], px, py)) s -= 3
      else if (!m.clearLine(px, py, me[0] + dx * 9, me[1] + dy * 9)) s -= 0.6
      if (meSafe && !this.inSafe(me[0] + dx * 9, me[1] + dy * 9, sc, 3)) s -= 1.2
      if (s > bs) { bs = s; best = [dx, dy] }
    }
    return best
  }

  // ---------------------------------------------------------------- main
  act(obs: any): any {
    const t0 = performance.now()
    this.t = obs.t
    this.tick = obs.tick
    const me = obs.self
    this.me = me
    const P: V3 = me.pos
    const scale = 1 + (this.cfg.cubes?.size_per_cube ?? 0.05) * (me.cubes ?? 0)
    const muzzle: V3 = [P[0], P[1], P[2] + (me.stats?.muzzle_height ?? 7 * scale)]
    const eye: V3 = [P[0], P[1], P[2] + (me.stats?.eye_height ?? 8 * scale)]
    const tube: V3 = [P[0], P[1], P[2] + 9 * scale + 0.5]
    const act: any = { tick: obs.tick }
    const hpFrac = me.hp / me.max_hp
    const t = obs.t

    // ---- offers
    if (obs.offer) {
      let bi = 0, br = 999
      obs.offer.choices.forEach((c: any, i: number) => {
        const r = UPGRADE_ORDER.indexOf(c.id)
        const rr = r < 0 ? 50 : r
        if (rr < br) { br = rr; bi = i }
      })
      act.pick = bi
    }

    // ---- events
    for (const e of obs.events ?? []) {
      if (e.type === "damaged") {
        this.dmgTaken.push(t, e.amount)
        if (e.by !== null && e.by !== undefined) {
          this.lastDmgT = t; this.lastDmgBearing = e.bearing ?? 0; this.lastDmgBy = e.by; this.lastDmgWeapon = e.weapon
        }
      } else if (e.type === "take_failed") this.failedTake.set(e.id, t)
      else if (e.type === "took") this.pickups.delete(e.id)
    }
    while (this.dmgTaken.length && this.dmgTaken[0] < t - 3) this.dmgTaken.splice(0, 2)
    let recentDmg = 0
    for (let k = 1; k < this.dmgTaken.length; k += 2) recentDmg += this.dmgTaken[k]

    // ---- world memory
    const seenIds = new Set<number>()
    const npcs: any[] = []
    for (const a of obs.mechs ?? []) {
      if (a.kind === "npc") { npcs.push(a); continue }
      if (a.id === me.id) continue
      seenIds.add(a.id)
      this.enemies.set(a.id, {
        id: a.id, pos: a.pos, vel: a.vel ?? [0, 0, 0], hp: a.hp ?? 1400, maxHp: a.max_hp ?? 1400, cubes: a.cubes ?? 0,
        weapons: a.weapons ?? [], seen: t, aim: a.aim ?? [0, 0], charging: !!a.charging,
      })
    }
    for (const [id, e] of this.enemies) {
      if (!seenIds.has(id)) {
        if (t - e.seen > 12) this.enemies.delete(id)
      }
    }
    const visCrates = new Set<number>()
    for (const c of obs.crates ?? []) { visCrates.add(c.id); this.crates.set(c.id, { id: c.id, pos: c.pos, hp: c.hp, seen: t }) }
    const visPick = new Set<number>()
    for (const p of obs.pickups ?? []) { visPick.add(p.id); this.pickups.set(p.id, { id: p.id, pos: p.pos, kind: p.kind, seen: t }) }
    // forget things that should be visible (near) but are not listed
    const nearR = this.cfg.vision?.near_range ?? 45
    for (const [id, c] of this.crates) {
      const d = hyp(c.pos[0] - P[0], c.pos[1] - P[1])
      if (!visCrates.has(id) && ((d < nearR * 0.8 && this.los(eye, [c.pos[0], c.pos[1], c.pos[2] + 1.2])) || t - c.seen > 90)) this.crates.delete(id)
    }
    for (const [id, c] of this.pickups) {
      const d = hyp(c.pos[0] - P[0], c.pos[1] - P[1])
      if (!visPick.has(id) && ((d < nearR * 0.8 && this.los(eye, [c.pos[0], c.pos[1], c.pos[2] + 0.5])) || t - c.seen > 120)) this.pickups.delete(id)
    }

    // ---- sounds: remember interesting bearings
    for (const s of obs.sounds ?? []) {
      if (["gun", "laser", "laser_charge", "lightning", "step", "boost", "jet", "mortar", "reload"].includes(s.kind) && s.dist !== "far") {
        if (t > this.soundLookUntil - 0.8) { this.soundBearing = s.bearing; this.soundLookUntil = t + 1.5 }
      }
    }

    // ---- navigation fields
    const m = this.map
    if (m && this.local) {
      let sn = m.nearestOk(P[0], P[1], 8)
      this.local.start(sn >= 0 ? [sn] : [], 110)
      this.local.run(12)
    }
    const z = obs.zone
    const sc = this.safeCircle(z, t)
    const zn = sc.now
    const dCenter = hyp(P[0] - sc.c[0], P[1] - sc.c[1])
    const zoneMargin = Math.min(25, sc.r * 0.25)
    // strategic goal: inside the safe circle
    let gx = sc.c[0], gy = sc.c[1]
    if (dCenter > 1e-3) {
      const keep = Math.max(0, Math.min(sc.r * 0.45, dCenter))
      gx = sc.c[0] + ((P[0] - sc.c[0]) / dCenter) * keep
      gy = sc.c[1] + ((P[1] - sc.c[1]) / dCenter) * keep
    }
    if (m && this.global) {
      if (this.gGoal < 0 || hyp(this.gGoalXY[0] - sc.c[0], this.gGoalXY[1] - sc.c[1]) > 15) {
        const gn = m.nearestOk(sc.c[0], sc.c[1], 40)
        if (gn >= 0) {
          this.gGoal = gn
          this.gGoalXY = [sc.c[0], sc.c[1]]
          this.global.start([gn])
        }
      }
      if (!this.global.done && this.gGoal >= 0) this.global.run(Math.max(2, 9 - (performance.now() - t0)))
    }
    const outsideSafe = !this.inSafe(P[0], P[1], sc, zoneMargin)
    const outsideNow = hyp(P[0] - zn.c[0], P[1] - zn.c[1]) > zn.r - 3
    const timeToShrink = z.shrink_start - t

    // ---- weapons state
    const W = me.weapons as any[]
    const slotOf = (k: string) => W.findIndex((w) => w && w.kind === k)
    const gunI = slotOf("gun"), laserI = slotOf("laser"), lightI = slotOf("lightning"), mortarI = slotOf("mortar")
    const gun = gunI >= 0 ? W[gunI] : null
    const fire = [false, false]

    // ---- pick a combat target
    let target: Enemy | null = this.prevTarget !== null ? this.enemies.get(this.prevTarget) ?? null : null
    if (target && t - target.seen > 6) target = null
    const prevT = target
    let tScore = Infinity
    target = null
    let threats: Enemy[] = []
    for (const e of this.enemies.values()) {
      const d = hyp(e.pos[0] - P[0], e.pos[1] - P[1])
      const age = t - e.seen
      if (age > 6) continue
      if (d < 260) threats.push(e)
      const c: V3 = [e.pos[0], e.pos[1], e.pos[2] + 4.5]
      const vis = this.los(muzzle, c)
      const aimingMe = Math.abs(wrap(Math.atan2(P[1] - e.pos[1], P[0] - e.pos[0]) - e.aim[0])) < 0.2
      let s = d / 40 + e.hp / 350 + age * 0.8 + (vis ? 0 : 3) + (this.lastDmgBy === e.id && t - this.lastDmgT < 3 ? -1.5 : 0) + (aimingMe ? -0.8 : 0)
      if (prevT && e.id === prevT.id) s -= 0.6
      if (d > 300) s += 10
      if (s < tScore) { tScore = s; target = e }
    }

    this.prevTarget = target ? target.id : null
    // ---- retreat state
    const nThreat = threats.filter((e) => t - e.seen < 3).length
    const thr = clamp(0.28 + 0.08 * (nThreat - 1), 0.28, 0.5)
    if (!this.retreating && hpFrac < thr && nThreat > 0) this.retreating = true
    if (this.retreating && (hpFrac > thr + 0.35 || (nThreat === 0 && t - this.lastDmgT > 8))) this.retreating = false

    // ---- movement & aim decision
    let want: number[] = [0, 0]
    let aim: number[] | null = null
    let boost = false
    let label = ""
    let aimTarget: { p: V3; v: V3; r: number; kind: string; air: boolean } | null = null

    if (target) {
      const e = target
      const es = 1 + 0.05 * e.cubes
      const center: V3 = [e.pos[0], e.pos[1], e.pos[2] + 4.5 * es]
      const d = hyp(e.pos[0] - P[0], e.pos[1] - P[1])
      const air = Math.abs(e.vel[2]) > 1.5
      aimTarget = { p: center, v: e.vel, r: 2.5 * es, kind: "mech", air }
      const vis = this.los(muzzle, center) || this.los(muzzle, [e.pos[0], e.pos[1], e.pos[2] + 8 * es])
      if (vis) this.noLosSince = -1
      else if (this.noLosSince < 0) this.noLosSince = t
      // preferred range
      let R = 85
      if (laserI >= 0) R = 110
      if (mortarI >= 0) R = 100
      if (lightI >= 0) R = 28
      if (lightI < 0 && e.weapons.includes("lightning")) R = Math.max(R, 70)
      if (lightI >= 0 && e.weapons.includes("mortar")) R = 22
      const toE = [(e.pos[0] - P[0]) / Math.max(d, 1e-3), (e.pos[1] - P[1]) / Math.max(d, 1e-3)]
      if (t > this.jinkUntil) {
        this.jinkSign = this.rng() < 0.5 ? -1 : 1
        this.jinkUntil = t + 0.35 + this.rng() * 0.7
      }
      const tang = [-toE[1] * this.jinkSign, toE[0] * this.jinkSign]
      if (this.retreating) {
        label = "retreat"
        // find cover
        if (t - this.coverT > 0.6 || this.coverNode < 0) { this.coverNode = this.findCover(threats, P); this.coverT = t }
        if (this.coverNode >= 0 && m) {
          const cx = m.nodeX(this.coverNode), cy = m.nodeY(this.coverNode)
          if (hyp(cx - P[0], cy - P[1]) > 2.5) want = this.navDir(cx, cy, P)
          else want = [tang[0] * 0.3, tang[1] * 0.3]
          boost = me.energy > 15
        } else {
          want = [-toE[0] * 0.8 + tang[0] * 0.6, -toE[1] * 0.8 + tang[1] * 0.6]
          boost = me.energy > 25
        }
      } else if (!vis && this.noLosSince >= 0 && t - this.noLosSince > 1.2 && d < 220) {
        label = "seek"
        want = this.navDir(e.pos[0], e.pos[1], P)
        boost = me.energy > 60 && d > 60
      } else {
        label = "fight"
        const radial = clamp((d - R) / 25, -1, 1)
        want = [toE[0] * radial + tang[0] * 0.9, toE[1] * radial + tang[1] * 0.9]
        if (radial > 0.6 && d > 60) want = this.blendNav(want, e.pos, P, 0.5)
        const active = threats.filter((x) => t - x.seen < 3)
        if (active.length >= 2 && m) {
          if (t - this.tacT > 0.5) { this.tacNode = this.tactical(active, e, R, P); this.tacT = t }
          if (this.tacNode >= 0) {
            const tx = m.nodeX(this.tacNode), ty = m.nodeY(this.tacNode)
            if (hyp(tx - P[0], ty - P[1]) > 3) {
              const nd = this.navDir(tx, ty, P)
              want = [nd[0] + tang[0] * 0.35, nd[1] + tang[1] * 0.35]
              label = "reposition"
            }
          }
        }
        boost = me.energy > (lightI >= 0 ? 55 : 40)
      }
    } else {
      // ---- peace: zone, drops, loot, NPCs, wander
      const underFire = t - this.lastDmgT < 3 && this.lastDmgWeapon !== "zone" && this.lastDmgWeapon !== "npc"
      const lootOk = (!outsideSafe || timeToShrink > 20) && !underFire
      let goal: number[] | null = null
      if (underFire && !outsideNow) {
        label = "evade"
        const b = this.lastDmgBearing
        const guessD = this.lastDmgWeapon === "lightning" ? 35 : this.lastDmgWeapon === "mortar" ? 150 : 110
        const fake: Enemy = { id: -1, pos: [P[0] + Math.cos(b) * guessD, P[1] + Math.sin(b) * guessD, P[2]], vel: [0, 0, 0], hp: 1400, maxHp: 1400, cubes: 0, weapons: [], seen: t, aim: [0, 0], charging: false }
        if (t - this.coverT > 0.6) { this.coverNode = this.findCover([fake], P); this.coverT = t }
        if (t > this.jinkUntil) { this.jinkSign = this.rng() < 0.5 ? -1 : 1; this.jinkUntil = t + 0.35 + this.rng() * 0.6 }
        const tang = [-Math.sin(b) * this.jinkSign, Math.cos(b) * this.jinkSign]
        if (this.coverNode >= 0 && m && hyp(m.nodeX(this.coverNode) - P[0], m.nodeY(this.coverNode) - P[1]) > 2.5) {
          const nd = this.navDir(m.nodeX(this.coverNode), m.nodeY(this.coverNode), P)
          want = [nd[0] + tang[0] * 0.3, nd[1] + tang[1] * 0.3]
        } else want = tang
        boost = me.energy > 30
      }
      const hurtHide = !underFire && hpFrac < 0.55 && t - this.lastDmgT < 25 && !outsideSafe
      if (label !== "evade" && outsideSafe && (outsideNow || timeToShrink < 25 + dCenter / 10)) {
        goal = [gx, gy]; label = "zone"
        boost = outsideNow && me.energy > 20
      }
      // supply drop
      if (!goal && obs.drops && !underFire) {
        for (const dr of obs.drops) {
          const dd = hyp(dr.pos[0] - P[0], dr.pos[1] - P[1])
          if (dd > 260 || !this.inSafe(dr.pos[0], dr.pos[1], sc, 0)) continue
          if (dr.holder !== null && dr.holder !== undefined && dr.holder !== me.id) continue
          if (dr.lands_in > dd / 11 + 8) continue
          goal = [dr.pos[0], dr.pos[1]]; label = "drop"
          if (dd > 40) boost = me.energy > 50
          break
        }
      }
      // weapon pickups
      const slot1 = W.find((w, i) => w && i !== gunI) as any
      const curVal = W.reduce((b, w) => Math.max(b, w && w.kind !== "gun" ? WVAL[w.kind] ?? 0 : 0), 0)
      let bestPick: Thing | null = null
      if (!goal && lootOk) {
        let bd = 140
        for (const p of this.pickups.values()) {
          if ((this.failedTake.get(p.id) ?? -99) > t - 5) continue
          if ((this.banned.get(p.id) ?? -1) > t) continue
          const k = p.kind ?? ""
          if (W.some((w) => w && w.kind === k)) continue
          if ((WVAL[k] ?? 0) <= curVal + 0.1 && W.filter((w) => w).length >= 2) continue
          if (p.pos[2] > P[2] + 3.5 && !this.map) continue
          const dd = hyp(p.pos[0] - P[0], p.pos[1] - P[1])
          if (m && p.pos[2] > m.groundAt(p.pos[0], p.pos[1]) + 3) continue // roof
          if (!this.inSafe(p.pos[0], p.pos[1], sc, 0)) continue
          if (dd < bd) { bd = dd; bestPick = p }
        }
        if (bestPick) { goal = [bestPick.pos[0], bestPick.pos[1]]; label = "loot " + bestPick.kind; this.trackGoal(bestPick.id, bd) }
      }
      // cubes
      if (!goal && lootOk) {
        let bd = 90
        for (const c of obs.cubes ?? []) {
          const dd = hyp(c.pos[0] - P[0], c.pos[1] - P[1])
          if (m && c.pos[2] > m.groundAt(c.pos[0], c.pos[1]) + 3) continue
          if ((this.banned.get(c.id) ?? -1) > t) continue
          if (dd < bd && this.inSafe(c.pos[0], c.pos[1], sc, 0)) { bd = dd; goal = [c.pos[0], c.pos[1]]; label = "cube"; this.goalCand = c.id }
        }
        if (label === "cube") this.trackGoal(this.goalCand, bd)
      }
      // shoot crates / NPCs
      let shootT: any = null
      if (lootOk) {
        let bd = 160
        for (const c of this.crates.values()) {
          if (t - c.seen > 0.5) continue
          const dd = hyp(c.pos[0] - P[0], c.pos[1] - P[1])
          const cc: V3 = [c.pos[0], c.pos[1], c.pos[2] + 1.2]
          if (dd < bd && this.los(muzzle, cc)) { bd = dd; shootT = { p: cc, v: [0, 0, 0], r: 1.3, kind: "crate", air: false } }
        }
        if (!shootT && hpFrac > 0.6) {
          let bn = 170
          for (const n of npcs) {
            const dd = hyp(n.pos[0] - P[0], n.pos[1] - P[1])
            const cc: V3 = [n.pos[0], n.pos[1], n.pos[2] + 1.75]
            if (dd < bn && this.los(muzzle, cc)) { bn = dd; shootT = { p: cc, v: n.vel ?? [0, 0, 0], r: 1.7, kind: "npc", air: false, d: dd } }
          }
        }
        // a crate we were shooting but went out of view: go near it
        if (!goal && !shootT) {
          let bd2 = 140
          for (const c of this.crates.values()) {
            const dd = hyp(c.pos[0] - P[0], c.pos[1] - P[1])
            if (m && c.pos[2] > m.groundAt(c.pos[0], c.pos[1]) + 3) continue
            if ((this.banned.get(c.id) ?? -1) > t) continue
            if (dd < bd2 && this.inSafe(c.pos[0], c.pos[1], sc, 0)) { bd2 = dd; goal = [c.pos[0], c.pos[1]]; label = "to crate"; this.goalCand = c.id }
          }
          if (label === "to crate") this.trackGoal(this.goalCand, bd2)
        }
      }
      if (shootT) {
        aimTarget = shootT
        if (!label) label = "shoot " + shootT.kind
        if (shootT.kind === "npc") {
          const dd = shootT.d
          const toN = [(shootT.p[0] - P[0]) / dd, (shootT.p[1] - P[1]) / dd]
          if (t > this.jinkUntil) { this.jinkSign = this.rng() < 0.5 ? -1 : 1; this.jinkUntil = t + 0.4 + this.rng() * 0.6 }
          const radial = clamp((dd - 75) / 25, -1, 1)
          if (!goal) want = [toN[0] * radial - toN[1] * this.jinkSign * 0.8, toN[1] * radial + toN[0] * this.jinkSign * 0.8]
        }
      }
      if (!goal && !shootT) {
        // wander inside the safe circle to find loot; later, hold position
        if (!this.wanderGoal || t > this.wanderT || hyp(this.wanderGoal[0] - P[0], this.wanderGoal[1] - P[1]) < 8 ||
            !this.inSafe(this.wanderGoal[0], this.wanderGoal[1], sc, zoneMargin)) {
          for (let tries = 0; tries < 12; tries++) {
            const a = this.rng() * TAU, rr = Math.sqrt(this.rng()) * sc.r * 0.55
            let wg = [sc.c[0] + Math.cos(a) * rr, sc.c[1] + Math.sin(a) * rr]
            const wd = hyp(wg[0] - P[0], wg[1] - P[1])
            if (wd > 140) { const k = 120 / wd; wg = [P[0] + (wg[0] - P[0]) * k, P[1] + (wg[1] - P[1]) * k] }
            this.wanderGoal = wg
            if (!m || !this.global || !this.global.done) break
            const n = m.nearestOk(wg[0], wg[1], 6)
            if (n >= 0 && this.global.d(n) < Infinity) break
          }
          this.wanderT = t + 20
        }
        if (label === "evade") { /* keep evading */ }
        else if (hurtHide) label = "heal"
        else if (t < 200 || outsideSafe) { goal = this.wanderGoal; label = label || "wander" }
        else label = label || "hold"
      }
      if (goal) {
        const gd = hyp(goal[0] - P[0], goal[1] - P[1])
        want = gd > 1.5 ? this.navDir(goal[0], goal[1], P) : [0, 0]
        if (label === "zone") want = this.navDir(goal[0], goal[1], P, true)
      }
      // take pickups in reach
      if (bestPick || true) {
        const reach = this.cfg.loot?.pickup_radius ?? 4
        for (const p of obs.pickups ?? []) {
          if (hyp(p.pos[0] - P[0], p.pos[1] - P[1]) > reach - 0.3 || Math.abs(p.pos[2] - P[2]) > 3.8) continue
          if (W.some((w) => w && w.kind === p.kind)) continue
          const v = WVAL[p.kind] ?? 0
          const empty = W.findIndex((w) => !w)
          if (empty >= 0 && v > 0) { act.take = p.id; break }
          // swap the weakest non-gun weapon
          let wi = -1, wv = 99
          W.forEach((w, i) => { if (w && w.kind !== "gun" && (WVAL[w.kind] ?? 0) < wv) { wv = WVAL[w.kind] ?? 0; wi = i } })
          if (wi >= 0 && v > wv + 0.1 && !(W[wi].kind === "laser" && (W[wi].charge ?? 0) > 0)) { act.take = p.id; act.drop = wi; break }
        }
      }
      void slot1
    }

    if (target && !this.retreating) {
      let bc: any = null, bd = 22
      for (const c of obs.cubes ?? []) { const dd = hyp(c.pos[0] - P[0], c.pos[1] - P[1]); if (dd < bd && Math.abs(c.pos[2] - P[2]) < 3) { bd = dd; bc = c } }
      if (bc) { const nd = this.navDir(bc.pos[0], bc.pos[1], P); want = [want[0] * 0.5 + nd[0], want[1] * 0.5 + nd[1]] }
    }
    // ---- also grab pickups / cubes in reach during combat (cheap)
    if (target && act.take === undefined) {
      const reach = this.cfg.loot?.pickup_radius ?? 4
      for (const p of obs.pickups ?? []) {
        if (hyp(p.pos[0] - P[0], p.pos[1] - P[1]) > reach - 0.3 || Math.abs(p.pos[2] - P[2]) > 3.8) continue
        if (W.some((w) => w && w.kind === p.kind)) continue
        const empty = W.findIndex((w) => !w)
        if (empty >= 0 && (WVAL[p.kind] ?? 0) > 0) { act.take = p.id; break }
      }
    }

    // ---- climb out of pockets the walking graph cannot leave
    let climbing = false
    if (m && this.global && this.global.done && !target) {
      const sn = m.nearestOk(P[0], P[1], 8)
      if (sn < 0 || this.global.d(sn) === Infinity) {
        if (t - this.exitT > 1 || this.exitNode < 0) { this.exitNode = this.findExit(P); this.exitT = t }
        if (this.exitNode >= 0) {
          const ex = m.nodeX(this.exitNode) - P[0], ey = m.nodeY(this.exitNode) - P[1], el = hyp(ex, ey) || 1
          want = [ex / el, ey / el]
          climbing = true
          label = "climb " + label
        }
      }
    }

    // ---- dodge projectiles & shells
    const dodge = this.dodge(obs, P, scale)
    if (dodge) {
      want = [want[0] * 0.4 + dodge[0] * 1.5, want[1] * 0.4 + dodge[1] * 1.5]
      if (dodge[2] > 0.5 && me.energy > 10) boost = true
    }

    // ---- zone override in combat: never fight outside
    if (target && outsideNow) {
      const zd = this.navDir(gx, gy, P, true)
      want = [want[0] * 0.3 + zd[0], want[1] * 0.3 + zd[1]]
      boost = me.energy > 10
    }

    // ---- stuck handling
    let jump = false
    const moved = hyp(P[0] - this.lastPos[0], P[1] - this.lastPos[1])
    this.lastPos = [P[0], P[1]]
    if (hyp(want[0], want[1]) > 0.3 && moved < 0.25 && me.grounded && this.laserHeld === 0) this.stuckT += 0.1
    else this.stuckT = Math.max(0, this.stuckT - 0.05)
    if (this.stuckT > 0.8) {
      this.stuckT = 0
      jump = true
      const a = this.rng() * TAU
      this.stuckDir = [Math.cos(a), Math.sin(a)]
      this.stuckEscapeUntil = t + 0.7
    }
    let move = climbing ? want : this.pickDir(want, P, sc)
    // jump / jet over what is ahead when climbing or airborne
    if (m && hyp(move[0], move[1]) > 0.3) {
      let ahead = -Infinity
      for (const k of [1.5, 2.5, 3.5, 4.5]) ahead = Math.max(ahead, m.surfAt(P[0] + move[0] * k, P[1] + move[1] * k))
      const over = ahead - P[2]
      if (climbing || t < this.stuckEscapeUntil) {
        if (over > 1.0 && me.grounded) jump = true
        if (!me.grounded && over > -0.5 && me.energy > 3) boost = true
      }
    }
    if (t < this.stuckEscapeUntil) { move = [move[0] * 0.3 + this.stuckDir[0], move[1] * 0.3 + this.stuckDir[1]]; boost = me.energy > 20 }
    // off the nav grid (roof / tight spot): walk straight, jet if needed
    if (m && m.nearestOk(P[0], P[1], 6) < 0 && hyp(want[0], want[1]) > 0.2) {
      move = want
      if (me.grounded && this.rng() < 0.1) jump = true
    }

    // ---- aim & fire
    if (aimTarget) {
      const at = aimTarget
      const dist = hyp(at.p[0] - muzzle[0], at.p[1] - muzzle[1], at.p[2] - muzzle[2])
      const visT = this.los(muzzle, at.p)
      const gunSpeed = gun?.stats?.speed ?? 252
      const gunRange = gun?.stats?.range ?? 230
      const leadP = this.lead(muzzle, at.p, at.v, gunSpeed, at.air)
      let wantAim = this.aimAt(muzzle, leadP)
      let mode = "gun"
      // laser: release when charged & aligned on hitscan point
      const laser = laserI >= 0 ? W[laserI] : null
      const lsr = laser?.stats ?? {}
      const hitscanP: V3 = [at.p[0] + at.v[0] * 0.07, at.p[1] + at.v[1] * 0.07, at.p[2]]
      const charged = laser && (laser.charge ?? 0) >= (lsr.charge ?? 0.75) - 0.051
      if (laser && charged) { wantAim = this.aimAt(muzzle, hitscanP); mode = "laser" }
      // mortar: swap aim when ready and worthwhile
      const mortar = mortarI >= 0 ? W[mortarI] : null
      let mortarSol: number[] | null = null
      if (mortar && mortar.cooldown <= 0.05 && mode === "gun" && dist > 18 && dist < 230 && at.kind !== "crate") {
        let q: V3 = [at.p[0], at.p[1], at.p[2] - (at.kind === "mech" ? 4.3 : 1.5)]
        let sol: number[] | null = null
        const preferHigh = !visT
        for (let it = 0; it < 3; it++) {
          sol = this.mortarSolve(tube, q, preferHigh)
          if (!sol) break
          const T = sol[2]
          q = [at.p[0] + at.v[0] * T, at.p[1] + at.v[1] * T, at.p[2] - (at.kind === "mech" ? 4.3 : 1.5)]
          if (m) q[2] = Math.max(q[2], m.surfAt(q[0], q[1]))
        }
        if (sol && (visT || preferHigh) && this.arcClear(tube, sol[0], sol[1], sol[2], q)) {
          const spd = hyp(at.v[0], at.v[1])
          if (spd < 6 || dist < 90 || !visT) { mortarSol = sol; wantAim = [sol[0], sol[1]]; mode = "mortar" }
        }
      }
      aim = wantAim
      const err = this.aimErr(me.aim, wantAim)
      const tol = Math.atan2(at.r * 0.85, dist) + 0.006
      if (mode === "gun" && gun && visT && dist < gunRange && err < tol + 0.01) fire[gunI] = true
      if (mode === "mortar" && mortarSol && err < 0.03) fire[mortarI] = true
      // laser charging / release
      if (laser) {
        const ready = laser.cooldown <= 0.05
        const inRange = dist < (lsr.range ?? 280) - 5
        if ((laser.charge ?? 0) > 0) {
          this.laserHeld += 0.1
          const errL = this.aimErr(me.aim, this.aimAt(muzzle, hitscanP))
          const tolL = Math.atan2(at.r * 0.8, dist) + 0.003
          const release = charged && visT && errL < tolL
          const forced = this.laserHeld > (lsr.charge ?? 0.75) + (lsr.hold_s ?? 2) - 0.25
          fire[laserI] = !(release || forced)
          if (release || forced) this.laserHeld = 0
        } else {
          this.laserHeld = 0
          if (ready && inRange && visT && (at.kind !== "crate" || dist < 200)) fire[laserI] = true
        }
      }
      // lightning
      if (lightI >= 0) {
        const L = W[lightI]
        const ls = L.stats ?? {}
        const yawErr = Math.abs(wrap(Math.atan2(at.p[1] - P[1], at.p[0] - P[0]) - me.aim[0]))
        if (L.cooldown <= 0.05 && dist < (ls.range ?? 45) * 0.93 && yawErr < ((ls.cone_deg ?? 30) * Math.PI / 360) * 0.8 && visT && me.energy > (at.kind === "mech" ? 4 : 30)) fire[lightI] = true
      }
    } else {
      this.laserHeld = 0
      // aim: toward damage source, sounds, or scan
      const pz = 0
      if (t - this.lastDmgT < 2.5) aim = [this.lastDmgBearing, pz]
      else if (t < this.soundLookUntil) aim = [this.soundBearing, pz]
      else {
        // remembered enemy direction, else rotate
        let rem: Enemy | null = null
        for (const e of this.enemies.values()) if (!rem || e.seen > rem.seen) rem = e
        if (rem && t - rem.seen < 12) aim = [Math.atan2(rem.pos[1] - P[1], rem.pos[0] - P[0]), 0]
        else aim = [wrap(me.aim[0] + 0.9), 0]
      }
      if (gun && gun.ammo !== undefined && gun.ammo < (gun.stats?.mag ?? 12) * 0.6 && (gun.reload ?? 0) <= 0) act.reload = true
    }
    // keep the laser held state consistent: if we hold it but have no target, release when charged (avoid waste? it fires anyway)
    if (!aimTarget && laserI >= 0 && (W[laserI].charge ?? 0) > 0) fire[laserI] = true

    act.move = [clamp(move[0], -1, 1), clamp(move[1], -1, 1)]
    const ml = hyp(act.move[0], act.move[1])
    if (ml > 1) act.move = [act.move[0] / ml, act.move[1] / ml]
    act.boost = boost && ml > 0.3
    act.jump = jump
    act.aim = aim ?? me.aim
    act.aim[1] = clamp(act.aim[1], this.cfg.mech?.min_pitch ?? -0.7, this.cfg.mech?.max_pitch ?? 1.3)
    act.fire = fire
    const gd = m && this.global ? this.global.d(m.nearestOk(P[0], P[1], 8)) : -1
    draw.label(`${label} hp${Math.round(me.hp)} ${(performance.now() - t0).toFixed(1)}ms g=${gd.toFixed(0)} gdone=${this.global?.done}`)
    return act
  }

  /** move vector [x,y,urgency] to get out of the way of incoming fire */
  dodge(obs: any, P: V3, scale: number): number[] | null {
    let best: number[] | null = null
    let urg = 0
    const cz = P[2] + 4.5 * scale
    const R = 2.5 * scale + 1.0
    for (const pr of obs.projectiles ?? []) {
      const v = pr.vel
      if (pr.kind === "mortar") {
        const g = this.cfg.weapons?.mortar?.gravity ?? 22
        let x = pr.pos[0], y = pr.pos[1], zz = pr.pos[2], vx = v[0], vy = v[1], vz = v[2]
        let T = 0
        for (; T < 6; T += 0.05) {
          x += vx * 0.05; y += vy * 0.05; vz -= g * 0.05; zz += vz * 0.05
          const s = this.map ? this.map.solidAt(x, y) : -10
          if (zz <= s || (Math.abs(x - P[0]) < R && Math.abs(y - P[1]) < R && zz < P[2] + 9 * scale && zz > P[2])) break
        }
        const dx = P[0] - x, dy = P[1] - y
        const dd = hyp(dx, dy)
        const sr = (this.cfg.weapons?.mortar?.splash_radius ?? 7) + 4
        if (dd < sr && T < 4) {
          const u = 1 + (sr - dd) / sr
          if (u > urg) {
            urg = u
            best = dd > 0.5 ? [dx / dd, dy / dd, 1] : [-vy / hyp(vx, vy), vx / hyp(vx, vy), 1]
          }
        }
        continue
      }
      const rx = P[0] - pr.pos[0], ry = P[1] - pr.pos[1], rz = cz - pr.pos[2]
      const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
      if (vv < 1) continue
      const tc = (rx * v[0] + ry * v[1] + rz * v[2]) / vv
      if (tc < 0 || tc > 0.9) continue
      const mx = rx - v[0] * tc, my = ry - v[1] * tc, mz = rz - v[2] * tc
      const md = hyp(mx, my)
      if (md < R && Math.abs(mz) < 5 * scale) {
        const u = (R - md) / R + (0.9 - tc)
        if (u > urg) {
          urg = u
          const hv = hyp(v[0], v[1]) || 1
          if (md > 0.3) best = [mx / md, my / md, 0]
          else best = [-v[1] / hv, v[0] / hv, 0]
        }
      }
    }
    return best
  }

  goalCand = -1
  exitNode = -1
  exitT = -99
  /** nearest node connected to the global goal */
  findExit(P: V3): number {
    const m = this.map!, G = this.global!
    const n0 = m.node(P[0], P[1])
    const I0 = n0 % m.NX, J0 = Math.floor(n0 / m.NX)
    let best = -1, bd = Infinity
    for (let R = 2; R <= 40; R += 2) {
      for (let dj = -R; dj <= R; dj++)
        for (let di = -R; di <= R; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== R) continue
          const I = I0 + di, J = J0 + dj
          if (I < 0 || J < 0 || I >= m.NX || J >= m.NY) continue
          const n = J * m.NX + I
          if (G.d(n) === Infinity) continue
          const d = hyp(m.nodeX(n) - P[0], m.nodeY(n) - P[1]) + Math.max(0, m.surfAt(m.nodeX(n), m.nodeY(n)) - P[2]) * 2
          if (d < bd) { bd = d; best = n }
        }
      if (best >= 0 && bd < R * 2 - 4) break
    }
    return best
  }
  /** give up on goals that stop getting closer */
  trackGoal(id: number, d: number) {
    const t = this.t
    if (id !== this.goalId) { this.goalId = id; this.goalSince = t; this.goalBestD = d; this.goalBestT = t; return }
    if (d < this.goalBestD - 1) { this.goalBestD = d; this.goalBestT = t }
    if (t - this.goalBestT > 4 || t - this.goalSince > 45) { this.banned.set(id, t + 60); this.goalId = -1 }
  }

  /** blend a fight vector with the path direction toward a point */
  blendNav(want: number[], tgt: V3, P: V3, k: number): number[] {
    const nd = this.navDir(tgt[0], tgt[1], P)
    return [want[0] * (1 - k) + nd[0] * k * 1.2, want[1] * (1 - k) + nd[1] * k * 1.2]
  }

  /** a nearby node where few threats but the target can see us */
  tactical(active: Enemy[], tgt: Enemy, R: number, P: V3): number {
    const m = this.map!, L = this.local!
    let best = -1, bs = Infinity
    const list = L.touchedList
    for (let k = 0; k < list.length; k++) {
      const n = list[k]
      const d = L.d(n)
      if (d > 45) continue
      if ((n & 1) && d > 8) continue
      const x = m.nodeX(n), y = m.nodeY(n), z = m.surfAt(x, y)
      let s = d / 12
      if (s >= bs) continue
      let others = 0, tv = false
      for (const e of active) {
        const v = m.los(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z + 5)
        if (e.id === tgt.id) tv = v
        else if (v) others++
      }
      s += others * 3 + (tv ? 0 : 1.5) + Math.abs(hyp(tgt.pos[0] - x, tgt.pos[1] - y) - R) / 40
      if (s < bs) { bs = s; best = n }
    }
    return best
  }

  /** nearest reachable node hidden from all recent threats */
  findCover(threats: Enemy[], P: V3): number {
    const m = this.map, L = this.local
    if (!m || !L) return -1
    const ts = threats.filter((e) => this.t - e.seen < 4)
    if (!ts.length) return -1
    let best = -1, bs = Infinity
    const list = L.touchedList
    for (let k = 0; k < list.length; k++) {
      const n = list[k]
      const d = L.d(n)
      if (d === Infinity || d > 90) continue
      if ((n & 1) && d > 20) continue // thin out
      const x = m.nodeX(n), y = m.nodeY(n)
      const s0 = d
      if (s0 >= bs) continue
      const z = m.surfAt(x, y)
      let hidden = true
      let near = 0
      for (const e of ts) {
        const ed = hyp(e.pos[0] - x, e.pos[1] - y)
        if (ed < 30) { hidden = false; break }
        if (m.los(e.pos[0], e.pos[1], e.pos[2] + 8, x, y, z + 6)) { hidden = false; break }
        near += Math.max(0, 80 - ed)
      }
      if (!hidden) continue
      const s = s0 + near * 0.3
      if (s < bs) { bs = s; best = n }
    }
    return best
  }
}

run((hello) => new Bot(hello) as any)
