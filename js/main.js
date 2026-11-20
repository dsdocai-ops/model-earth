import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  ATMOSPHERE, earthVertex, earthFragment, cloudsFragment,
  atmosphereVertex, atmosphereFragment,
} from './shaders.js';
import { latLonToVector } from './astro.js';

const TEX = './assets/textures/';
const DEG = Math.PI / 180;

const canvas = document.getElementById('globe');
const stage = document.querySelector('.stage');
const loader = document.getElementById('loader');
const loaderBar = document.getElementById('loader-bar');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarsePointer = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.6;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Deep navy sky to match the site's blue / red / white palette.
scene.background = new THREE.Color(0x0c2266);
const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 2000);

const maxTex = renderer.capabilities.maxTextureSize;
const maxAniso = renderer.capabilities.getMaxAnisotropy();
const hiRes = maxTex >= 8192 && !coarsePointer && Math.min(screen.width, screen.height) * devicePixelRatio >= 1000;

// ---------------------------------------------------------------- textures
const manager = new THREE.LoadingManager();
const texLoader = new THREE.TextureLoader(manager);

function loadTex(file, srgb) {
  const t = texLoader.load(TEX + file);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = maxAniso;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

const textures = {
  day: loadTex('earth_day_4k.jpg', true),
  night: loadTex('earth_night_4k.jpg', true),
  normal: loadTex('earth_normal_4k.jpg', false),
  ocean: loadTex('earth_ocean_4k.jpg', false),
  clouds: loadTex('earth_clouds_4k.jpg', false),
  stars: loadTex('stars_4k.jpg', true),
};

manager.onProgress = (_url, loaded, total) => {
  loaderBar.style.transform = `scaleX(${loaded / total})`;
};

// ---------------------------------------------------------------- planet
const sunDir = new THREE.Vector3(1, 0, 0);
const atmoUniforms = {
  uSunDir: { value: sunDir },
  uRayleighBeta: { value: new THREE.Vector3(...ATMOSPHERE.rayleighBeta) },
  uRayleighHeight: { value: ATMOSPHERE.rayleighHeight },
};

const earthMat = new THREE.ShaderMaterial({
  vertexShader: earthVertex,
  fragmentShader: earthFragment,
  uniforms: {
    ...atmoUniforms,
    uDay: { value: textures.day },
    uNight: { value: textures.night },
    uNormal: { value: textures.normal },
    uOcean: { value: textures.ocean },
    uClouds: { value: textures.clouds },
    uCloudOffset: { value: 0 },
    uCloudsOn: { value: 1 },
    uLightsOn: { value: 1 },
    uSunI: { value: ATMOSPHERE.sunIntensity },
    uNightI: { value: 3.6 },
  },
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), earthMat);
scene.add(earth);

const cloudsMat = new THREE.ShaderMaterial({
  vertexShader: earthVertex,
  fragmentShader: cloudsFragment,
  uniforms: {
    ...atmoUniforms,
    uClouds: { value: textures.clouds },
    uCloudOffset: earthMat.uniforms.uCloudOffset,
    uSunI: { value: ATMOSPHERE.sunIntensity },
    uOpacity: { value: 1 },
    uTexel: { value: new THREE.Vector2(1.5 / 4096, 1.5 / 2048) },
  },
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
});
const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.0045, 192, 96), cloudsMat);
clouds.renderOrder = 1;
scene.add(clouds);

const atmoMat = new THREE.ShaderMaterial({
  vertexShader: atmosphereVertex,
  fragmentShader: atmosphereFragment,
  uniforms: {
    ...atmoUniforms,
    uMieBeta: { value: ATMOSPHERE.mieBeta },
    uMieHeight: { value: ATMOSPHERE.mieHeight },
    uMieG: { value: ATMOSPHERE.mieG },
    uPlanetR: { value: ATMOSPHERE.planetRadius },
    uAtmoR: { value: ATMOSPHERE.atmosphereRadius },
    uSunI: { value: ATMOSPHERE.sunIntensity },
    uIntensity: { value: 1 },
  },
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
});
const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(ATMOSPHERE.atmosphereRadius, 128, 64), atmoMat);
atmosphere.renderOrder = 2;
scene.add(atmosphere);

// Milky Way backdrop, kept dim: a sunlit Earth would wash most stars out of a real exposure.
const stars = new THREE.Mesh(
  new THREE.SphereGeometry(900, 64, 32),
  new THREE.MeshBasicMaterial({ map: textures.stars, side: THREE.BackSide, color: new THREE.Color(0.11, 0.11, 0.12), depthWrite: false, blending: THREE.AdditiveBlending, transparent: true })
);
stars.rotation.set(-60 * DEG, 0, 23 * DEG);
scene.add(stars);

// The Sun: an HDR disc that the bloom pass turns into glare when it peeks past the limb.
function makeSunTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.08, 'rgba(255,250,240,1)');
  grad.addColorStop(0.12, 'rgba(255,230,200,0.35)');
  grad.addColorStop(0.4, 'rgba(255,200,150,0.06)');
  grad.addColorStop(1, 'rgba(255,190,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const sun = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeSunTexture(), color: new THREE.Color(30, 28, 26), blending: THREE.AdditiveBlending, depthWrite: false,
}));
sun.scale.setScalar(60);
scene.add(sun);

// ---------------------------------------------------------------- post
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.55, 1.4);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- Folsom High School
// Host school: Folsom High School, 1655 Iron Point Road, Folsom, CA.
const HOST = { lat: 38.6585 * DEG, lon: -121.1315 * DEG };
const hostDir = latLonToVector(HOST.lat, HOST.lon, new THREE.Vector3()).normalize();

// A fixed, flattering sun: high over the Pacific to the west of Folsom, so the whole visible
// face of the planet is in daylight and the host school sits in warm afternoon light.
latLonToVector(26 * DEG, HOST.lon - 48 * DEG, sunDir).normalize();
sun.position.copy(sunDir).multiplyScalar(800);

const marker = new THREE.Group();
const markerColor = new THREE.Color(2.4, 0.05, 0.08); // saturated red that survives tone mapping
const pin = new THREE.Mesh(
  new THREE.CircleGeometry(0.009, 32),
  new THREE.MeshBasicMaterial({ color: markerColor, transparent: true, depthWrite: false })
);
const ringMat = new THREE.MeshBasicMaterial({ color: markerColor, transparent: true, depthWrite: false, side: THREE.DoubleSide });
const ring = new THREE.Mesh(new THREE.RingGeometry(0.013, 0.017, 48), ringMat);
marker.add(pin, ring);
marker.position.copy(hostDir).multiplyScalar(1.0075);
marker.lookAt(hostDir.clone().multiplyScalar(2));
marker.renderOrder = pin.renderOrder = ring.renderOrder = 3;
scene.add(marker);

// Camera: looks straight down at Folsom from slightly south, with a slow, small sway.
// Close-up framing on Northern California; clicking the school pin flies in closer.
const DISTANCE_HERO = 2.55;
const DISTANCE_ZOOMED = 1.45;
const DISTANCE_DIVE = 1.16; // end of the scroll fly-in, just above the cloud tops
const view = { distance: DISTANCE_HERO, target: DISTANCE_HERO };
function placeCamera(t) {
  // Sway fades out as the camera flies in, so the zoom lands squarely on the school.
  const zoom = Math.min(Math.max((DISTANCE_HERO - view.distance) / (DISTANCE_HERO - DISTANCE_ZOOMED), 0), 1);
  const sway = reduceMotion ? 0 : Math.sin(t * 0.07) * 3 * DEG * (1 - zoom);
  const latOffset = (1 - zoom) * 4 * DEG;
  latLonToVector(HOST.lat - latOffset, HOST.lon + sway, camera.position).multiplyScalar(view.distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
}
placeCamera(0);

// ---------------------------------------------------------------- layout
let width = 0, height = 0;
let shiftX = 0, shiftY = 0;

function resize() {
  width = stage.clientWidth;
  height = stage.clientHeight;
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  bloom.setSize(width, height);
  camera.aspect = width / height;
  // Desktop: slide the globe right of the headline. Narrow screens: lift it above the copy.
  const portrait = width / height < 0.8;
  camera.fov = portrait ? 54 : 30;
  shiftX = width > 900 ? -0.2 : 0;
  shiftY = width > 900 ? 0 : 0.2;
  camera.setViewOffset(width, height, shiftX * width, shiftY * height, width, height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// ---------------------------------------------------------------- pin label
const intro = document.getElementById('intro');
if (intro && reduceMotion) document.body.classList.add('no-intro');
const pinLabel = document.getElementById('pin-label');
const projected = new THREE.Vector3();
function placeLabel() {
  if (!pinLabel) return;
  projected.copy(marker.position).project(camera);
  const facing = marker.position.clone().sub(camera.position).dot(hostDir) < 0;
  const visible = facing && (intro ? introP < 0.02 : scrollY < innerHeight * 0.35);
  pinLabel.style.opacity = visible ? '1' : '0';
  pinLabel.style.pointerEvents = visible ? 'auto' : 'none';
  pinLabel.style.transform = `translate(${(projected.x * 0.5 + 0.5) * width}px, ${(-projected.y * 0.5 + 0.5) * height}px)`;
}

// ---------------------------------------------------------------- campus photos
const campus = document.getElementById('campus');
let openTimer;
if (intro && pinLabel) {
  pinLabel.addEventListener('click', () => {
    const end = intro.offsetTop + intro.offsetHeight - innerHeight;
    window.scrollTo({ top: end, behavior: reduceMotion ? 'auto' : 'smooth' });
  });
} else if (campus && pinLabel) {
  const img = document.getElementById('campus-img');
  pinLabel.addEventListener('click', () => {
    view.target = DISTANCE_ZOOMED;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => campus.showModal(), reduceMotion ? 0 : 900);
  });
  campus.addEventListener('close', () => {
    view.target = DISTANCE_HERO;
    pinLabel.focus({ preventScroll: true });
  });
  campus.querySelector('[data-close]')?.addEventListener('click', () => campus.close());
  // Click on the backdrop closes the dialog.
  campus.addEventListener('click', (e) => { if (e.target === campus) campus.close(); });
  campus.querySelectorAll('.campus-thumbs button').forEach((btn, _, all) => {
    btn.addEventListener('click', () => {
      img.src = btn.dataset.src;
      img.alt = btn.dataset.alt;
      all.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    });
  });
}

// ---------------------------------------------------------------- HUD
const $ = (id) => document.getElementById(id);
const hud = { time: $('hud-time'), countdown: $('hud-countdown') };

// Conference day, as a Pacific-time calendar date (e.g. "2027-03-21").
const conferenceDay = document.body.dataset.conference;
const folsomClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit',
});

function pacificMidnightUTC(isoDay) {
  // Midnight in Folsom: 07:00 UTC during daylight saving (March onward), 08:00 otherwise.
  const [y, m, d] = isoDay.split('-').map(Number);
  for (const h of [7, 8]) {
    const t = Date.UTC(y, m - 1, d, h);
    const hh = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(t);
    if (Number(hh) === 0) return t;
  }
  return Date.UTC(y, m - 1, d, 8);
}
const conferenceStart = conferenceDay ? pacificMidnightUTC(conferenceDay) : null;

let lastHud = 0;
function updateHud(now) {
  if (now - lastHud < 250) return;
  lastHud = now;
  const date = new Date();
  if (hud.time) hud.time.textContent = folsomClock.format(date);
  if (hud.countdown && conferenceStart) {
    const days = Math.ceil((conferenceStart - date.getTime()) / 86400000);
    hud.countdown.textContent = days > 1 ? `${days} days` : days === 1 ? 'Tomorrow' : days > -1 ? 'Today' : 'Concluded';
  }
}

// ---------------------------------------------------------------- scroll
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
// Progress of x through [a, b]; a > b gives the reverse ramp.
const seg = (a, b, x) => clamp01((x - a) / (b - a));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const showLayer = (el, o) => {
  if (!el) return;
  el.style.opacity = String(o);
  el.style.visibility = o > 0.002 ? 'visible' : 'hidden';
};

let scrollFade = 1;
let markerFade = 1;

// Scroll-driven fly-in (playful page): space -> clouds -> campus -> gate -> site.
const L = intro ? {
  fade: [...document.querySelectorAll('.hero-copy, .hud, .sticker, .scroll-hint')],
  photo: intro.querySelector('.intro-photo'),
  img: intro.querySelector('.intro-photo img'),
  arrival: intro.querySelector('.intro-arrival'),
  gate: intro.querySelector('.intro-gate'),
  leaves: intro.querySelector('.gate-leaves'),
  left: intro.querySelector('.gate-left'),
  right: intro.querySelector('.gate-right'),
  cloudWrap: intro.querySelector('.intro-clouds'),
  clouds: [...intro.querySelectorAll('.intro-clouds img')],
  white: intro.querySelector('.intro-white'),
} : null;
// Each cloud sits at a depth along the dive, offset from the centre and slightly turned.
const cloudPlanes = L ? L.clouds.map((el, i) => ({
  el,
  z: 0.18 + i * 0.13,
  x: [-38, 30, -12, 42, -30, 18, -44, 34, 6, -20][i % 10],
  y: [-22, 18, 30, -28, 8, -34, 26, 12, -10, 24][i % 10],
  r: (i * 47) % 360,
})) : [];

function updateIntro() {
  const p = introP;
  const ui = 1 - seg(0, 0.04, p);
  L.fade.forEach((el) => { el.style.opacity = String(ui); el.style.visibility = ui > 0.01 ? 'visible' : 'hidden'; });

  // Globe: dive from orbit to just above the cloud deck, then hand over to the clouds.
  view.distance = lerp(DISTANCE_HERO, DISTANCE_DIVE, ease(seg(0.03, 0.36, p)));
  markerFade = 1 - seg(0.16, 0.26, p);
  const globe = 1 - seg(0.4, 0.46, p);
  stage.style.opacity = String(globe);
  scrollFade = globe;

  // Cloud fly-through: planes rush past the camera, peaking in a white-out.
  const q = seg(0.2, 0.5, p);
  showLayer(L.cloudWrap, q > 0 && q < 1 ? 1 : 0);
  const cam = q * 1.55;
  for (const c of cloudPlanes) {
    const dz = c.z - cam;
    if (dz <= 0.02 || dz > 0.9) { c.el.style.opacity = '0'; continue; }
    const scale = 0.35 / dz;
    c.el.style.opacity = String(seg(0.9, 0.55, dz) * seg(0.02, 0.16, dz));
    c.el.style.transform = `translate(${c.x * scale}vw, ${c.y * scale}vh) rotate(${c.r}deg) scale(${scale})`;
  }
  showLayer(L.white, 0.96 * seg(0.33, 0.4, p) * (1 - seg(0.43, 0.5, p)));

  // The campus from Iron Point Road, pushing in toward the front drop-off.
  showLayer(L.photo, seg(0.4, 0.46, p));
  const push = ease(seg(0.4, 0.7, p));
  const soften = seg(0.6, 0.7, p);
  L.img.style.transform = `scale(${1 + 1.8 * push})`;
  L.img.style.filter = `blur(${soften * 6}px) brightness(${1 - soften * 0.3})`;

  // The gate: approach, swing open, pass through.
  const approach = ease(seg(0.56, 0.72, p));
  const open = ease(seg(0.7, 0.84, p));
  const pass = ease(seg(0.8, 0.94, p));
  showLayer(L.gate, seg(0.56, 0.63, p) * (1 - seg(0.86, 0.94, p)));
  L.gate.style.transform = `scale(${0.3 + 0.7 * approach + 3.2 * pass})`;
  L.left.style.transform = `rotateY(${-108 * open}deg)`;
  L.right.style.transform = `rotateY(${108 * open}deg)`;

  // Through the gate: the site itself.
  showLayer(L.arrival, seg(0.74, 0.86, p));
  L.arrival.style.setProperty('--arrive', String(0.86 + 0.14 * ease(seg(0.74, 0.94, p))));
}

let introP = 0;
function onScroll() {
  if (intro && !reduceMotion) {
    const total = intro.offsetHeight - innerHeight;
    introP = clamp01(-intro.getBoundingClientRect().top / total);
    updateIntro();
    return;
  }
  const p = Math.min(Math.max(scrollY / innerHeight, 0), 1.2);
  scrollFade = 1 - Math.min(Math.max((p - 0.35) / 0.75, 0), 1);
  stage.style.transform = `translate3d(0, ${-p * 12}vh, 0) scale(${1 - p * 0.06})`;
  stage.style.opacity = String(0.15 + scrollFade * 0.85);
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let ready = false;

manager.onLoad = () => {
  ready = true;
  document.body.classList.add('loaded');
  loader.setAttribute('aria-hidden', 'true');
  if (hiRes) upgradeTextures();
};

function upgradeTextures() {
  const hi = new THREE.TextureLoader();
  hi.load(TEX + 'earth_day_8k.jpg', (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.wrapS = THREE.RepeatWrapping;
    earthMat.uniforms.uDay.value = t;
    textures.day.dispose();
    textures.day = t;
  });
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!ready || document.hidden) return;

  // Clouds drift slowly relative to the surface.
  earthMat.uniforms.uCloudOffset.value = (earthMat.uniforms.uCloudOffset.value + dt * 0.0006) % 1;

  if (!intro || reduceMotion) view.distance += (view.target - view.distance) * (1 - Math.exp(-dt * 3.2));
  placeCamera(clock.elapsedTime);
  placeLabel();
  updateHud(performance.now());

  // Pulse the host-school marker.
  const pulse = (clock.elapsedTime % 2.2) / 2.2;
  ring.scale.setScalar(1 + pulse * 2.2);
  ringMat.opacity = (1 - pulse) * markerFade;
  pin.material.opacity = markerFade;
  marker.visible = markerFade > 0.01;
  // Keep the pin the same size on screen as the camera dives.
  marker.scale.setScalar((view.distance - 1) / (DISTANCE_HERO - 1));

  if (scrollFade > 0.001) composer.render(dt);
}
frame();
