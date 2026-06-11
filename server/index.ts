/**
 * PLACEHOLDER server entry — proves the node-only toolchain compiles and that
 * the protocol + sim modules are importable headless. The server agent
 * REPLACES this with the real HTTP + WebSocket(/ws) + tick-loop implementation.
 *
 * Build: `npm run build:server` (tsc -p tsconfig.server.json → dist-server/).
 * Run:   `npm start` (node dist-server/server/index.js).
 */

import { SIM_HZ, SNAP_HZ, MAX_PLAYERS } from "../shared/protocol";
import { stepBotPaddle } from "../src/sim/bot";

// Touch an imported sim symbol so tsc proves it links under the node-only lib
// set (no DOM). The real server reuses these modules for the authoritative sim.
void stepBotPaddle;

console.log(
  `[four-ponq] placeholder server: SIM_HZ=${SIM_HZ} SNAP_HZ=${SNAP_HZ} MAX_PLAYERS=${MAX_PLAYERS}`
);
console.log("[four-ponq] replace server/index.ts with the real HTTP+WS server.");
