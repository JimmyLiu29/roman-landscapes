# Data model

The release manifest records the bounding box, content version, active scope and dataset IDs. Every file in the pack has a byte length and SHA-256. The catalog covers 49,711 source-qualified records. Each record identifies its detail shard. The four datasets use 250 gzip-compressed JSON shards, with at most 200 records per shard.

| Layer group | Geometry sources | Record identity |
|---|---|---|
| Settlements | 1,388 Hanson points | Native city key; related workbook rows keep their original row numbers |
| Terrestrial roads | 14,769 Itiner-e lines | Native InLine_FID; certainty and the temporary ferry flag are independent attributes |
| Maritime routes | 584 route lines and 294 port points | Separate ORBIS route and site IDs; seven additional sites have no mapped point |
| Gazetteer search | 32,665 representative points displayed on selection | Pleiades place ID; the 29,150 name rows retain their parent, native identifier and source row |

Each ORBIS route has separate source and target relations. Both are navigable in either direction. Hanson references point into the 47-row native bibliography where the source supports a match. Itiner-e details preserve the original XYZ geometry, coordinate system and attributes alongside geographic display lines and date uncertainty. Unknown dates and unlocated sites retain their source meanings. The reading view and original source fields are available separately.

The browser registry maps release scope keys to layer groups, files, styles and legend entries. One maritime switch controls both sources. Map clicks use a five-pixel tolerance, deduplicate source-qualified IDs and offer overlapping records in layer-priority order. The selected overlay accepts point and line geometries, including multipart lines. Layer visibility and base-map mode are saved in IndexedDB. Category controls appear when catalog records supply categories.

The map reads Hanson’s native Barrington Atlas Rank (`rank`), ORBIS route type (`t`) and Itiner-e certainty (`certainty`, from `Segment_s`). Map filters leave the complete search index available. All three groups default to Auto by zoom.

| Layer | Overview | Detail added on zooming in |
|---|---|---|
| Settlements | Ranks 1–2 (176) | Rank 3 at zoom 4.5 (992 total), then all 1,388 settlements at 5.6 |
| Terrestrial roads | Certain and conjectured (13,992), including two temporary ferry connectors | All 14,769 segments at zoom 5.0 |
| Maritime routes | Overseas, coastal and ferry (515) | All 584 routes at zoom 5.2, including 69 slowover routes |

At overview scales, faint conjectured roads and thin, light-blue coastal routes show regional connections. Certain roads are dark brown. Open-sea crossings and ferries use blue dashes. Point radii, outlines, line widths and line opacity vary continuously between zoom stops. Each layer can be locked to a manual tier, including the 14 Rank 1 metropoleis and the 74 direct open-sea and ferry routes. The 294 ports start hidden. Manual choices and port visibility persist across sessions. Hover and direct selection use the same visible candidates, ordered by layer, city rank and point distance. Map and overlap selections preserve the view. Search and relation selections locate their destinations.
