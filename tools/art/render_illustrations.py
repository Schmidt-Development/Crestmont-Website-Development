#!/usr/bin/env python3
"""Original dimensional illustrations for the Crestmont site (docs/frontend/MOTION.md, M02/M05/M06/M10).

A small signed-distance-field ray marcher (numpy only). Every object is built from primitives here — no third-party
artwork, no logo reinterpretation. Materials: polished gold (sampled from the crest artwork's gold), glossy black
lacquer and a pale "pearl" ceramic. Output: transparent WebP with a soft contact shadow.

Usage:  python3 tools/art/render_illustrations.py [--out public/assets/art] [--only name,...] [--scale 1.0]
"""
import argparse, math, os, sys, time
import numpy as np
from PIL import Image

# ───────────────────────── vector helpers ─────────────────────────
def norm(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)

def rot(ax, ay, az):
    """Rotation matrix from Euler angles in degrees (applied X, then Y, then Z)."""
    ax, ay, az = map(math.radians, (ax, ay, az))
    rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    return rz @ ry @ rx

class Prim:
    def __init__(self, fn, mat, pos=(0, 0, 0), r=(0, 0, 0)):
        self.fn, self.mat = fn, mat
        self.c = np.array(pos, float)
        self.Rt = rot(*r).T  # world -> local
    def d(self, p):
        return self.fn((p - self.c) @ self.Rt.T)

# ───────────────────────── SDF primitives (local space) ─────────────────────────
def round_box(b, r):
    b = np.array(b, float)
    def f(p):
        q = np.abs(p) - b + r
        return np.linalg.norm(np.maximum(q, 0), axis=-1) + np.minimum(np.max(q, axis=-1), 0) - r
    return f

def torus(R, r):  # ring in the XZ plane
    def f(p):
        q = np.stack([np.hypot(p[..., 0], p[..., 2]) - R, p[..., 1]], -1)
        return np.linalg.norm(q, axis=-1) - r
    return f

def arc_torus(R, r, a0, a1):  # partial ring in XZ plane between angles (degrees)
    a0, a1 = math.radians(a0), math.radians(a1)
    e0 = np.array([R * math.cos(a0), 0, R * math.sin(a0)]); e1 = np.array([R * math.cos(a1), 0, R * math.sin(a1)])
    def f(p):
        ang = np.arctan2(p[..., 2], p[..., 0]) % (2 * math.pi)
        lo, hi = a0 % (2 * math.pi), a1 % (2 * math.pi)
        inside = (ang >= lo) & (ang <= hi) if lo <= hi else (ang >= lo) | (ang <= hi)
        q = np.stack([np.hypot(p[..., 0], p[..., 2]) - R, p[..., 1]], -1)
        dt = np.linalg.norm(q, axis=-1) - r
        de = np.minimum(np.linalg.norm(p - e0, axis=-1), np.linalg.norm(p - e1, axis=-1)) - r
        return np.where(inside, dt, de)
    return f

def capsule(a, b, r):
    a, b = np.array(a, float), np.array(b, float)
    ba = b - a; bb = ba @ ba
    def f(p):
        pa = p - a
        h = np.clip((pa @ ba) / bb, 0, 1)[..., None]
        return np.linalg.norm(pa - h * ba, axis=-1) - r
    return f

def round_cyl(rad, half_h, rr):  # cylinder along Y with rounded edges
    def f(p):
        d = np.stack([np.hypot(p[..., 0], p[..., 2]) - rad + rr, np.abs(p[..., 1]) - half_h + rr], -1)
        return np.minimum(np.max(d, -1), 0) + np.linalg.norm(np.maximum(d, 0), axis=-1) - rr
    return f

def sphere(r):
    return lambda p: np.linalg.norm(p, axis=-1) - r

def at(fn, o):
    """Place a primitive at a local offset inside a parent frame (so it rotates with the parent)."""
    o = np.array(o, float)
    return lambda p: fn(p - o)

def sd_polygon(v):
    v = np.array(v, float)
    def f(px, py):
        P = np.stack([px, py], -1)
        d = np.sum((P - v[0]) ** 2, -1); s = np.ones(px.shape)
        n = len(v); j = n - 1
        for i in range(n):
            e = v[j] - v[i]; w = P - v[i]
            b = w - e * np.clip((w @ e) / (e @ e), 0, 1)[..., None]
            d = np.minimum(d, np.sum(b * b, -1))
            c1 = py >= v[i][1]; c2 = py < v[j][1]; c3 = e[0] * w[..., 1] > e[1] * w[..., 0]
            flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
            s = np.where(flip, -s, s); j = i
        return s * np.sqrt(d)
    return f

def extrude(poly, half_h, rr):  # polygon in XY plane, extruded along Z
    f2 = sd_polygon(poly)
    def f(p):
        d2 = f2(p[..., 0], p[..., 1]) + rr
        w = np.stack([d2, np.abs(p[..., 2]) - half_h + rr], -1)
        return np.minimum(np.max(w, -1), 0) + np.linalg.norm(np.maximum(w, 0), axis=-1) - rr
    return f

# ───────────────────────── materials & lighting ─────────────────────────
GOLD, BLACK, PEARL, GLASS = 1, 2, 3, 4
GOLD_TINT = np.array([1.0, 0.73, 0.34])
KEY = norm(np.array([-0.55, 0.85, 0.45]))   # upper-left-front key light

def env(d):
    """Studio environment: large soft box above-left, warm bounce, dark floor."""
    y = d[..., 1]
    sky = 0.35 + 0.65 * np.clip(y, 0, 1)
    box = np.clip((d @ KEY - 0.70) / 0.30, 0, 1) ** 2 * 5.0
    rim = np.clip((d @ norm(np.array([0.8, 0.3, -0.5])) - 0.80) / 0.20, 0, 1) ** 2 * 1.6
    floor = np.where(y < 0, 0.06 + 0.10 * np.clip(1 + y, 0, 1), 0.0)
    base = np.where(y >= 0, sky, floor)
    col = (base + box + rim)[..., None] * np.array([1.0, 0.985, 0.96])
    return col

def tonemap(x):  # ACES fit
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    return np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)

# ───────────────────────── scene evaluation ─────────────────────────
def scene_eval(prims, p):
    d = np.full(p.shape[:-1], 1e9); m = np.zeros(p.shape[:-1], np.int8)
    for pr in prims:
        di = pr.d(p)
        closer = di < d
        d = np.where(closer, di, d); m = np.where(closer, pr.mat, m)
    return d, m

def sdf_only(prims, p):
    d = np.full(p.shape[:-1], 1e9)
    for pr in prims:
        d = np.minimum(d, pr.d(p))
    return d

def normals(prims, p, e=1e-3):
    ex = np.array([e, 0, 0]); ey = np.array([0, e, 0]); ez = np.array([0, 0, e])
    n = np.stack([sdf_only(prims, p + ex) - sdf_only(prims, p - ex),
                  sdf_only(prims, p + ey) - sdf_only(prims, p - ey),
                  sdf_only(prims, p + ez) - sdf_only(prims, p - ez)], -1)
    return norm(n)

def soft_shadow(prims, p, ldir, k=10.0, steps=40):
    res = np.ones(p.shape[:-1]); t = np.full(p.shape[:-1], 0.02)
    for _ in range(steps):
        h = sdf_only(prims, p + ldir * t[..., None])
        res = np.minimum(res, np.clip(k * h / t, 0, 1))
        t = t + np.clip(h, 0.01, 0.25)
        if np.all((res < 0.02) | (t > 6)): break
    return np.clip(res, 0, 1)

def ambient_occ(prims, p, n):
    occ = np.zeros(p.shape[:-1]); sca = 1.0
    for i in range(5):
        h = 0.02 + 0.09 * i
        d = sdf_only(prims, p + n * h)
        occ += (h - d) * sca; sca *= 0.75
    return np.clip(1 - 2.2 * occ, 0, 1)

def render(prims, size=720, ss=1.5, cam_az=38, cam_el=24, dist=6.2, fov=26, target=(0, 0, 0), ground=-1.0, shadow_strength=0.30):
    W = H = int(size * ss)
    tgt = np.array(target, float)
    az, el = math.radians(cam_az), math.radians(cam_el)
    ro = tgt + dist * np.array([math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el)])
    fw = norm(tgt - ro); rt = norm(np.cross(fw, [0, 1, 0])); up = np.cross(rt, fw)
    f = 1 / math.tan(math.radians(fov) / 2)
    ys, xs = np.mgrid[0:H, 0:W]
    u = (2 * (xs + 0.5) / W - 1); v = -(2 * (ys + 0.5) / H - 1)
    rd = norm(u[..., None] * rt + v[..., None] * up + f * fw).reshape(-1, 3)
    N = rd.shape[0]
    t = np.zeros(N); hit = np.zeros(N, bool); alive = np.ones(N, bool); mat = np.zeros(N, np.int8)
    for _ in range(140):
        idx = np.nonzero(alive)[0]
        if idx.size == 0: break
        p = ro + rd[idx] * t[idx, None]
        d, m = scene_eval(prims, p)
        h = d < 1e-3 * (1 + t[idx])
        hit[idx[h]] = True; mat[idx[h]] = m[h]; alive[idx[h]] = False
        t[idx] += d * 0.9
        far = t[idx] > dist + 6
        alive[idx[far]] = False
    col = np.zeros((N, 3)); alpha = np.zeros(N)
    hi = np.nonzero(hit)[0]
    if hi.size:
        p = ro + rd[hi] * t[hi, None]
        n = normals(prims, p)
        v = -rd[hi]
        r = norm(rd[hi] - 2 * np.sum(rd[hi] * n, -1, keepdims=True) * n)
        ndl = np.clip(np.sum(n * KEY, -1), 0, 1)
        sh = soft_shadow(prims, p + n * 2e-3, KEY)
        ao = ambient_occ(prims, p, n)
        fres = (1 - np.clip(np.sum(n * v, -1), 0, 1)) ** 5
        hvec = norm(KEY + v); spec = np.clip(np.sum(n * hvec, -1), 0, 1)
        envr = env(r) * (0.35 + 0.65 * sh[..., None])
        m = mat[hi]
        c = np.zeros((hi.size, 3))
        # gold: metallic, tinted reflections, sharp key highlight
        g = m == GOLD
        if g.any():
            F = GOLD_TINT + (1 - GOLD_TINT) * fres[g, None]
            c[g] = F * envr[g] * (0.55 + 0.45 * ao[g, None]) + (spec[g] ** 120 * sh[g] * 3.0)[:, None] * np.array([1, .93, .8])
        # black lacquer: tiny diffuse, clear-coat reflections
        b = m == BLACK
        if b.any():
            F = 0.04 + 0.96 * fres[b]
            c[b] = (np.array([0.018, 0.017, 0.016]) * (0.3 + ndl[b] * sh[b])[:, None] * ao[b, None]
                    + envr[b] * (F * 0.9)[:, None] * ao[b, None]
                    + (spec[b] ** 160 * sh[b] * 2.2)[:, None])
        # pearl ceramic: soft diffuse, subtle sheen
        pe = m == PEARL
        if pe.any():
            amb = 0.42 + 0.30 * np.clip(n[pe, 1], 0, 1)
            dif = np.array([0.93, 0.92, 0.90]) * ((amb + 0.75 * ndl[pe] * sh[pe]) * ao[pe])[:, None]
            F = 0.04 + 0.96 * fres[pe]
            c[pe] = dif + envr[pe] * (F * 0.35)[:, None] + (spec[pe] ** 60 * sh[pe] * 0.35)[:, None]
        gl = m == GLASS
        if gl.any():
            F = 0.06 + 0.94 * fres[gl]
            c[gl] = envr[gl] * (0.25 + 0.75 * F)[:, None] * 0.55 + np.array([0.80, 0.80, 0.78]) * 0.38
        col[hi] = c; alpha[hi] = 1.0
    # ground shadow catcher (transparent background, soft contact shadow only)
    miss = np.nonzero(~hit)[0]
    if miss.size and shadow_strength > 0:
        rdm = rd[miss]
        tg = np.where(rdm[:, 1] < -1e-4, (ground - ro[1]) / rdm[:, 1], -1)
        ok = tg > 0
        if ok.any():
            mi = miss[ok]; pg = ro + rd[mi] * tg[ok, None]
            shg = soft_shadow(prims, pg + np.array([0, 1e-3, 0]), norm(np.array([0.0, 1.0, 0.15])), k=3.0, steps=36)
            dist_fall = np.clip(1 - np.linalg.norm(pg[:, [0, 2]] - tgt[[0, 2]], axis=-1) / 3.2, 0, 1)
            # fade the shadow out well before the image border so it never ends in a hard edge
            px = (mi % W + 0.5) / W; py = (mi // W + 0.5) / H
            edge = np.clip(np.minimum(np.minimum(px, 1 - px), np.minimum(py, 1 - py)) / 0.16, 0, 1)
            edge = edge * edge * (3 - 2 * edge)
            a = (1 - shg) * shadow_strength * dist_fall * edge
            col[mi] = 0.0; alpha[mi] = np.maximum(alpha[mi], a)
    rgb = tonemap(col * 1.05) ** (1 / 2.2)
    img = np.concatenate([rgb, alpha[:, None]], -1).reshape(H, W, 4)
    im = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "RGBA")
    return im.resize((size, size), Image.LANCZOS) if ss != 1 else im

# ───────────────────────── scenes ─────────────────────────
def cursor_poly(s=1.0):
    pts = [(0, 0), (0, -1.0), (0.26, -0.76), (0.44, -1.12), (0.58, -1.05), (0.40, -0.70), (0.74, -0.70)]
    return [(x * s, y * s) for x, y in pts]

def scenes():
    S = {}
    # Hero: a website being assembled — black lacquer screen, gold and pearl layout blocks, floating gold cursor.
    S["hero-build"] = dict(prims=[
        Prim(round_box((1.25, 0.10, 0.88), 0.09), BLACK, (0, -0.35, 0)),
        Prim(round_box((1.02, 0.045, 0.10), 0.04), GOLD, (0, -0.19, -0.62)),
        Prim(round_box((0.55, 0.07, 0.36), 0.05), PEARL, (-0.42, -0.16, 0.0)),
        Prim(round_box((0.36, 0.13, 0.36), 0.06), GOLD, (0.62, -0.10, -0.02)),
        Prim(round_box((0.36, 0.05, 0.14), 0.04), PEARL, (-0.60, -0.19, 0.58)),
        Prim(round_box((0.36, 0.05, 0.14), 0.04), PEARL, (0.00, -0.19, 0.58)),
        Prim(round_box((0.30, 0.05, 0.14), 0.04), BLACK, (0.66, -0.20, 0.58)),
        Prim(extrude(cursor_poly(0.85), 0.09, 0.035), GOLD, (0.95, 1.30, 0.55), (-55, 12, 20)),
    ], cam_el=30, cam_az=34, target=(0.08, 0.25, 0), ground=-0.47, fov=32, size=960)
    # Process 1 · Scope: magnifier — gold ring, black lacquer handle, faint glass.
    S["stage-scope"] = dict(prims=[
        Prim(torus(0.62, 0.15), GOLD, (-0.18, 0.28, 0), (90, 0, -18)),
        Prim(round_cyl(0.50, 0.012, 0.012), GLASS, (-0.18, 0.28, 0), (90, 0, -18)),
        Prim(capsule((0, 0, 0), (0, -0.95, 0), 0.15), BLACK, (0.04, -0.33, 0), (0, 0, 22)),
        Prim(round_cyl(0.19, 0.08, 0.04), GOLD, (0.06, -0.38, 0), (0, 0, 22)),
    ], cam_el=12, cam_az=28, ground=-1.25, fov=25)
    # Process 2 · Design: fanned design boards — gold front board with black layout marks, two pearl boards.
    S["stage-design"] = dict(prims=[
        Prim(round_box((0.62, 0.82, 0.05), 0.06), PEARL, (-0.45, 0.02, -0.40), (0, 26, -8)),
        Prim(round_box((0.62, 0.82, 0.05), 0.06), PEARL, (-0.12, 0.0, -0.10), (0, 12, -3)),
        Prim(round_box((0.62, 0.82, 0.06), 0.06), GOLD, (0.25, -0.04, 0.22), (0, -4, 4)),
        Prim(round_box((0.40, 0.07, 0.03), 0.03), BLACK, (0.25 + 0.0, 0.48, 0.30), (0, -4, 4)),
        Prim(round_box((0.40, 0.20, 0.03), 0.03), BLACK, (0.24, 0.05, 0.30), (0, -4, 4)),
        Prim(round_box((0.18, 0.06, 0.03), 0.03), BLACK, (0.04, -0.38, 0.29), (0, -4, 4)),
        Prim(round_box((0.18, 0.06, 0.03), 0.03), BLACK, (0.46, -0.36, 0.31), (0, -4, 4)),
    ], cam_el=14, cam_az=24, ground=-1.0, fov=26)
    # Process 3 · Build: code window — black lacquer window, gold title dots and an embossed gold </> glyph.
    win = (0, 0, 0)
    glyph = []
    zf = 0.20
    for a, b in [((-0.30, 0.20), (-0.58, -0.02)), ((-0.58, -0.02), (-0.30, -0.24)),
                 ((0.30, 0.20), (0.58, -0.02)), ((0.58, -0.02), (0.30, -0.24)),
                 ((0.10, 0.28), (-0.10, -0.32))]:
        glyph.append(Prim(capsule((a[0], a[1] - 0.05, zf), (b[0], b[1] - 0.05, zf), 0.065), GOLD, win, (0, -20, 0)))
    S["stage-build"] = dict(prims=[
        Prim(round_box((1.05, 0.78, 0.16), 0.12), BLACK, win, (0, -20, 0)),
        Prim(at(sphere(0.06), (-0.80, 0.55, 0.15)), GOLD, win, (0, -20, 0)),
        Prim(at(sphere(0.06), (-0.62, 0.55, 0.15)), PEARL, win, (0, -20, 0)),
        Prim(at(sphere(0.06), (-0.44, 0.55, 0.15)), PEARL, win, (0, -20, 0)),
        Prim(at(round_box((0.96, 0.012, 0.02), 0.01), (0, 0.40, 0.16)), PEARL, win, (0, -20, 0)),
        *glyph,
    ], cam_el=12, cam_az=18, ground=-0.95, fov=26)
    # Process 4 · Launch: gold cursor pressing a black lacquer button.
    S["stage-launch"] = dict(prims=[
        Prim(round_cyl(0.82, 0.16, 0.10), BLACK, (0, -0.62, 0)),
        Prim(round_cyl(0.60, 0.07, 0.05), GOLD, (0, -0.42, 0)),
        Prim(extrude(cursor_poly(1.35), 0.11, 0.045), GOLD, (-0.10, 0.88, 0.05), (-22, 20, 20)),
    ], cam_el=22, cam_az=30, ground=-0.78, fov=26)
    # Services (smaller, pearl-led with gold accents)
    S["svc-design-dev"] = dict(prims=[
        Prim(round_box((0.95, 0.08, 0.70), 0.07), PEARL, (0, -0.42, 0)),
        Prim(round_box((0.80, 0.08, 0.58), 0.07), PEARL, (0.08, -0.18, -0.05)),
        Prim(round_box((0.62, 0.10, 0.42), 0.07), GOLD, (0.16, 0.08, -0.10)),
    ], cam_el=30, cam_az=36, ground=-0.51, fov=26, size=360)
    S["svc-redesign"] = dict(prims=[
        Prim(round_box((0.62, 0.06, 0.62), 0.07), PEARL, (0, -0.32, 0)),
        Prim(round_box((0.40, 0.10, 0.40), 0.07), BLACK, (0, -0.18, 0)),
        Prim(arc_torus(0.92, 0.07, 200, 520), GOLD, (0, -0.30, 0), (0, 0, 0)),
    ], cam_el=30, cam_az=36, ground=-0.40, fov=26, size=360)
    S["svc-ecommerce"] = dict(prims=[
        Prim(round_box((0.62, 0.55, 0.36), 0.10), PEARL, (0, -0.25, 0)),
        Prim(arc_torus(0.30, 0.055, 180, 360), GOLD, (0, 0.30, 0), (90, 0, 0)),
        Prim(round_box((0.20, 0.03, 0.02), 0.02), BLACK, (0, 0.10, 0.37)),
    ], cam_el=18, cam_az=32, ground=-0.82, fov=26, size=360)
    S["svc-apps"] = dict(prims=[
        Prim(round_box((0.30, 0.30, 0.30), 0.09), PEARL, (-0.36, -0.30, -0.36)),
        Prim(round_box((0.30, 0.30, 0.30), 0.09), PEARL, (0.36, -0.30, -0.36)),
        Prim(round_box((0.30, 0.30, 0.30), 0.09), PEARL, (-0.36, -0.30, 0.36)),
        Prim(round_box((0.30, 0.42, 0.30), 0.09), GOLD, (0.36, -0.18, 0.36)),
    ], cam_el=28, cam_az=36, ground=-0.61, fov=26, size=360)
    S["svc-seo"] = dict(prims=[
        Prim(round_box((0.18, 0.22, 0.18), 0.07), PEARL, (-0.55, -0.40, 0)),
        Prim(round_box((0.18, 0.40, 0.18), 0.07), PEARL, (0.0, -0.22, 0)),
        Prim(round_box((0.18, 0.62, 0.18), 0.07), GOLD, (0.55, 0.00, 0)),
        Prim(round_box((0.95, 0.04, 0.34), 0.04), BLACK, (0, -0.64, 0)),
    ], cam_el=18, cam_az=30, ground=-0.69, fov=26, size=360)
    S["svc-automation"] = dict(prims=[
        Prim(torus(0.42, 0.11), PEARL, (-0.28, 0, 0), (90, 0, 0)),
        Prim(torus(0.42, 0.11), GOLD, (0.28, 0, 0), (0, 0, 0)),
    ], cam_el=20, cam_az=30, ground=-0.62, fov=26, size=360)
    return S

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "../../public/assets/art"))
    ap.add_argument("--only", default="")
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--ss", type=float, default=1.5)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    S = scenes(); names = [n for n in S if not a.only or n in a.only.split(",")]
    for name in names:
        cfg = dict(S[name]); prims = cfg.pop("prims"); size = int(cfg.pop("size", 720) * a.scale)
        t0 = time.time()
        im = render(prims, size=size, ss=a.ss, **cfg)
        path = os.path.join(a.out, f"{name}.webp")
        im.save(path, "WEBP", quality=88, method=6)
        print(f"{name}: {size}px in {time.time() - t0:.1f}s → {os.path.getsize(path) // 1024} KB", flush=True)

if __name__ == "__main__":
    main()
