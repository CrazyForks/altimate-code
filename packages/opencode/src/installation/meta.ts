// OPENCODE_VERSION + OPENCODE_CHANNEL globals are declared in installation/index.ts.
export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
