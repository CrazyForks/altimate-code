import { homedir } from "os"
import { join, resolve } from "path"
import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import { execFileSync } from "child_process"

type Config = {
  projectRoot: string
  pythonPath: string
  dbtIntegration: string
  queryLimit: number
}

function configDir() {
  return join(process.env.HOME || homedir(), ".altimate-code")
}

function configPath() {
  return join(configDir(), "dbt.json")
}

/**
 * Walk up from `start` to find the nearest directory containing dbt_project.yml.
 * Returns null if none found.
 */
export function findProjectRoot(start = process.cwd()): string | null {
  let dir = resolve(start)
  while (true) {
    if (existsSync(join(dir, "dbt_project.yml"))) return dir
    const parent = resolve(dir, "..")
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Discover the Python binary for a given project root.
 * Priority: ALTIMATE_CODE_VIRTUAL_ENV → project-local .venv → VIRTUAL_ENV → CONDA_PREFIX → which python3
 */
export function discoverPython(projectRoot: string): string {
  // ALTIMATE_CODE_VIRTUAL_ENV (injected by vscode-altimate-mcp-server — explicit user selection wins)
  const altVenv = process.env.ALTIMATE_CODE_VIRTUAL_ENV
  if (altVenv) {
    for (const bin of ["python3", "python"]) {
      const py = join(altVenv, "bin", bin)
      if (existsSync(py)) return py
    }
  }

  // Project-local venvs (uv, pdm, venv, poetry in-project, rye)
  for (const venvDir of [".venv", "venv", "env"]) {
    for (const bin of ["python3", "python"]) {
      const py = join(projectRoot, venvDir, "bin", bin)
      if (existsSync(py)) return py
    }
  }

  // VIRTUAL_ENV (set by activate scripts)
  const virtualEnv = process.env.VIRTUAL_ENV
  if (virtualEnv) {
    for (const bin of ["python3", "python"]) {
      const py = join(virtualEnv, "bin", bin)
      if (existsSync(py)) return py
    }
  }

  // CONDA_PREFIX
  const condaPrefix = process.env.CONDA_PREFIX
  if (condaPrefix) {
    for (const bin of ["python3", "python"]) {
      const py = join(condaPrefix, "bin", bin)
      if (existsSync(py)) return py
    }
  }

  // PATH-based discovery
  for (const cmd of ["python3", "python"]) {
    try {
      return execFileSync("which", [cmd], { encoding: "utf-8" }).trim()
    } catch {}
  }
  return "python3"
}

async function read(): Promise<Config | null> {
  const p = configPath()
  if (existsSync(p)) {
    const raw = await readFile(p, "utf-8")
    return JSON.parse(raw) as Config
  }
  // No config file — auto-discover from cwd so `altimate-dbt init` isn't required
  const projectRoot = findProjectRoot()
  if (!projectRoot) return null
  return {
    projectRoot,
    pythonPath: discoverPython(projectRoot),
    dbtIntegration: "corecommand",
    queryLimit: 500,
  }
}

async function write(cfg: Config) {
  const d = configDir()
  await mkdir(d, { recursive: true })
  await writeFile(join(d, "dbt.json"), JSON.stringify(cfg, null, 2))
}

export { read, write, configPath as path, type Config }
