---
"@nozomioai/nia": patch
---

Fix `nia categories assign` so it works for repository sources, not just data sources. The command now uses the unified `PATCH /v2/sources/{id}` endpoint, which routes correctly to repos, docs, papers, and datasets in a single call.
