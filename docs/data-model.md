## Atlas data model

The v0.2 catalog contains 75,223 records from 16 active sources, including 23,385 economic evidence records and 324 historical events. Of 1,208 people, 414 have activity or event locations and 944 have biographical locations. The groups overlap by 150 people, leaving 794 with biographical locations only. The historical links reach 383 town nodes. The complete offline package occupies 57,448,450 bytes (54.8 MiB / 57.45 MB).

The release manifest declares twelve catalog datasets, three archive registries and the byte length and SHA-256 digest of every package file. The remaining four source entries describe physical geography. Across 382 detail shards, source-qualified IDs identify records. A separate occurrence ID joins a record to a map layer. Layer-specific bounds let a person have two different geographic footprints.

Each of the 23 rendering kinds defines a detail payload. Native fields preserve original values. Normalized dates distinguish uncertain bounds, source placeholders and stated precision. Relations have a direction, a role, a source and a textual basis. The 25,905 links include archive membership. Natural source order supports browsing without preferring mapped records.

Use `bin/acquire` (default `--scope all`) to verify the full inventory. Direct sources can be restored from their pinned URLs. Supply locked snapshots at the paths and SHA-256 digests in the source manifest. Two companion assets are tracked in the repository. Use `bin/acquire --scope foundation` for the direct foundation subset.
