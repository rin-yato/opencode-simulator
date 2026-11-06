/**
 * Which simulator the panel shows.
 *
 * Two sources know it:
 *
 * - the window, because `sim_start` told the window which device to open;
 * - the server, because it owns the session's claim.
 *
 * The window's copy wins. The server drops a claim as soon as a turn ends and
 * the panel closes, and an answer without a device is not proof that there is
 * nothing to show: the claim can be re-taken by the panel report that follows.
 * Wiping the window's copy on an empty answer is what made the panel say
 * "no simulator in this session" while the phone was booting.
 */
export const resolvePanelDevice = (
  cached: string | undefined,
  remote: string | undefined,
): string | undefined => cached ?? remote

/** How long the panel waits before asking the server again. */
export const DEVICE_POLL_MS = 1_500
