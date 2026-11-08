---
"opencode-simulator": minor
---

Agents now call `sim_idle` when they are done instead of releasing. The device keeps its session, stops being protected from other sessions, and its name changes from `· in use` to `· idle`; using it again makes it active. `sim_release` is replaced by `sim_idle`. Switching to another tab or session no longer destroys the simulator panel's stream: it stays alive, hidden, for up to 10 minutes, so coming back is instant instead of taking 5 to 10 seconds.
