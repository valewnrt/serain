/**
 * Two fragment shaders over a photograph, both WebGL 1 so every browser with
 * WebGL gets them, both in black and white like the rest of Serain. Without WebGL the photograph itself stays (an <img> under
 * the canvas), so nothing depends on this file.
 *
 * Both draw the photograph a little out of focus (`soft`), so the rain and the
 * drops are what stays sharp.
 *
 * - `SKY`: the hero. The dusk sky breathes, thin clouds drift, and a fine rain
 *   falls from the clear sky: the serein the project is named after. Barely
 *   there, on purpose.
 * - `GLASS`: the security section. Drops sit on a window at night, a few run
 *   down, and each bends the light behind it.
 */

export const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const COMMON = `
precision highp float;
uniform sampler2D u_img;
uniform vec2 u_res;
uniform vec2 u_imgSize;
uniform float u_time;
uniform vec2 u_pointer;
uniform float u_scroll;
varying vec2 v_uv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

// Like background-size: cover, anchored at the bottom so the horizon stays in view.
vec2 cover(vec2 uv, float anchorY) {
  float rs = u_res.x / u_res.y;
  float ri = u_imgSize.x / u_imgSize.y;
  vec2 scale = rs > ri ? vec2(1.0, ri / rs) : vec2(rs / ri, 1.0);
  return vec2((uv.x - 0.5) * scale.x + 0.5, (uv.y - anchorY) * scale.y + anchorY);
}

// The photograph a little out of focus: the centre and 12 taps on a golden-angle
// spiral, \`radius\` in parts of the image's height.
vec3 soft(vec2 p, float radius) {
  vec3 sum = texture2D(u_img, clamp(p, 0.001, 0.999)).rgb;
  vec2 unit = vec2(u_imgSize.y / u_imgSize.x, 1.0) * radius;
  float angle = 0.0;
  for (int i = 1; i <= 12; i++) {
    angle += 2.39996;
    vec2 o = vec2(cos(angle), sin(angle)) * sqrt(float(i) / 12.0) * unit;
    sum += texture2D(u_img, clamp(p + o, 0.001, 0.999)).rgb;
  }
  return sum / 13.0;
}

// Monochrome like the web interface: luminance, a gentle S-curve, then film grain.
vec3 finish(vec3 col, vec2 frag) {
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  l = mix(l, l * l * (3.0 - 2.0 * l), 0.35);
  l += (hash(frag + fract(u_time * 7.0) * 113.0) - 0.5) * 0.035;
  return vec3(l);
}
`;

export const SKY = `${COMMON}
// One layer of fine streaks: sparse columns, each with a short segment falling at its own pace.
float rain(vec2 uv, float cols, float rows, float speed, float seed) {
  vec2 r = vec2(uv.x * u_res.x / u_res.y, uv.y);
  r.x += r.y * 0.16;
  vec2 g = vec2(r.x * cols, r.y * rows + u_time * speed);
  vec2 id = floor(g);
  vec2 f = fract(g);
  float h = hash(id + seed);
  float on = step(0.86, h);
  float start = hash(id + seed + 7.1) * 0.6;
  float y = f.y - start;
  float streak = smoothstep(0.0, 0.04, y) * smoothstep(0.32, 0.0, y);
  float x = abs(f.x - 0.5 - (hash(id + seed + 3.3) - 0.5) * 0.6);
  return on * streak * smoothstep(0.09, 0.0, x);
}

void main() {
  vec2 uv = v_uv;
  float t = u_time;
  vec2 p = cover(uv, 0.0);
  // A slow breath and a little parallax from the pointer and the scroll.
  p = (p - vec2(0.5, 0.0)) * (0.965 - 0.008 * sin(t * 0.07)) + vec2(0.5, 0.0);
  p += u_pointer * vec2(0.010, 0.006) + vec2(0.0, -u_scroll * 0.05);

  // Thin clouds live in the band above the horizon; they drift and shimmer there only.
  float band = smoothstep(0.12, 0.3, p.y) * (1.0 - smoothstep(0.55, 0.78, p.y));
  float n = fbm(vec2(p.x * 2.6 - t * 0.018, p.y * 9.0 + t * 0.004));
  p.x += (n - 0.5) * 0.018 * band;
  p.y += (fbm(vec2(p.x * 4.0 + t * 0.01, p.y * 3.0)) - 0.5) * 0.004 * band;

  vec3 col = soft(p, 0.006);

  // The last light at the horizon swells and fades, slowly.
  float glow = smoothstep(0.42, 0.1, p.y) * smoothstep(0.0, 0.1, p.y);
  col += vec3(glow * (0.05 + 0.03 * sin(t * 0.21)));

  // Serein: three depths of fine rain, lit warm near the horizon, nearly invisible in the dark sky.
  float drops = rain(uv, 150.0, 2.2, 0.55, 1.0) * 0.55 + rain(uv, 230.0, 3.4, 0.8, 7.0) * 0.4 + rain(uv, 330.0, 5.0, 1.1, 13.0) * 0.28;
  col = mix(col, vec3(1.0), drops * mix(0.32, 0.12, uv.y));

  // Darker toward the edges, so the eye rests in the middle.
  vec2 v = (uv - 0.5) * vec2(1.1, 1.0);
  col *= mix(0.78, 1.0, smoothstep(0.9, 0.25, length(v)));
  gl_FragColor = vec4(finish(col, gl_FragCoord.xy), 1.0);
}`;

export const GLASS = `${COMMON}
// Drops that stay: one per cell, each appearing and drying at its own time.
// Returns the refraction offset in xy and the drop's coverage in z.
vec3 resting(vec2 uv, float scale, float seed) {
  vec2 g = uv * scale;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash(id + seed);
  vec2 c = (vec2(hash(id + seed + 1.7), hash(id + seed + 9.2)) - 0.5) * 0.7;
  float r = mix(0.06, 0.2, h * h);
  float life = fract(u_time * 0.03 + h * 13.0);
  r *= smoothstep(0.0, 0.08, life) * smoothstep(1.0, 0.7, life);
  vec2 d = f - c;
  float len = length(d);
  float m = smoothstep(r, r * 0.55, len) * step(0.35, h);
  return vec3(d / max(r, 0.0001) * m, m);
}

// Drops that run: one per column, falling in steps, wobbling a little, leaving a faint trail.
vec3 running(vec2 uv, float cols, float seed) {
  float aspect = u_res.x / u_res.y;
  vec2 g = vec2(uv.x * aspect * cols, uv.y);
  float id = floor(g.x);
  float h = hash(vec2(id, seed));
  float speed = mix(0.04, 0.11, hash(vec2(id, seed + 3.0)));
  float phase = fract(u_time * speed + h);
  // Stick, then slide: water on glass does not fall at a constant pace.
  float y = 1.15 - (phase + 0.06 * sin(phase * 40.0 + h * 6.0)) * 1.3;
  float x = fract(g.x) - 0.5 + sin(uv.y * 23.0 + h * 9.0) * 0.08;
  vec2 d = vec2(x / (cols * 0.012), (g.y - y) / 0.022);
  float len = length(d);
  float on = step(0.55, h);
  float drop = smoothstep(1.0, 0.5, len) * on;
  float trail = smoothstep(0.35, 0.0, abs(x)) * smoothstep(y, y + 0.25, g.y) * step(y, g.y) * on * 0.35;
  return vec3(vec2(d.x, d.y) * 0.5 * drop + vec2(x * 2.0, 0.0) * trail, max(drop, trail * 0.6));
}

void main() {
  vec2 uv = v_uv;
  vec2 p = cover(uv, 0.5);
  p += u_pointer * vec2(0.006, 0.004) + vec2(0.0, -u_scroll * 0.03);
  float aspect = u_res.x / u_res.y;
  vec2 q = vec2(uv.x * aspect, uv.y);

  vec3 a = resting(q, 26.0, 1.0);
  vec3 b = resting(q + 0.37, 14.0, 5.0);
  vec3 c = running(uv, 9.0, 11.0);
  vec2 offset = (a.xy * 0.012 + b.xy * 0.02 + c.xy * 0.03);
  float wet = clamp(a.z + b.z + c.z, 0.0, 1.0);

  // A drop is a small lens: it shows the scene behind it upside down and a little brighter.
  vec3 col = soft(p - offset, 0.008);
  col = mix(col * 0.82, col * 1.18 + 0.015, wet);
  // A highlight on the upper edge of each drop.
  col += vec3(smoothstep(0.2, 0.9, -offset.y * 40.0) * wet * 0.12);

  vec2 v = (uv - 0.5) * vec2(1.0, 1.15);
  col *= mix(0.6, 1.0, smoothstep(0.85, 0.2, length(v)));
  gl_FragColor = vec4(finish(col, gl_FragCoord.xy), 1.0);
}`;
