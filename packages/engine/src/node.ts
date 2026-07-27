/**
 * Node-only utilities (real filesystem access) — kept out of the main
 * `@rift-engine/engine` entry so a browser bundler (packages/web) never
 * encounters `node:fs`/`node:path`. Import from `@rift-engine/engine/node`,
 * only from Node contexts (tests, a future CLI/server).
 */
export * from "./node/deck-file-loader.js";
