# Roman Landscapes: An Interactive Atlas of Economy, Transport, and History

**Roman Landscapes** (`https://romanlandscapes.org`) is an open educational and scholarly digital atlas of the Roman world. It connects terrain, settlements and transport networks with evidence for production, exchange and taxation. Readers can trace a find to its assemblage, a payment to its document, or a historical figure to the statement linking them to a town. The maps, archives and sources are available together offline.

MIT covers original code and documentation. See [Third-party notices](THIRD-PARTY-NOTICES.md) for the data and browser libraries.

- **Author**: Jimmy Liu
- **Academic & Technical Guidance**: Fang, Xinjie and Classical Cat Digital Humanities Lab
- **Live Atlas**: https://romanlandscapes.org

## Atlas v0.2

The v0.2 catalog contains 75,223 records from 16 active sources, including 23,385 economic evidence records and 324 historical events. Of 1,208 people, 414 have activity or event locations and 944 have biographical locations. The groups overlap by 150 people, leaving 794 with biographical locations only. The historical links reach 383 town nodes. The complete offline package occupies 57,448,450 bytes (54.8 MiB / 57.45 MB).

- **Dual Physical Base Maps (Natural Earth `10m`)**:
  - *Simple Geography*: High-contrast land and sea contours across `17°W–55°E, 15°N–63°N`.
  - *Natural Geography*: 394 pre-rendered WebP shaded relief tiles (`z0–z6`, viewable to `z7`), 318 river features, and 230 lake features (with modern artificial canals and reservoirs excluded).
- **Urban Settlements (Oxford Hanson Cities `v1.0`, 2016)**:
  - `1,388` cities and towns of the Roman world (`100 BCE–300 CE`), joined with native subtables for walled/built-up areas (`885`), civic status (`2,201`), public monuments (`9,472`), and source bibliography (`47`).
- **Terrestrial Road Network (Itiner-e `v1.3`, 2025)**:
  - `14,769` road segments transformed from `EPSG:3395` to `EPSG:4326`, retaining source epistemic certainty categories (`Certain`: 1,040; `Conjectured`: 12,952; `Hypothetical`: 777), 2 temporary ferry connectors, native date bounds and uncertainty margins, field definitions, and 627 BibTeX references.
- **Maritime & Ferry Network Model (Stanford ORBIS `v2`)**:
  - `584` modeled shipping and ferry routes (`coastal`: 441; `overseas`: 69; `slowover`: 69; `ferry`: 5) linked to `294` located port nodes and `7` documented unresolved node references.
- **Ancient Gazetteer Search (Pleiades `v4.1`, 2025)**:
  - `32,665` regional place records and `29,150` joined ancient and modern name variants, supporting ranked, diacritic-insensitive search (e.g., `Roma` / `Rhome`).
- **Economic evidence**. Explore mines, shipwrecks and cargo, amphora assemblages, Karanis tax rolls, olive oil and wine presses, stone quarries, and water-lifting technologies. Three archives preserve the source order of tax transactions, quarry entries and documentary water references. A collection anchor locates Karanis.
- **Historical events and people**. Trace Wikidata statements for Roman political and military history from 509 BCE to 565 CE. Separate layers show events, personal activity, and places of birth, death or burial.
- **Complete Offline PWA Support**:
  - Deterministic build and checksum-verified local browser storage (Origin Private File System + Service Worker) enabling full offline inspection of all map modes, layers, search indexes, record details, and dataset documentation.

## Acquisition

Use `bin/acquire` (default `--scope all`) to verify the full inventory. Direct sources can be restored from their pinned URLs. Supply locked snapshots at the paths and SHA-256 digests in the source manifest. Two companion assets are tracked in the repository. Use `bin/acquire --scope foundation` for the direct foundation subset.

## Repository Structure

- `web/` — Vanilla HTML, CSS, and JavaScript ES module application source (with vendored MapLibre GL `6.14.0` and PMTiles `4.5.0`).
- `scripts/` — Deterministic data acquisition, coordinate transformation, PMTiles generation, verification, and local static server scripts.
- `data/source-manifest.json` & `data/vendor-lock.json` — Pinned upstream dataset versions, SHA-256 checksums, row accounting, and reuse notices.
- `docs/` — Data contract (`data-model.md`), dataset guide (`datasets.md`), and local build/verification runbook (`runbook.md`).
- `tests/` — Automated browser verification suites.

## Local Build & Verification

The full build uses Python 3.13 in an isolated virtual environment (`.venv`) with dependencies pinned in `requirements.txt`:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --no-cache-dir -r requirements.txt
bin/acquire
bin/build
bin/verify-project
bin/serve
```

## Licensing & Attribution

Project-specific application source code and build scripts are released under the **MIT License**. Third-party scholarly datasets and cartographic resources retain their original terms, licenses, and citation requirements as documented in `data/source-manifest.json` and the in-app **Sources & Datasets Guide**.
