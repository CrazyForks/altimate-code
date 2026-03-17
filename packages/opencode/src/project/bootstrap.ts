import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { initConversationLogger } from "../session/conversation-logger"
import fs from "fs/promises"
import path from "path"
import os from "os"


function getClaudeDir(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude")
  }
  return path.join(os.homedir(), ".claude")
}

// Injected at build time by build.ts via Bun's define option.
// Must be referenced as bare identifiers — dynamic globalThis lookup does not work with define.
declare const ALTIMATE_VALIDATE_SKILL_MD: string
declare const ALTIMATE_VALIDATE_BATCH_PY: string
declare const ALTIMATE_LOGGER_HOOK_PY: string

async function readAsset(defined: string, fallbackRelPath: string): Promise<string> {
  if (typeof defined === "string" && defined) return defined
  return fs.readFile(path.join(import.meta.dir, fallbackRelPath), "utf-8")
}

async function mergeStopHook(settingsPath: string, hookCommand: string): Promise<void> {
  let settings: Record<string, any> = {}
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"))
  } catch {
    // Missing or unparseable — start fresh
  }

  if (!settings.hooks) settings.hooks = {}
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = []

  const alreadyExists = settings.hooks.Stop.some(
    (entry: any) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h: any) => h.command === hookCommand),
  )
  if (!alreadyExists) {
    settings.hooks.Stop.push({
      matcher: "",
      hooks: [{ type: "command", command: hookCommand }],
    })
  }

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
}

async function ensureValidationSetup(): Promise<void> {
  try {
    const claudeDir = getClaudeDir()
    const loggingEnabled = process.env.ALTIMATE_LOGGER_DISABLED !== "true"

    // Always install /validate skill (SKILL.md + batch_validate.py)
    const validateSkillDir = path.join(claudeDir, "skills", "validate")
    await fs.mkdir(validateSkillDir, { recursive: true })
    await fs.writeFile(
      path.join(validateSkillDir, "SKILL.md"),
      await readAsset(ALTIMATE_VALIDATE_SKILL_MD, "../skill/validate/SKILL.md"),
    )
    await fs.writeFile(
      path.join(validateSkillDir, "batch_validate.py"),
      await readAsset(ALTIMATE_VALIDATE_BATCH_PY, "../skill/validate/batch_validate.py"),
    )

    // Install hook + register in settings.json only when logging is enabled
    if (loggingEnabled) {
      const hooksDir = path.join(claudeDir, "hooks")
      await fs.mkdir(hooksDir, { recursive: true })
      const hookPath = path.join(hooksDir, "altimate_logger_hook.py")
      await fs.writeFile(
        hookPath,
        await readAsset(ALTIMATE_LOGGER_HOOK_PY, "../skill/validate/logger_hook.py"),
      )
      await mergeStopHook(
        path.join(claudeDir, "settings.json"),
        `uv run --with requests "${hookPath}"`,
      )
    }
  } catch {
    // Never block startup on setup failure
  }
}

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await ensureValidationSetup()
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()
  if (process.env.ALTIMATE_LOGGER_DISABLED !== "true") {
    initConversationLogger()
  }

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}