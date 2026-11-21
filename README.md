# Roman Landscapes: An Interactive Atlas of Economy, Transport, and History

**Roman Landscapes** (`https://romanlandscapes.org`) is an open educational and scholarly digital atlas of the Roman world. It integrates published datasets on physical geography, urban settlements, terrestrial road networks, and maritime connectivity into a self-contained, offline-capable web application.

- **Author**: Jimmy Liu
- **Academic & Technical Guidance**: Fang, Xinjie and Classical Cat Digital Humanities Lab
- **Live Atlas**: https://romanlandscapes.org

## Current Release Scope (`v0.1` — Foundation & Transport Networks)

- **Dual Physical Base Maps (Natural Earth `10m`)**:
  - *Simple Geography*: High-contrast land and sea contours across `17°W–55°E, 15°N–63°N`.
  - *Natural Geography*: 258 pre-rendered WebP shaded relief tiles (`z0–z6`, viewable to `z7`), 232 major river centerlines, and 156 natural lakes (with modern artificial canals and reservoirs excluded).
- **Urban Settlements (Oxford Hanson Cities `v1.0`, 2016)**:
  - `1,388` cities and towns of the Roman world (`100 BCE–300 CE`), joined with native subtables for walled/built-up areas (`885`), civic status (`2,201`), public monuments (`9,472`), and source bibliography (`47`).
- **Terrestrial Road Network (Itiner-e `v1.3`, 2025)**:
  - `14,769` road segments transformed from `EPSG:3395` to `EPSG:4326`, retaining source epistemic certainty categories (`Certain`: 1,040; `Conjectured`: 12,952; `Hypothetical`: 777), 2 temporary ferry connectors, native date bounds and uncertainty margins, field definitions, and 627 BibTeX references.
- **Maritime & Ferry Network Model (Stanford ORBIS `v2`)**:
  - `584` modeled shipping and ferry routes (`coastal`: 441; `overseas`: 69; `slowover`: 69; `ferry`: 5) linked to `294` located port nodes and `7` documented unresolved node references.
- **Ancient Gazetteer Search (Pleiades `v4.1`, 2025)**:
  - `32,665` regional place records and `29,150` joined ancient and modern name variants, supporting ranked, diacritic-insensitive search (e.g., `Roma` / `Rhome`).
- **Complete Offline PWA Support**:
  - Deterministic build and checksum-verified local browser storage (Origin Private File System + Service Worker) enabling full offline inspection of all map modes, layers, search indexes, record details, and dataset documentation.

## Repository Structure

- `web/` — Vanilla HTML, CSS, and JavaScript ES module application source (with vendored MapLibre GL `6.14.0` and PMTiles `4.5.0`).
- `scripts/` — Deterministic data acquisition, coordinate transformation, PMTiles generation, verification, and local static server scripts.
- `data/source-manifest.json` & `data/vendor-lock.json` — Pinned upstream dataset versions, SHA-256 checksums, row accounting, and reuse notices.
- `docs/` — Data contract (`data-model.md`), dataset guide (`datasets.md`), and local build/verification runbook (`runbook.md`).
- `tests/` — Automated browser verification suites.

## Local Build & Verification

Requires Python 3.14+ in an isolated virtual environment (`.venv`) with dependencies pinned in `requirements.txt`:

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
