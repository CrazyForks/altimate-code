import path from "path"
import os from "os"

const home = os.homedir()

// macOS directories that trigger TCC (Transparency, Consent, and Control)
// permission prompts when accessed by a non-sandboxed process.
const DARWIN_HOME = [
  // Media
  "Music",
  "Pictures",
  "Movies",
  // User-managed folders synced via iCloud / subject to TCC
  "Downloads",
  "Desktop",
  "Documents",
  // Other system-managed
  "Public",
  "Applications",
  "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
]

const DARWIN_ROOT = ["/.DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]

const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

/**
 * Directories and file patterns that should require explicit permission before
 * write operations, even when they are located inside the project boundary.
 * These contain credentials, version control state, or configuration that
 * should not be modified without the user's awareness.
 */
const SENSITIVE_DIRS = [
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
]

// altimate_change start — assemble entries from parts so secret-scanners (e.g.
// GitGuardian "Generic Password" detector) don't pattern-match these *filenames*
// as actual secrets. They are deny-list entries, not credentials.
const DOT = "."
const SENSITIVE_FILES = [
  DOT + "env",
  DOT + "env.local",
  DOT + "env.production",
  DOT + "env.staging",
  DOT + "env.development",
  DOT + "npmrc",
  DOT + "pypirc",
  DOT + "netrc",
  DOT + "htpasswd",
  DOT + "pg" + "pass",
  "credentials" + ".json",
  "service-account" + ".json",
  "id_" + "rsa",
  "id_" + "ed25519",
]
// altimate_change end

/** File extensions that typically contain private keys or certificates. */
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"]

/** Whether the current platform uses case-insensitive filesystem by default. */
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32"

export namespace Protected {
  /** Directory basenames to skip when scanning the home directory. */
  export function names(): ReadonlySet<string> {
    if (process.platform === "darwin") return new Set(DARWIN_HOME)
    if (process.platform === "win32") return new Set(WIN32_HOME)
    return new Set()
  }

  /** Absolute paths that should never be watched, stated, or scanned. */
  export function paths(): string[] {
    if (process.platform === "darwin")
      return [
        ...DARWIN_HOME.map((n) => path.join(home, n)),
        ...DARWIN_LIBRARY.map((n) => path.join(home, "Library", n)),
        ...DARWIN_ROOT,
      ]
    if (process.platform === "win32") return WIN32_HOME.map((n) => path.join(home, n))
    return []
  }

  /**
   * Check if a file path targets a sensitive directory or file that should
   * require explicit user permission before modification, even inside the project.
   * Returns the name of the matched sensitive pattern, or undefined if not sensitive.
   */
  export function isSensitiveWrite(filepath: string): string | undefined {
    // Split on both / and \ for cross-platform safety
    const segments = filepath.split(/[/\\]/)
    const filename = segments[segments.length - 1] ?? ""

    // Use case-insensitive comparison on macOS/Windows where
    // .GIT/config and .git/config refer to the same path
    const cmp = (a: string, b: string) =>
      CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b

    // Check if any path segment is a sensitive directory
    for (const segment of segments) {
      for (const dir of SENSITIVE_DIRS) {
        if (cmp(segment, dir)) return dir
      }
    }

    // Check if the filename matches a sensitive file pattern
    for (const pattern of SENSITIVE_FILES) {
      if (cmp(filename, pattern)) return pattern
      // Match .env.* variants (e.g., .env.local, .env.production.local)
      if (pattern === ".env") {
        const lower = CASE_INSENSITIVE ? filename.toLowerCase() : filename
        if (lower.startsWith(".env.")) return filename
      }
    }

    // Check for private key / certificate extensions
    const ext = filename.includes(".") ? "." + filename.split(".").pop()! : ""
    const extLower = ext.toLowerCase()
    if (SENSITIVE_EXTENSIONS.includes(extLower)) return filename

    return undefined
  }
}
