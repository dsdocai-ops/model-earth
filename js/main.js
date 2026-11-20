import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  ATMOSPHERE, earthVertex, earthFragment, cloudsFragment,
  atmosphereVertex, atmosphereFragment,
} from './shaders.js';
import { subsolarPoint, latLonToVector, vectorToLatLon, formatLatLon } from './astro.js';

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
renderer.toneMappingExposure = 0.62;
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

// ---------------------------------------------------------------- controls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.enableZoom = false;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.6;
controls.minDistance = 1.35;
controls.maxDistance = 9;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = -0.18;

let idleTimer;
controls.addEventListener('start', () => {
  controls.autoRotate = false;
  clearTimeout(idleTimer);
});
controls.addEventListener('end', () => {
  clearTimeout(idleTimer);
  if (!reduceMotion) idleTimer = setTimeout(() => (controls.autoRotate = true), 6000);
});

function setTouchInteraction(on) {
  if (!coarsePointer) return;
  controls.enabled = on;
  canvas.style.touchAction = on ? 'none' : 'pan-y';
}
setTouchInteraction(false);

// ---------------------------------------------------------------- time
const state = {
  offsetHours: 0,
  timelapse: false,
  timelapseHours: 0,
  explore: false,
};

function simDate() {
  const extra = state.offsetHours + state.timelapseHours;
  return new Date(Date.now() + extra * 3600e3);
}

function updateSun(date) {
  const { lat, lon } = subsolarPoint(date);
  latLonToVector(lat, lon, sunDir).normalize();
  sun.position.copy(sunDir).multiplyScalar(800);
  return { lat, lon };
}

// ---------------------------------------------------------------- Folsom marker
const FOLSOM = { lat: 38.678 * DEG, lon: -121.1761 * DEG };
const folsomDir = latLonToVector(FOLSOM.lat, FOLSOM.lon, new THREE.Vector3()).normalize();

const marker = new THREE.Group();
const markerColor = new THREE.Color(6, 0.5, 0.6); // HDR red so it blooms slightly
const pin = new THREE.Mesh(
  new THREE.CircleGeometry(0.011, 32),
  new THREE.MeshBasicMaterial({ color: markerColor, transparent: true, depthWrite: false })
);
const ringMat = new THREE.MeshBasicMaterial({ color: markerColor, transparent: true, depthWrite: false, side: THREE.DoubleSide });
const ring = new THREE.Mesh(new THREE.RingGeometry(0.016, 0.02, 48), ringMat);
marker.add(pin, ring);
marker.position.copy(folsomDir).multiplyScalar(1.0075);
marker.lookAt(folsomDir.clone().multiplyScalar(2));
marker.renderOrder = 3;
pin.renderOrder = ring.renderOrder = 3;
scene.add(marker);

// Opening view: frame Folsom, nudged toward the sunlit side so the hero is never a dark disc.
{
  const { lon: sunLon } = updateSun(simDate());
  let dl = Math.atan2(Math.sin(sunLon - FOLSOM.lon), Math.cos(sunLon - FOLSOM.lon));
  dl = Math.max(-40 * DEG, Math.min(40 * DEG, dl));
  latLonToVector(24 * DEG, FOLSOM.lon + dl, camera.position).multiplyScalar(4.5);
  camera.lookAt(0, 0, 0);
}

// ---------------------------------------------------------------- layout
let width = 0, height = 0;
const viewShift = { current: 0, target: 0, currentY: 0, targetY: 0 };

// Desktop: slide the globe right of the headline. Narrow screens: lift it above the copy.
function heroShift() {
  if (state.explore) return [0, 0];
  if (width > 900) return [-0.2, 0];
  return [0, 0.19];
}

function resize() {
  width = stage.clientWidth;
  height = stage.clientHeight;
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  bloom.setSize(width, height);
  camera.aspect = width / height;
  // Narrow screens: pull back so the full disc fits.
  const portrait = width / height < 0.8;
  camera.fov = portrait ? 60 : 32;
  [viewShift.target, viewShift.targetY] = heroShift();
  if (!viewShift.initialised) {
    viewShift.current = viewShift.target;
    viewShift.currentY = viewShift.targetY;
    viewShift.initialised = true;
  }
  applyViewOffset();
}

function applyViewOffset() {
  camera.setViewOffset(width, height, viewShift.current * width, viewShift.currentY * height, width, height);
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(stage);
resize();

// ---------------------------------------------------------------- HUD
const $ = (id) => document.getElementById(id);
const hud = {
  time: $('hud-time'),
  sky: $('hud-sky'),
  countdown: $('hud-countdown'),
};

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
  if (hud.sky) {
    const mu = folsomDir.dot(sunDir);
    hud.sky.textContent = mu > 0.05 ? 'Daylight' : mu > -0.1 ? 'Twilight' : 'Night';
  }
  if (hud.countdown && conferenceStart) {
    const days = Math.ceil((conferenceStart - date.getTime()) / 86400000);
    hud.countdown.textContent = days > 1 ? `${days} days` : days === 1 ? 'Tomorrow' : days > -1 ? 'Today' : 'Concluded';
  }
}

// ---------------------------------------------------------------- UI wiring
const layerTargets = { clouds: 1, lights: 1, atmosphere: 1 };

function setExplore(on) {
  state.explore = on;
  document.body.classList.toggle('exploring', on);
  controls.enableZoom = on;
  setTouchInteraction(on);
  [viewShift.target, viewShift.targetY] = heroShift();
  if (on) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('explore-exit')?.focus({ preventScroll: true });
  }
}
document.querySelectorAll('[data-explore]').forEach((b) => b.addEventListener('click', () => setExplore(true)));
$('explore-exit')?.addEventListener('click', () => setExplore(false));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.explore) setExplore(false);
});

// Scroll: let the planet sink and dim as the story sections slide over it.
let scrollFade = 1;
function onScroll() {
  const p = Math.min(Math.max(scrollY / innerHeight, 0), 1.2);
  scrollFade = 1 - Math.min(Math.max((p - 0.35) / 0.75, 0), 1);
  stage.style.transform = `translate3d(0, ${-p * 12}vh, 0) scale(${1 - p * 0.06})`;
  stage.style.opacity = String(0.15 + scrollFade * 0.85);
}
addEventListener('scroll', onScroll, { passive: true });
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
  const swap = (file, key, uniform) => {
    hi.load(TEX + file, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      t.wrapS = THREE.RepeatWrapping;
      earthMat.uniforms[uniform].value = t;
      textures[key].dispose();
      textures[key] = t;
    });
  };
  swap('earth_day_8k.jpg', 'day', 'uDay');
  swap('earth_night_8k.jpg', 'night', 'uNight');
}

const lerp = (a, b, t) => a + (b - a) * t;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!ready || document.hidden) return;

  if (state.timelapse) state.timelapseHours += dt * 1.5; // 1.5 hours of Earth time per second
  const date = simDate();
  const sub = updateSun(date);

  // Clouds drift slowly relative to the surface.
  earthMat.uniforms.uCloudOffset.value = (earthMat.uniforms.uCloudOffset.value + dt * 0.0006) % 1;

  const k = 1 - Math.exp(-dt * 6);
  earthMat.uniforms.uCloudsOn.value = lerp(earthMat.uniforms.uCloudsOn.value, layerTargets.clouds, k);
  cloudsMat.uniforms.uOpacity.value = earthMat.uniforms.uCloudsOn.value;
  clouds.visible = cloudsMat.uniforms.uOpacity.value > 0.002;
  earthMat.uniforms.uLightsOn.value = lerp(earthMat.uniforms.uLightsOn.value, layerTargets.lights, k);
  atmoMat.uniforms.uIntensity.value = lerp(atmoMat.uniforms.uIntensity.value, layerTargets.atmosphere, k);
  atmosphere.visible = atmoMat.uniforms.uIntensity.value > 0.002;

  const ks = 1 - Math.exp(-dt * 4);
  viewShift.current = lerp(viewShift.current, viewShift.target, ks);
  viewShift.currentY = lerp(viewShift.currentY, viewShift.targetY, ks);
  applyViewOffset();

  controls.update(dt);
  updateHud(performance.now());

  // Pulse the Folsom marker.
  const pulse = (clock.elapsedTime % 2.2) / 2.2;
  ring.scale.setScalar(1 + pulse * 2.2);
  ringMat.opacity = 1 - pulse;

  if (scrollFade > 0.001 || state.explore) composer.render(dt);
}
frame();
