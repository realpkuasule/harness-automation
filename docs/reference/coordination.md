# Remote coordination (v3 foundation)

`harness-automation coordination status` reports the local configuration state. Without a separately approved, qualified production configuration, every mutation command fails closed and performs no remote write.

The implementation uses one configured internal ref and exact-old-SHA Git `--force-with-lease` CAS. It provides only `coordinated` semantics; it cannot prevent an actor from bypassing Harness with direct Git access. The v1 record schema is [coordination-v1.schema.json](../api/coordination-v1.schema.json).
