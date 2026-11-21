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
