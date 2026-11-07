---
"opencode-simulator": minor
---

Rework how the panel starts serve-sim. A cold first boot no longer times out after 20 seconds and drops the stream to HTTP: the hub now waits as long as its process lives. The preview drops the Share button, the hub environment is cleaned, and slow startup phases are logged. The panel follows OpenCode's light and dark scheme, and switching it restyles the preview without reloading the stream.
