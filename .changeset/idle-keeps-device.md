---
"opencode-simulator": minor
---

A session keeps its simulator after its turn ends or its panel closes. `sim_release` now only ends a hold. Another session takes an idle device over before a new one is created; a running turn, open panel, or hold protects a device.
