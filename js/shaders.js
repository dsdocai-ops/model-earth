// GLSL for the planet. All shaders output linear HDR radiance; tone mapping and
// sRGB encoding happen once, in the final OutputPass.

// Shared atmosphere constants, expressed with Earth radius = 1 scene unit.
// Real values: Rayleigh β = (5.8, 13.5, 33.1)e-6 /m, H = 8 km; Mie β = 21e-6 /m, H = 1.2 km.
// Scale heights are slightly exaggerated so the limb reads at hero scale.
const EARTH_RADIUS_M = 6.371e6;
export const ATMOSPHERE = {
  planetRadius: 1.0,
  atmosphereRadius: 1.0 + 110e3 / EARTH_RADIUS_M * 1.35,
  rayleighBeta: [5.8e-6 * EARTH_RADIUS_M, 13.5e-6 * EARTH_RADIUS_M, 33.1e-6 * EARTH_RADIUS_M],
  rayleighHeight: (8.0e3 / EARTH_RADIUS_M) * 1.35,
  mieBeta: 21e-6 * EARTH_RADIUS_M,
  mieHeight: (1.2e3 / EARTH_RADIUS_M) * 1.6,
  mieG: 0.76,
  sunIntensity: 22.0,
};

const common = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uRayleighBeta;
  uniform float uRayleighHeight;

  // Colour of sunlight after passing through the atmosphere to a point on the surface.
  // Uses Kasten–Young style airmass so the terminator turns gold, then red.
  vec3 sunTransmittance(float mu) {
    float m = 1.0 / (max(mu, 0.0) + 0.15 * pow(max(93.885 - degrees(acos(clamp(mu, -1.0, 1.0))), 0.01), -1.253));
    m = min(m, 40.0);
    return exp(-uRayleighBeta * uRayleighHeight * m * 1.05);
  }
`;

export const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const earthFragment = /* glsl */ `
  ${common}
  uniform sampler2D uDay;
  uniform sampler2D uNight;
  uniform sampler2D uNormal;
  uniform sampler2D uOcean;
  uniform sampler2D uClouds;
  uniform float uCloudOffset;
  uniform float uCloudsOn;
  uniform float uLightsOn;
  uniform float uSunI;
  uniform float uNightI;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  const float PI = 3.14159265;

  float D_GGX(float NoH, float a) {
    float a2 = a * a;
    float d = NoH * NoH * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
  }

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 up = abs(n.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 T = normalize(cross(up, n));   // east
    vec3 B = cross(n, T);               // north

    float ocean = texture2D(uOcean, vUv).r;
    vec3 tn = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
    vec3 N = normalize(T * tn.x + B * tn.y + n * tn.z);

    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 H = normalize(L + V);

    float muGeo = dot(n, L);
    float NoL = max(dot(N, L), 0.0);
    float NoV = max(dot(n, V), 1e-4);

    vec3 sunCol = sunTransmittance(muGeo);

    // Albedo — deepen open ocean slightly, keep land as photographed.
    vec3 albedo = texture2D(uDay, vUv).rgb;
    albedo = mix(albedo, albedo * vec3(0.78, 0.9, 1.0), ocean * 0.6);

    // Cloud shadows: sample the cloud layer offset toward the sun.
    float cosLat = max(length(n.xz), 0.05);
    vec2 sunT = vec2(dot(L, T), dot(L, B));
    float shadowLen = 0.0045 / max(muGeo, 0.12);
    vec2 shadowUv = vUv + vec2(uCloudOffset, 0.0) + vec2(sunT.x / (6.2831853 * cosLat), sunT.y / 3.1415926) * shadowLen;
    float cloudShadow = texture2D(uClouds, shadowUv).r;
    float shadow = 1.0 - 0.6 * smoothstep(0.1, 0.9, cloudShadow) * uCloudsOn;

    // Diffuse with a narrow wrap at the terminator (light bending through the atmosphere).
    float wrap = smoothstep(-0.06, 0.16, muGeo);
    vec3 diffuse = albedo / PI * NoL * wrap;

    // Ocean sun glint — GGX with a Schlick Fresnel, water F0 = 0.02.
    float rough = mix(0.62, 0.2, ocean);
    float NoH = max(dot(n, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    float F = 0.02 + 0.98 * pow(1.0 - VoH, 5.0);
    float D = D_GGX(NoH, rough * rough);
    float Vis = 0.25 / max(NoL * NoV, 0.05);
    float specMask = mix(0.04, 1.0, ocean);
    vec3 specular = vec3(D * F * Vis * max(muGeo, 0.0)) * specMask * 0.55;

    vec3 color = (diffuse + specular) * sunCol * uSunI * shadow;

    // Faint skylight on the day side so shadowed relief never goes fully black.
    color += albedo * vec3(0.12, 0.2, 0.38) * 0.07 * smoothstep(-0.1, 0.4, muGeo) * uSunI / PI;

    // Earthshine / moonlight: keeps the night hemisphere a barely-there disc rather than a hole.
    color += albedo * vec3(0.6, 0.7, 1.0) * 0.0035 * (1.0 - smoothstep(-0.2, 0.1, muGeo));

    // City lights fade in after civil twilight and are dimmed by overlying cloud.
    vec3 lights = texture2D(uNight, vUv).rgb;
    lights = pow(lights, vec3(1.35)) * vec3(1.0, 0.86, 0.66);
    float night = smoothstep(0.02, -0.16, muGeo);
    float cloudCover = texture2D(uClouds, vUv + vec2(uCloudOffset, 0.0)).r;
    lights *= 1.0 - 0.75 * smoothstep(0.15, 0.8, cloudCover) * uCloudsOn;
    color += lights * night * uNightI * uLightsOn;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export const cloudsFragment = /* glsl */ `
  ${common}
  uniform sampler2D uClouds;
  uniform float uCloudOffset;
  uniform float uSunI;
  uniform float uOpacity;
  uniform vec2 uTexel;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec2 uv = vUv + vec2(uCloudOffset, 0.0);
    float c = texture2D(uClouds, uv).r;
    float alpha = smoothstep(0.04, 0.85, c) * uOpacity;
    if (alpha < 0.003) discard;

    vec3 n = normalize(vNormalW);
    vec3 up = abs(n.y) > 0.999 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 T = normalize(cross(up, n));
    vec3 B = cross(n, T);

    // Treat cloud density as a height field to give thick decks some relief.
    float cx = texture2D(uClouds, uv + vec2(uTexel.x, 0.0)).r - texture2D(uClouds, uv - vec2(uTexel.x, 0.0)).r;
    float cy = texture2D(uClouds, uv + vec2(0.0, uTexel.y)).r - texture2D(uClouds, uv - vec2(0.0, uTexel.y)).r;
    vec3 N = normalize(n - (T * cx + B * cy) * 1.6);

    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vPosW);
    float muGeo = dot(n, L);
    float NoL = dot(N, L);

    vec3 sunCol = sunTransmittance(muGeo + 0.02);
    float sunlit = smoothstep(-0.08, 0.18, muGeo);
    float lit = sunlit * (0.55 + 0.45 * max(NoL, 0.0));
    // Forward scattering brightens thin cloud edges when backlit — only where the sun reaches.
    float forward = pow(max(dot(-V, L), 0.0), 8.0) * (1.0 - alpha) * 0.6 * sunlit;

    vec3 albedo = vec3(0.92, 0.94, 0.97) * mix(0.82, 1.0, c);
    vec3 color = albedo / 3.14159265 * sunCol * uSunI * (lit + forward);

    // Premultiplied alpha output.
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

export const atmosphereVertex = /* glsl */ `
  varying vec3 vPosW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPosW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Single-scattering Rayleigh + Mie, ray-marched per pixel with a planet shadow test.
export const atmosphereFragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uRayleighBeta;
  uniform float uRayleighHeight;
  uniform float uMieBeta;
  uniform float uMieHeight;
  uniform float uMieG;
  uniform float uPlanetR;
  uniform float uAtmoR;
  uniform float uSunI;
  uniform float uIntensity;

  varying vec3 vPosW;

  #define VIEW_STEPS 16
  #define LIGHT_STEPS 6
  const float PI = 3.14159265;

  vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e5, -1e5);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vPosW - cameraPosition);
    vec3 L = normalize(uSunDir);

    vec2 atmo = raySphere(ro, rd, uAtmoR);
    if (atmo.x > atmo.y) discard;
    vec2 planet = raySphere(ro, rd, uPlanetR);

    float t0 = max(atmo.x, 0.0);
    float t1 = atmo.y;
    if (planet.x < planet.y && planet.x > 0.0) t1 = min(t1, planet.x);

    float ds = (t1 - t0) / float(VIEW_STEPS);
    float odR = 0.0, odM = 0.0;
    vec3 sumR = vec3(0.0), sumM = vec3(0.0);

    for (int i = 0; i < VIEW_STEPS; i++) {
      vec3 p = ro + rd * (t0 + ds * (float(i) + 0.5));
      float h = length(p) - uPlanetR;
      float dR = exp(-h / uRayleighHeight) * ds;
      float dM = exp(-h / uMieHeight) * ds;
      odR += dR;
      odM += dM;

      // Soft planet shadow along the light ray.
      float side = dot(p, L);
      float closest = length(p - L * side);
      float lit = side > 0.0 ? 1.0 : smoothstep(uPlanetR - 0.004, uPlanetR + 0.012, closest);
      if (lit <= 0.0) continue;

      vec2 la = raySphere(p, L, uAtmoR);
      float lds = la.y / float(LIGHT_STEPS);
      float lR = 0.0, lM = 0.0;
      for (int j = 0; j < LIGHT_STEPS; j++) {
        vec3 lp = p + L * (lds * (float(j) + 0.5));
        float lh = max(length(lp) - uPlanetR, 0.0);
        lR += exp(-lh / uRayleighHeight) * lds;
        lM += exp(-lh / uMieHeight) * lds;
      }
      vec3 tau = uRayleighBeta * (odR + lR) + uMieBeta * 1.1 * (odM + lM);
      vec3 att = exp(-tau) * lit;
      sumR += dR * att;
      sumM += dM * att;
    }

    float mu = dot(rd, L);
    float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    float g2 = uMieG * uMieG;
    float pM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
               ((2.0 + g2) * pow(1.0 + g2 - 2.0 * uMieG * mu, 1.5));

    vec3 scatter = uSunI * (pR * uRayleighBeta * sumR + pM * uMieBeta * sumM) * uIntensity;
    vec3 trans = exp(-(uRayleighBeta * odR + uMieBeta * 1.1 * odM));
    float alpha = (1.0 - dot(trans, vec3(0.3333))) * uIntensity;

    gl_FragColor = vec4(scatter, clamp(alpha, 0.0, 1.0));
  }
`;
