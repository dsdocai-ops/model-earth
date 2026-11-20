# ARCMUN 2027

Website for ARCMUN, a one-day Model United Nations conference hosted by Folsom High School on March 21, 2027.

`index.html` is the main (playful) version. Its opening is a scroll-driven fly-in: from a physically based 3D Earth centred on Folsom, through the clouds, down onto the campus (aerial photo courtesy of Folsom High School, placeholder), through an illustrated gate, and into the site. `formal.html` is an earlier alternate design that is no longer being updated.

The globe itself is rendered in the browser with three.js.

## What makes it look real

- **True sun position.** A solar ephemeris (`js/astro.js`) computes where the Sun is overhead *right now*, so the day–night line on the globe matches reality. A time slider and timelapse let you move it.
- **Ray-marched atmosphere.** Each pixel of the atmosphere shell traces a ray through a Rayleigh + Mie single-scattering model (16 view samples × 6 light samples) with a soft planet shadow. That produces the blue limb, the forward-scatter flare when the Sun is behind Earth, and the extinction of the surface beneath.
- **Physically reddened sunlight.** Surface and clouds are lit by sunlight attenuated with an airmass model, so the terminator turns gold and then red.
- **Ocean sun glint.** GGX specular with Fresnel on a water mask.
- **Relief.** A normal map generated from global elevation data.
- **Clouds** on their own shell, drifting, with offset shadows on the ground and density-derived relief.
- **City lights** that fade in after civil twilight and dim under cloud.
- **HDR pipeline.** Everything renders to a half-float target, gets a gentle bloom, then ACES tone mapping.
- 8K day and night textures are swapped in after load on GPUs and screens that can use them.

## Run locally

It's a static site with no build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Structure

```
index.html          page markup + import map
css/style.css       layout and UI
js/main.js          scene, controls, UI wiring, render loop
js/shaders.js       Earth, cloud and atmosphere GLSL
js/astro.js         subsolar point + lat/lon helpers
assets/textures/    processed Earth textures
vendor/three/       three.js r180 (MIT) and the addons used
```

## Credits

- Surface, night-light, cloud and star textures: [Solar System Scope](https://www.solarsystemscope.com/textures/) (CC BY 4.0), based on NASA imagery.
- Elevation and water data used for the normal map and ocean mask: three.js example planet textures.
- [three.js](https://threejs.org) (MIT).
