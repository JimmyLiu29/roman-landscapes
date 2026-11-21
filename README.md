# Roman Landscapes: An Interactive Atlas of Economy, Transport, and History

Explore the physical geography of the Roman world with two regional base maps.
Simple shows land and sea. Natural adds shaded terrain, rivers and lakes.
The atlas uses modern Natural Earth geography across 17°W–55°E, 15°N–63°N.

## Build and run

Use Python 3.13 and a project-local environment.

```sh
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
bin/acquire
bin/build
bin/verify-project
bin/serve
```

Open http://127.0.0.1:4173. Acquisition verifies the four source archives against
`data/source-manifest.json`. The build works offline once the inputs are present.
It clips and simplifies the physical vectors, derives the ocean from the land
geometry, and encodes the relief as 258 WebP tiles at zooms 0–6. View zoom 7
enlarges those tiles. The deployable website is in `dist/`.

MapLibre GL JS 6.14.0 and PMTiles JS 4.5.0 are served locally. Their licenses
and the bundled fflate notice are in `web/vendor/`. The Sources & map limits
panel credits Natural Earth and identifies the physical datasets.

In a browser with service workers and origin-private file storage, select
**Enable offline use** to save both maps. **Verify saved maps** checks each
local file against its SHA-256 digest. **Remove saved maps** clears the map
package from that browser.
