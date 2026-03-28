// Auto-generated from meshcore-web-keygen/webgpu/ed25519.wgsl
// Inlined as a TypeScript string to avoid requiring ?raw Vite loader configuration.
export const ED25519_WGSL = `
// ============================================================
// Ed25519 vanity key generator — WebGPU compute shader
// Field arithmetic: 16 × u32 limbs (~16 bits each), mod 2^255-19
// Point operations: Extended twisted Edwards coordinates
// ============================================================

struct Config {
    prefix_0: u32,
    prefix_1: u32,
    prefix_nibbles: u32,
    seed_0: u32,
    seed_1: u32,
    seed_2: u32,
    seed_3: u32,
    dispatch_id: u32,
    base_thread_id: u32,
}

struct Match {
    seed: array<u32, 8>,
    pubkey: array<u32, 8>,
}

@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read> base_table: array<u32, 1024>;
@group(0) @binding(2) var<storage, read_write> matches: array<Match, 64>;
struct Counts {
    match_count: atomic<u32>,
    completed_count: atomic<u32>,
};
@group(0) @binding(3) var<storage, read_write> counts: Counts;

fn fe_zero() -> array<u32, 16> {
    return array<u32, 16>(0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
}

fn fe_one() -> array<u32, 16> {
    return array<u32, 16>(1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0);
}

fn fe_add(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
    var o: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) { o[i] = a[i] + b[i]; }
    return fe_carry(o);
}

fn fe_sub(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
    var o: array<u32, 16>;
    o[0] = a[0] + 196551u - b[0];
    for (var i = 1u; i < 15u; i++) { o[i] = a[i] + 196605u - b[i]; }
    o[15] = a[15] + 98301u - b[15];
    return fe_carry(o);
}

fn fe_carry(inp: array<u32, 16>) -> array<u32, 16> {
    var o = inp;
    for (var round = 0u; round < 2u; round++) {
        var c: u32 = 0u;
        for (var i = 0u; i < 16u; i++) {
            var v = o[i] + c;
            c = v >> 16u;
            o[i] = v & 0xFFFFu;
        }
        o[0] += 38u * c;
    }
    var c: u32 = o[0] >> 16u;
    o[0] &= 0xFFFFu;
    for (var i = 1u; i < 16u; i++) {
        var v = o[i] + c;
        c = v >> 16u;
        o[i] = v & 0xFFFFu;
    }
    o[0] += 38u * c;
    return o;
}

fn fe_mul(a: array<u32, 16>, b: array<u32, 16>) -> array<u32, 16> {
    var t: array<u32, 32>;
    for (var i = 0u; i < 32u; i++) { t[i] = 0u; }
    for (var i = 0u; i < 16u; i++) {
        let ai = a[i];
        for (var j = 0u; j < 16u; j++) {
            let prod = ai * b[j];
            t[i + j] += prod & 0xFFFFu;
            t[i + j + 1u] += prod >> 16u;
        }
    }
    var c: u32 = 0u;
    for (var i = 0u; i < 32u; i++) {
        var v = t[i] + c;
        c = v >> 16u;
        t[i] = v & 0xFFFFu;
    }
    for (var i = 0u; i < 16u; i++) {
        t[i] += 38u * t[i + 16u];
    }
    var o: array<u32, 16>;
    c = 0u;
    for (var i = 0u; i < 16u; i++) {
        var v = t[i] + c;
        c = v >> 16u;
        o[i] = v & 0xFFFFu;
    }
    o[0] += 38u * c;
    c = 0u;
    for (var i = 0u; i < 16u; i++) {
        var v = o[i] + c;
        c = v >> 16u;
        o[i] = v & 0xFFFFu;
    }
    o[0] += 38u * c;
    c = o[0] >> 16u;
    o[0] &= 0xFFFFu;
    for (var i = 1u; i < 16u; i++) {
        var v = o[i] + c;
        c = v >> 16u;
        o[i] = v & 0xFFFFu;
    }
    o[0] += 38u * c;
    return o;
}

fn fe_sqr(a: array<u32, 16>) -> array<u32, 16> {
    return fe_mul(a, a);
}

fn fe_inv(a: array<u32, 16>) -> array<u32, 16> {
    var c = a;
    for (var i = 253; i >= 0; i--) {
        c = fe_sqr(c);
        if (i != 2 && i != 4) {
            c = fe_mul(c, a);
        }
    }
    return c;
}

fn fe_pack(n: array<u32, 16>) -> array<u32, 8> {
    var t = n;
    for (var round = 0u; round < 3u; round++) {
        var c: u32 = 0u;
        for (var i = 0u; i < 16u; i++) {
            var v = t[i] + c;
            c = v >> 16u;
            t[i] = v & 0xFFFFu;
        }
        t[0] += 38u * c;
    }
    for (var round = 0u; round < 2u; round++) {
        var m: array<u32, 16>;
        m[0] = t[0] - 0xFFEDu;
        for (var i = 1u; i < 15u; i++) {
            m[i] = t[i] - 0xFFFFu - ((m[i-1u] >> 16u) & 1u);
            m[i-1u] &= 0xFFFFu;
        }
        m[15] = t[15] - 0x7FFFu - ((m[14] >> 16u) & 1u);
        let b = (m[15] >> 16u) & 1u;
        m[14] &= 0xFFFFu;
        for (var i = 0u; i < 16u; i++) {
            let mask = b * 0xFFFFFFFFu;
            t[i] = (t[i] & mask) | (m[i] & ~mask);
        }
    }
    var out: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        out[i] = (t[2u*i] & 0xFFu) | ((t[2u*i] >> 8u) << 8u)
               | ((t[2u*i+1u] & 0xFFu) << 16u) | ((t[2u*i+1u] >> 8u) << 24u);
    }
    return out;
}

fn fe_par(a: array<u32, 16>) -> u32 {
    let packed = fe_pack(a);
    return packed[0] & 1u;
}

const D_LIMBS = array<u32, 16>(
    0x78A3u, 0x1359u, 0x4DCAu, 0x75EBu, 0xD8ABu, 0x4141u, 0x0A4Du, 0x0070u,
    0xE898u, 0x7779u, 0x4079u, 0x8CC7u, 0xFE73u, 0x2B6Fu, 0x6CEEu, 0x5203u
);

const D2_LIMBS = array<u32, 16>(
    0xF159u, 0x26B2u, 0x9B94u, 0xEBD6u, 0xB156u, 0x8283u, 0x149Au, 0x00E0u,
    0xD130u, 0xEEF3u, 0x80F2u, 0x198Eu, 0xFCE7u, 0x56DFu, 0xD9DCu, 0x2406u
);

struct GeP3 {
    x: array<u32, 16>,
    y: array<u32, 16>,
    z: array<u32, 16>,
    t: array<u32, 16>,
}

fn ge_identity() -> GeP3 {
    return GeP3(fe_zero(), fe_one(), fe_one(), fe_zero());
}

fn ge_add(p: GeP3, q: GeP3) -> GeP3 {
    let a = fe_mul(fe_sub(p.y, p.x), fe_sub(q.y, q.x));
    let b = fe_mul(fe_add(p.x, p.y), fe_add(q.x, q.y));
    let c = fe_mul(fe_mul(p.t, q.t), D2_LIMBS);
    let d = fe_add(fe_mul(p.z, q.z), fe_mul(p.z, q.z));
    let e = fe_sub(b, a);
    let f = fe_sub(d, c);
    let g = fe_add(d, c);
    let h = fe_add(b, a);
    return GeP3(fe_mul(e, f), fe_mul(h, g), fe_mul(g, f), fe_mul(e, h));
}

fn ge_double(p: GeP3) -> GeP3 {
    let a = fe_sqr(p.x);
    let b = fe_sqr(p.y);
    var c = fe_sqr(p.z);
    c = fe_add(c, c);
    let d = fe_sub(fe_zero(), a);
    let e = fe_sub(fe_sqr(fe_add(p.x, p.y)), fe_add(a, b));
    let g = fe_add(d, b);
    let f = fe_sub(g, c);
    let h = fe_sub(d, b);
    return GeP3(fe_mul(e, f), fe_mul(g, h), fe_mul(f, g), fe_mul(e, h));
}

fn load_base_point(index: u32) -> GeP3 {
    var p: GeP3;
    let offset = index * 64u;
    for (var i = 0u; i < 16u; i++) {
        p.x[i] = base_table[offset + i];
        p.y[i] = base_table[offset + 16u + i];
        p.z[i] = base_table[offset + 32u + i];
        p.t[i] = base_table[offset + 48u + i];
    }
    return p;
}

fn ge_scalarmult_base(scalar: array<u32, 8>) -> GeP3 {
    var result = ge_identity();
    for (var i = 63; i >= 0; i--) {
        if (i < 63) {
            result = ge_double(result);
            result = ge_double(result);
            result = ge_double(result);
            result = ge_double(result);
        }
        let word_idx = u32(i) / 8u;
        let bit_offset = (u32(i) % 8u) * 4u;
        let nibble = (scalar[word_idx] >> bit_offset) & 0xFu;
        if (nibble != 0u) {
            let pt = load_base_point(nibble);
            result = ge_add(result, pt);
        }
    }
    return result;
}

fn ge_pack(p: GeP3) -> array<u32, 8> {
    let zi = fe_inv(p.z);
    let tx = fe_mul(p.x, zi);
    let ty = fe_mul(p.y, zi);
    var out = fe_pack(ty);
    let x_par = fe_par(tx);
    out[7] ^= (x_par << 31u);
    return out;
}

const SHA512_K = array<u32, 160>(
    0x428a2f98u, 0xd728ae22u, 0x71374491u, 0x23ef65cdu,
    0xb5c0fbcfu, 0xec4d3b2fu, 0xe9b5dba5u, 0x8189dbbcu,
    0x3956c25bu, 0xf348b538u, 0x59f111f1u, 0xb605d019u,
    0x923f82a4u, 0xaf194f9bu, 0xab1c5ed5u, 0xda6d8118u,
    0xd807aa98u, 0xa3030242u, 0x12835b01u, 0x45706fbeu,
    0x243185beu, 0x4ee4b28cu, 0x550c7dc3u, 0xd5ffb4e2u,
    0x72be5d74u, 0xf27b896fu, 0x80deb1feu, 0x3b1696b1u,
    0x9bdc06a7u, 0x25c71235u, 0xc19bf174u, 0xcf692694u,
    0xe49b69c1u, 0x9ef14ad2u, 0xefbe4786u, 0x384f25e3u,
    0x0fc19dc6u, 0x8b8cd5b5u, 0x240ca1ccu, 0x77ac9c65u,
    0x2de92c6fu, 0x592b0275u, 0x4a7484aau, 0x6ea6e483u,
    0x5cb0a9dcu, 0xbd41fbd4u, 0x76f988dau, 0x831153b5u,
    0x983e5152u, 0xee66dfabu, 0xa831c66du, 0x2db43210u,
    0xb00327c8u, 0x98fb213fu, 0xbf597fc7u, 0xbeef0ee4u,
    0xc6e00bf3u, 0x3da88fc2u, 0xd5a79147u, 0x930aa725u,
    0x06ca6351u, 0xe003826fu, 0x14292967u, 0x0a0e6e70u,
    0x27b70a85u, 0x46d22ffcu, 0x2e1b2138u, 0x5c26c926u,
    0x4d2c6dfcu, 0x5ac42aedu, 0x53380d13u, 0x9d95b3dfu,
    0x650a7354u, 0x8baf63deu, 0x766a0abbu, 0x3c77b2a8u,
    0x81c2c92eu, 0x47edaee6u, 0x92722c85u, 0x1482353bu,
    0xa2bfe8a1u, 0x4cf10364u, 0xa81a664bu, 0xbc423001u,
    0xc24b8b70u, 0xd0f89791u, 0xc76c51a3u, 0x0654be30u,
    0xd192e819u, 0xd6ef5218u, 0xd6990624u, 0x5565a910u,
    0xf40e3585u, 0x5771202au, 0x106aa070u, 0x32bbd1b8u,
    0x19a4c116u, 0xb8d2d0c8u, 0x1e376c08u, 0x5141ab53u,
    0x2748774cu, 0xdf8eeb99u, 0x34b0bcb5u, 0xe19b48a8u,
    0x391c0cb3u, 0xc5c95a63u, 0x4ed8aa4au, 0xe3418acbu,
    0x5b9cca4fu, 0x7763e373u, 0x682e6ff3u, 0xd6b2b8a3u,
    0x748f82eeu, 0x5defb2fcu, 0x78a5636fu, 0x43172f60u,
    0x84c87814u, 0xa1f0ab72u, 0x8cc70208u, 0x1a6439ecu,
    0x90befffau, 0x23631e28u, 0xa4506cebu, 0xde82bde9u,
    0xbef9a3f7u, 0xb2c67915u, 0xc67178f2u, 0xe372532bu,
    0xca273eceu, 0xea26619cu, 0xd186b8c7u, 0x21c0c207u,
    0xeada7dd6u, 0xcde0eb1eu, 0xf57d4f7fu, 0xee6ed178u,
    0x06f067aau, 0x72176fbau, 0x0a637dc5u, 0xa2c898a6u,
    0x113f9804u, 0xbef90daeu, 0x1b710b35u, 0x131c471bu,
    0x28db77f5u, 0x23047d84u, 0x32caab7bu, 0x40c72493u,
    0x3c9ebe0au, 0x15c9bebcu, 0x431d67c4u, 0x9c100d4cu,
    0x4cc5d4beu, 0xcb3e42b6u, 0x597f299cu, 0xfc657e2au,
    0x5fcb6fabu, 0x3ad6faecu, 0x6c44198cu, 0x4a475817u
);

fn add64(ah: u32, al: u32, bh: u32, bl: u32) -> vec2<u32> {
    let lo = al + bl;
    let carry = select(0u, 1u, lo < al);
    let hi = ah + bh + carry;
    return vec2<u32>(hi, lo);
}

fn sha512_32bytes(msg: array<u32, 8>) -> array<u32, 16> {
    var wh: array<u32, 80>;
    var wl: array<u32, 80>;
    for (var i = 0u; i < 4u; i++) {
        let w0 = msg[i * 2u];
        let w1 = msg[i * 2u + 1u];
        wh[i] = ((w0 & 0xFFu) << 24u) | (((w0 >> 8u) & 0xFFu) << 16u) |
                (((w0 >> 16u) & 0xFFu) << 8u) | ((w0 >> 24u) & 0xFFu);
        wl[i] = ((w1 & 0xFFu) << 24u) | (((w1 >> 8u) & 0xFFu) << 16u) |
                (((w1 >> 16u) & 0xFFu) << 8u) | ((w1 >> 24u) & 0xFFu);
    }
    wh[4] = 0x80000000u; wl[4] = 0u;
    for (var i = 5u; i < 15u; i++) { wh[i] = 0u; wl[i] = 0u; }
    wh[15] = 0u; wl[15] = 256u;
    for (var i = 16u; i < 80u; i++) {
        let i15h = wh[i - 15u]; let i15l = wl[i - 15u];
        let s0h = ((i15h >> 1u) | (i15l << 31u)) ^ ((i15h >> 8u) | (i15l << 24u)) ^ (i15h >> 7u);
        let s0l = ((i15l >> 1u) | (i15h << 31u)) ^ ((i15l >> 8u) | (i15h << 24u)) ^ ((i15l >> 7u) | (i15h << 25u));
        let i2h = wh[i - 2u]; let i2l = wl[i - 2u];
        let s1h = ((i2h >> 19u) | (i2l << 13u)) ^ ((i2l >> 29u) | (i2h << 3u)) ^ (i2h >> 6u);
        let s1l = ((i2l >> 19u) | (i2h << 13u)) ^ ((i2h >> 29u) | (i2l << 3u)) ^ ((i2l >> 6u) | (i2h << 26u));
        var r = add64(wh[i - 16u], wl[i - 16u], s0h, s0l);
        r = add64(r.x, r.y, wh[i - 7u], wl[i - 7u]);
        r = add64(r.x, r.y, s1h, s1l);
        wh[i] = r.x; wl[i] = r.y;
    }
    var ah0 = 0x6a09e667u; var al0 = 0xf3bcc908u;
    var ah1 = 0xbb67ae85u; var al1 = 0x84caa73bu;
    var ah2 = 0x3c6ef372u; var al2 = 0xfe94f82bu;
    var ah3 = 0xa54ff53au; var al3 = 0x5f1d36f1u;
    var ah4 = 0x510e527fu; var al4 = 0xade682d1u;
    var ah5 = 0x9b05688cu; var al5 = 0x2b3e6c1fu;
    var ah6 = 0x1f83d9abu; var al6 = 0xfb41bd6bu;
    var ah7 = 0x5be0cd19u; var al7 = 0x137e2179u;
    for (var i = 0u; i < 80u; i++) {
        let sig1h = ((ah4 >> 14u) | (al4 << 18u)) ^ ((ah4 >> 18u) | (al4 << 14u)) ^ ((al4 >> 9u) | (ah4 << 23u));
        let sig1l = ((al4 >> 14u) | (ah4 << 18u)) ^ ((al4 >> 18u) | (ah4 << 14u)) ^ ((ah4 >> 9u) | (al4 << 23u));
        let chh = (ah4 & ah5) ^ (~ah4 & ah6);
        let chl = (al4 & al5) ^ (~al4 & al6);
        var t1 = add64(ah7, al7, sig1h, sig1l);
        t1 = add64(t1.x, t1.y, chh, chl);
        t1 = add64(t1.x, t1.y, SHA512_K[i*2u], SHA512_K[i*2u+1u]);
        t1 = add64(t1.x, t1.y, wh[i], wl[i]);
        let sig0h = ((ah0 >> 28u) | (al0 << 4u)) ^ ((al0 >> 2u) | (ah0 << 30u)) ^ ((al0 >> 7u) | (ah0 << 25u));
        let sig0l = ((al0 >> 28u) | (ah0 << 4u)) ^ ((ah0 >> 2u) | (al0 << 30u)) ^ ((ah0 >> 7u) | (al0 << 25u));
        let majh = (ah0 & ah1) ^ (ah0 & ah2) ^ (ah1 & ah2);
        let majl = (al0 & al1) ^ (al0 & al2) ^ (al1 & al2);
        let t2 = add64(sig0h, sig0l, majh, majl);
        ah7 = ah6; al7 = al6;
        ah6 = ah5; al6 = al5;
        ah5 = ah4; al5 = al4;
        let d = add64(ah3, al3, t1.x, t1.y);
        ah4 = d.x; al4 = d.y;
        ah3 = ah2; al3 = al2;
        ah2 = ah1; al2 = al1;
        ah1 = ah0; al1 = al0;
        let sum = add64(t1.x, t1.y, t2.x, t2.y);
        ah0 = sum.x; al0 = sum.y;
    }
    var r = add64(ah0, al0, 0x6a09e667u, 0xf3bcc908u); ah0 = r.x; al0 = r.y;
    r = add64(ah1, al1, 0xbb67ae85u, 0x84caa73bu); ah1 = r.x; al1 = r.y;
    r = add64(ah2, al2, 0x3c6ef372u, 0xfe94f82bu); ah2 = r.x; al2 = r.y;
    r = add64(ah3, al3, 0xa54ff53au, 0x5f1d36f1u); ah3 = r.x; al3 = r.y;
    r = add64(ah4, al4, 0x510e527fu, 0xade682d1u); ah4 = r.x; al4 = r.y;
    r = add64(ah5, al5, 0x9b05688cu, 0x2b3e6c1fu); ah5 = r.x; al5 = r.y;
    r = add64(ah6, al6, 0x1f83d9abu, 0xfb41bd6bu); ah6 = r.x; al6 = r.y;
    r = add64(ah7, al7, 0x5be0cd19u, 0x137e2179u); ah7 = r.x; al7 = r.y;
    return array<u32, 16>(ah0, al0, ah1, al1, ah2, al2, ah3, al3,
                          ah4, al4, ah5, al5, ah6, al6, ah7, al7);
}

fn prng_seed(global_id: u32) -> array<u32, 4> {
    var s: array<u32, 4>;
    s[0] = config.seed_0 ^ (global_id * 2654435761u);
    s[1] = config.seed_1 ^ (global_id * 2246822519u);
    s[2] = config.seed_2 ^ (config.dispatch_id * 3266489917u) ^ (global_id * 2013265921u);
    s[3] = config.seed_3 ^ ((global_id + 1u) * 668265263u);
    if (s[0] == 0u && s[1] == 0u) { s[0] = global_id + 1u; }
    if (s[2] == 0u && s[3] == 0u) { s[2] = global_id + 1u; }
    return s;
}

fn xorshift128plus(state: ptr<function, array<u32, 4>>) -> vec2<u32> {
    var s1h = (*state)[0]; var s1l = (*state)[1];
    let s0h = (*state)[2]; let s0l = (*state)[3];
    (*state)[0] = s0h; (*state)[1] = s0l;
    let sh23h = (s1h << 23u) | (s1l >> 9u);
    let sh23l = s1l << 23u;
    s1h ^= sh23h; s1l ^= sh23l;
    let sh17h = s1h >> 17u;
    let sh17l = (s1l >> 17u) | (s1h << 15u);
    s1h ^= sh17h; s1l ^= sh17l;
    s1h ^= s0h; s1l ^= s0l;
    let sh26h = s0h >> 26u;
    let sh26l = (s0l >> 26u) | (s0h << 6u);
    s1h ^= sh26h; s1l ^= sh26l;
    (*state)[2] = s1h; (*state)[3] = s1l;
    let sumLo = s0l + s1l;
    let carry = select(0u, 1u, sumLo < s0l);
    let sumHi = s0h + s1h + carry;
    return vec2<u32>(sumLo, sumHi);
}

fn generate_seed(state: ptr<function, array<u32, 4>>) -> array<u32, 8> {
    var seed: array<u32, 8>;
    for (var i = 0u; i < 4u; i++) {
        let out64 = xorshift128plus(state);
        seed[i * 2u] = out64.x;
        seed[i * 2u + 1u] = out64.y;
    }
    return seed;
}

fn check_prefix(pubkey: array<u32, 8>) -> bool {
    let nibbles = config.prefix_nibbles;
    if (nibbles == 0u) { return true; }
    let full_bytes = nibbles / 2u;
    let prefix0 = config.prefix_0;
    let prefix1 = config.prefix_1;
    for (var i = 0u; i < full_bytes; i++) {
        let pub_byte = (pubkey[i / 4u] >> ((i % 4u) * 8u)) & 0xFFu;
        var pfx_byte: u32;
        if (i < 4u) { pfx_byte = (prefix0 >> (i * 8u)) & 0xFFu; }
        else { pfx_byte = (prefix1 >> ((i - 4u) * 8u)) & 0xFFu; }
        if (pub_byte != pfx_byte) { return false; }
    }
    if ((nibbles & 1u) != 0u) {
        let i = full_bytes;
        let pub_byte = (pubkey[i / 4u] >> ((i % 4u) * 8u)) & 0xFFu;
        var pfx_byte: u32;
        if (i < 4u) { pfx_byte = (prefix0 >> (i * 8u)) & 0xFFu; }
        else { pfx_byte = (prefix1 >> ((i - 4u) * 8u)) & 0xFFu; }
        if ((pub_byte & 0xF0u) != (pfx_byte & 0xF0u)) { return false; }
    }
    return true;
}

fn is_reserved(pubkey: array<u32, 8>) -> bool {
    let first_byte = pubkey[0] & 0xFFu;
    return first_byte == 0x00u || first_byte == 0xFFu;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let thread_id = config.base_thread_id + gid.x;
    var rng_state = prng_seed(thread_id);
    let seed = generate_seed(&rng_state);
    let hash = sha512_32bytes(seed);
    var scalar: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        let pair_idx = select((i - 4u) / 2u + 2u, i / 2u, i < 4u);
        if ((i & 1u) == 0u) {
            let h = hash[pair_idx * 2u];
            scalar[i] = ((h >> 24u) & 0xFFu) | (((h >> 16u) & 0xFFu) << 8u) |
                       (((h >> 8u) & 0xFFu) << 16u) | ((h & 0xFFu) << 24u);
        } else {
            let l = hash[pair_idx * 2u + 1u];
            scalar[i] = ((l >> 24u) & 0xFFu) | (((l >> 16u) & 0xFFu) << 8u) |
                       (((l >> 8u) & 0xFFu) << 16u) | ((l & 0xFFu) << 24u);
        }
    }
    scalar[0] &= 0xFFFFFFF8u;
    scalar[7] &= 0x3FFFFFFFu;
    scalar[7] |= 0x40000000u;
    let point = ge_scalarmult_base(scalar);
    let pubkey = ge_pack(point);
    if (is_reserved(pubkey)) { return; }
    atomicAdd(&counts.completed_count, 1u);
    if (check_prefix(pubkey)) {
        let slot = atomicAdd(&counts.match_count, 1u);
        if (slot < 64u) {
            matches[slot].seed = seed;
            matches[slot].pubkey = pubkey;
        }
    }
}
`;
