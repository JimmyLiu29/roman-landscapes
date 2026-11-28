## Dataset Guide

The v0.2 catalog contains 75,223 records from 16 active sources, including 23,385 economic evidence records and 324 historical events. Of 1,208 people, 414 have activity or event locations and 944 have biographical locations. The groups overlap by 150 people, leaving 794 with biographical locations only. The historical links reach 383 town nodes. The complete offline package occupies 57,448,450 bytes (54.8 MiB / 57.45 MB).

### 1. Physical Geography Base Maps — *Natural Earth* (`10m` Physical Vectors & Shaded Relief)

#### What Is This Dataset?
Before we can understand where Roman roads ran or why cities grew in particular valleys and bays, we need a clear picture of the physical landscape—mountains, plains, coastlines, major river systems, and inland lakes. **Natural Earth** is a public-domain cartographic dataset supported by the North American Cartographic Information Society (NACIS). In *Roman Landscapes*, Natural Earth `1:10,000,000` (`10m`) physical vector data and raster shaded relief (`SR_LR`) provide the geographic canvas across the entire study area (`17°W` to `55°E` longitude, `15°N` to `63°N` latitude), spanning from Britain and the Atlantic coast of Iberia to Mesopotamia and the Nile Valley.

#### What You Can See on the Map
The atlas offers two base-map modes that can be switched at any time without losing your current position or selected records:
- **Simple Geography Mode**: Displays clean land and sea contours (`land.geojson`, `ocean.geojson`, and coastline boundaries), designed for high-contrast inspection of dense road networks and settlement distributions.
- **Natural Geography Mode**: The study area intersects 258 relief tiles. The wider, buffered viewing extent contains 394 tiles in total. This mode displays the complete shaded relief set (`z0–z6`, viewable up to `z7`) together with **318 river features** and **230 lake features**, highlighting the mountain barriers (such as the Alps, Apennines, Taurus, and Atlas ranges) and river corridors (the Rhine, Danube, Rhône, Po, Tiber, and Nile) that structured ancient movement.

#### How Scholars Use It & Important Limitations
- **Modern Physical Reference, Not Ancient Coastline Reconstruction**: Natural Earth depicts modern physical geography. Over the past two millennia, river deltas have silted up (for example, around Ostia at the mouth of the Tiber, or Miletus and Ephesus in western Asia Minor), and local coastlines or marshlands have shifted. The base map serves as a consistent physical reference frame rather than a paleogeographic reconstruction of antiquity.
- **Exclusion of Modern Artificial Waterbodies**: Modern man-made features classified in Natural Earth as `Canal` or `Reservoir` (such as modern hydroelectric reservoirs on the Nile or Euphrates) are systematically filtered out within the buffered physical map (27°W–65°E, 8°N–67°N) (`45` lake polygons and `2` river segments excluded) so that modern engineering projects do not distort the ancient landscape.

---

### 2. Urban Settlements of the Roman World — *Oxford Hanson Cities Database* (`v1.0`, 2016)

#### What Is This Dataset?
Compiled by **J. W. Hanson** for the **Oxford Roman Economy Project (OxREP)** and published alongside his monograph *An Urban Geography of the Roman World, 100 BC to AD 300* (Archaeopress, 2016), this dataset is a catalog of urban settlements across the Roman Empire during the Late Republic and Principate.

Why do historians care so much about cities? In the Roman world, cities (*civitates*, *coloniae*, *municipia*, and Greek *poleis*) were the primary engines of administration, taxation, monumental architecture, and regional market exchange. Mapping where cities were concentrated—and how large they grew—reveals the stark regional diversity between heavily urbanized zones (such as central Italy, Baetica, Africa Proconsularis, and western Asia Minor) and more sparsely urbanized frontier provinces.

#### What Is Included in *Roman Landscapes*
The atlas integrates all **1,388 urban settlement records** from Hanson's database, joined with four related scholarly subtables from the original workbook:
- **Settlement Core (`1,388` cities)**: Ancient name, modern site name, Roman province, modern country, point coordinates, and chronological bounds.
- **Walled & Built-Up Areas (`885` area estimates)**: Measured or estimated urban surface area in hectares—a crucial proxy used by economic historians to estimate urban population sizes.
- **Civic Status (`2,201` status records)**: Recorded legal and administrative designations (such as *colonia*, *municipium*, provincial capital, or conventus center) across different historical periods.
- **Public Monuments (`9,472` monument entries)**: Attested civic infrastructure and monumental buildings—including forums, temples, theaters, amphitheaters, circuses, baths, aqueducts, and city walls.
- **Source Bibliography (`47` reference entries)**: Complete bibliographic key for the archaeological and historical sources cited across the catalog.

#### Methodological & Technical Notes
- **Urban Threshold**: Hanson's catalog focuses on settlements that functioned as urban centers between `100 BCE` and `300 CE`. It is not a census of every rural village (*vicus*), military fort (*castellum*), or private villa in the Roman Empire.
- **Preservation of Raw Subtable Structure**: Some cities have multiple area estimates or multiple monument entries reflecting different construction phases or scholarly sources. These rows are preserved intact rather than artificially deduplicated. One monument row in the original workbook whose key does not match a city record is retained in an inspectable `hanson:unmatched` record so that zero source data is silently dropped.

---

### 3. Terrestrial Road Networks — *Itiner-e: Roads of the Roman Empire* (`v1.3`, 2025)

#### What Is This Dataset?
Roman roads (*viae*) were the arteries of imperial governance, military deployment, postal communication (*cursus publicus*), and overland commerce. Published in *Scientific Data* (Nature Portfolio, 2025) by **Pau de Soto, Adam Pažout, Tom Brughmans, and colleagues** (Zenodo `17122148`, `v1.3`), **Itiner-e** is an open-access digital dataset of terrestrial road networks across the Roman Empire, synthesizing decades of archaeological surveys, milestone (*miliaria*) inscriptions, ancient itineraries (such as the *Antonine Itinerary* and the *Tabula Peutingeriana*), and regional historical maps.

#### What Is Included in *Roman Landscapes*
The atlas includes all **14,769 road network segments** from the frozen Itiner-e `v1.3` release, together with its full field definitions and BibTeX bibliography. Every segment preserves its original source attributes, including segment identifier (`InLine_FID`), road name or route classification, construction/use date fields, digitizer attribution, and bibliographic references.

Crucially, Itiner-e classifies every road segment by its **epistemic certainty**—how confident archaeologists and historians are about its exact physical course:
- **Certain (`1,040` segments)**: Well-documented segments digitized to within 50 m in mountainous terrain or 200 m on plains.
- **Conjectured (`12,952` segments)**: Identified segments with less documentation and lower spatial accuracy.
- **Hypothetical (`777` segments)**: Identified roads whose course is unlocated, variable or represented by parallel tracks, and proposed roads with insufficient evidence for a firmer classification.
- **Temporary Ferry Connectors (`2` segments, IDs `14767` and `14768`)**: Two short water-crossing links included in the upstream road network dataset, explicitly labeled in the atlas as ferry connectors rather than paved roads.

#### Methodological & Technical Notes
- **Coordinate System Normalization**: Although the accompanying publication describes the data in standard geographic coordinates (`EPSG:4326`), the raw GeoJSON payload in release `v1.3` is encoded in projected World Mercator meters (`EPSG:3395`) with 3D `XYZ` coordinates. Our build pipeline transforms the horizontal geometry to `EPSG:4326` for accurate web mapping and preserves the original XYZ vertices and CRS under Original source fields.
- **Sentinel Dates**: In the upstream dataset, numeric values of `0` and `9999` in the `Lower_Date` and `Upper_Date` columns are used as placeholder sentinels meaning "date unspecified / unknown," not the years `0` or year 9999. The atlas normalizes these sentinel bounds to `unknown` in human-readable summaries while keeping the raw fields visible for inspection. The field definitions also mark zero in either error margin as uncertain.

---

### 4. Maritime & Ferry Network Model — *Stanford ORBIS* (`v2` Public Geometry)

#### What Is This Dataset?
In the ancient world, moving heavy bulk goods—such as grain, wine, olive oil, marble, and timber—by sea was dramatically cheaper and faster than hauling them overland by ox-cart. The Mediterranean (*Mare Nostrum*), the Black Sea, and the Atlantic coastal waters formed the true highway system of the Roman economy.

Created by **Walter Scheidel, Elijah Meeks, and colleagues** at Stanford University, **ORBIS: The Stanford Geospatial Network Model of the Roman World** reconstructed the time and financial cost of travel across the Roman Empire around `200 CE`. In *Roman Landscapes*, we integrate the maritime and ferry route geometries from the public ORBIS `v2` repository (`sul-cidr/orbis_pub`).

#### What Is Included in *Roman Landscapes*
The maritime layer contains **584 sea and ferry routes** connecting **294 mapped port and coastal nodes** (plus **7 unlocated node references** retained for documentary completeness). The routes are categorized into four distinct operational classes from the ORBIS model:
- **Coastal routes (`441` routes)**: Short-haul cabotage segments hugging the coastline from port to port.
- **Overseas routes (`69` routes)**: Open-water deep-sea crossings across major basins.
- **Slow overseas routes (`69` routes)**: The source classifies these modeled crossings as slowover. One example runs from Ostia/Portus to Caralis.
- **Ferry crossings (`5` routes)**: Short strait or channel crossings connecting major land routes.

#### Methodological & Technical Notes
- **A Network Model, Not Observed Trade Flows**: Unlike a physical Roman road excavated by archaeologists, an ancient sea lane leaves no track on the water. The lines in the ORBIS maritime layer represent **modeled sailing corridors** used by historians to study connectivity and travel times. A dense cluster of lines into a port indicates high network connectivity in the Stanford model—**not** a direct measurement of how many ships or tons of cargo actually arrived there in a given year.
- **Mode Node Resolution & Unresolved Endpoints**: Following the upstream `orbis.js` specification, six-digit mode-specific node identifiers in the route table are stripped of their leading mode digit to resolve to five-digit site records in `o_sites.csv`, creating navigable links between shipping lanes and their origin/destination ports. Seven resolved five-digit site identifiers (`50457`, `50522`, `50572`, `50786`, `50789`, `50790`, and `50792`) referenced by route geometries do not appear in the upstream `o_sites.csv` table; they are preserved as explicit unresolved place records rather than assigned invented coordinates.
- **Why Only Maritime Routes from ORBIS?**: ORBIS also contains schematic overland and river links, but because *Itiner-e* provides a much higher-resolution archaeological road network (`14,769` segments vs. ORBIS's `628` schematic road edges), *Roman Landscapes* uses Itiner-e for land transport and ORBIS specifically for maritime connectivity.

---

### 5. Ancient Place Directory & Gazetteer — *Pleiades* (`v4.1`, 2025)

#### What Is This Dataset?
Anyone studying the ancient world quickly runs into the problem of names: a single settlement might be known by a Greek name, several Latin spelling variants, a Late Antique title, and a modern Arabic, Italian, Turkish, or French toponym (for example, *Roma* / *Rhome*, *Byzantium* / *Constantinopolis* / *Istanbul*, or *Lugdunum* / *Lyon*).

**Pleiades**—jointly supported by the Institute for the Study of the Ancient World (ISAW) at New York University and the Ancient World Mapping Center (AWMC) at UNC Chapel Hill—is a community gazetteer of ancient places. Derived originally from the *Barrington Atlas of the Greek and Roman World* (edited by Richard J. A. Talbert, 2000) and continuously expanded by scholars worldwide, Pleiades assigns each ancient place a permanent, stable numeric identifier (a Pleiades URI/ID) and catalogs its attested names, chronological periods, and coordinate precision.

#### What Is Included in *Roman Landscapes*
The atlas incorporates the **Pleiades `v4.1`** snapshot (`2025-05-28`), filtered to the geographic bounding box (`17°W–55°E, 15°N–63°N`):
- **Regional Gazetteer Places (`32,665` located places)**: Includes settlements, sanctuaries, forts, bridges, mines, battlefields, islands, and geographic features with representative coordinates inside the map bounds.
- **Attested Names & Variants (`29,150` joined name records)**: Historical spellings, ancient Greek and Latin transliterations, and modern place names linked to their parent Pleiades place records (preserving all distinct attested forms even where upstream rows share a URI).

#### How It Functions in the Atlas
- **Searchable Gazetteer Backbone (Not a Cluttered Permanent Overlay)**: Turning on 32,665 points at once would turn the map into an unreadable solid block of ink. Instead, Pleiades serves as a **searchable gazetteer directory and cross-reference anchor**. You can search for any ancient name, variant spelling (such as `Roma` or `Rhome`), or Pleiades ID in the search box; selecting a Pleiades record flies the map to its representative point, highlights its location, and displays its full provenance and alias list.
- **Disciplined Cross-Dataset Linking**: In *Roman Landscapes*, Pleiades IDs act as an explicit bridge only where a dataset natively supplies a Pleiades reference or a documented scholarly crosswalk exists. We never force automatic "nearest-neighbor" joins between Hanson cities, Itiner-e road segments, and Pleiades entries based merely on coordinate proximity.

One additional source-identified place, `pleiades:114765`, is available from linked economic records. It has no representative coordinate.

---

### 6. Mining and Metals — *OxREP Mines Database* (`v3.0`, 2025)

Andrew Wilson’s inventory brings together 1,399 records of mineral extraction. Compare the distribution of workings by metal or follow a site through its mineID, Domergue number or Romanian RAN identifier. The atlas locates 1,388 records and retains the other 11 in search.

Read the earliest and latest proposed opening and closing dates separately. A range bounds the evidence for a working. It cannot establish continuous exploitation or the volume of ore produced.

---

### 7. Shipwrecks and Cargo — *OxREP Shipwrecks Database* (`v2.1`, 2017)

The 1,818 wreck records document vessels and cargo at sea. The atlas preserves the native wreck, Parker and Strauss identifiers. Wreck IDs link 887 amphora entries to wrecks, while location IDs link 2,544 site objects. Three objects without a secure match remain in a separate source note. Two shifted spreadsheet rows retain their original values alongside the normalized fields.

Only 1,584 wrecks have a mapped location, and plotted positions may be approximate. Recovery, excavation and publication affect which wrecks enter the inventory. Concentrations of finds alone cannot establish the volume of traffic on a route.

---

### 8. Amphorae and Commodities — *Roman Amphorae Assemblages Database* (`v1.0.0`, 2021)

The RAAD workbook organizes transport containers by type and findspot. Its 1,469 populated type-by-site observations belong to 79 assemblages. The map locates the assemblage, and the detail view connects its observations to the source typology and concordance. Seventy assemblages carry an explicit Pleiades link.

An assemblage total and its component observations describe the same finds. Adding them counts the material twice. A vessel type provides evidence for the movement of containers, with the identification of their contents dependent on the source.

---

### 9. Taxation at Karanis — *OxREP Karanis Tax Rolls* (`v2.0`, 2024)

The archive preserves 17,053 transactions in source order. The P.Mich. identifier and line locate a payment in its document. A single map anchor locates the collection at Karanis. The rolls supply no coordinates for individual payments.

The two corrected drachma fields preserve distinct readings of the amount. Three regnal-year cells retain the anomalous spreadsheet value 42339 and carry a warning in the detail view.

---

### 10. Olive Oil and Wine Production — *OxREP Olive Oil and Wine Presses* (`v1.0`, 2015)

The database describes agricultural processing installations. Its 232 grouped records represent 760 presses. The 225 mapped groups locate reported evidence, and the remaining seven can be inspected in search. A group may contain several presses.

Counts measure the installations reported at each site. Estimating production would also require evidence for capacity, use and chronology. Open date bounds retain the uncertainty of the source.

---

### 11. Stone Extraction — *OxREP Gazetteer of Stone Quarries in the Roman World* (`v1.0`, 2013)

The archive contains 792 quarry records. Site names, materials and provinces allow comparison of stone extraction across regions. Browsing follows the source order so that a reader can trace an entry back to the gazetteer.

The retained table supplies neither coordinates nor external place identifiers. The atlas preserves every record in the archive and makes no spatial join from a place name alone.

---

### 12. Water-Lifting Technologies — *OxREP Water-Lifting Technology Database* (`v1.0`, 2008)

The archive brings together 622 documentary references to water-lifting technology. Document and line locators lead back to individual attestations. Twenty-five supporting place and area records retain the source’s own links. Several references may concern the same installation.

The retained Greek term column contains question marks. The atlas flags the affected readings and leaves reconstruction to a reader consulting the cited text. Document places carry no equipment coordinates.

---

### 13. Political and Military History — *Wikidata* (12 October 2026 snapshot)

The historical selection covers 509 BCE–565 CE, from the Roman Republic through the reign of Justinian I. It links 324 events and 1,208 people to 383 towns using the entity revisions in the 12 October 2026 Wikidata snapshot. Each town link identifies its role and the supporting statements. Qualifiers, references and supporting dating events can be inspected in the detail view.

Activity or event associations locate 414 people, while birth, death or burial associations locate 944. The overlap is 150 people. A command relationship can associate a person with a town without establishing physical presence there. An event used to date a career may lie outside the mapped selection.

#### Scope of interpretation

Individual finds, documentary references, modeled routes and historical associations measure different things. Compare their locations and dates within the limits stated for each source.
