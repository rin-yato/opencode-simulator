---
"opencode-simulator": patch
---

Fix "serve-sim CLI not found" in the panel. The desktop app runs the GUI bundle with a `require` that cannot resolve packages, so the server now tells the window where it found serve-sim.
