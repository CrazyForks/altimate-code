import { homedir } from "os"
import { join } from "path"
import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"

const dir = join(homedir(), ".altimate-code")
const path = join(dir, "dbt.json")

type Config = {
  projectRoot: string
  pythonPath: string
  dbtIntegration: string
  queryLimit: number
}

async function read(): Promise<Config | null> {
  if (!existsSync(path)) return null
  const raw = await readFile(path, "utf-8")
  return JSON.parse(raw) as Config
}

async function write(cfg: Config) {
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(cfg, null, 2))
}

export { read, write, path, type Config }
