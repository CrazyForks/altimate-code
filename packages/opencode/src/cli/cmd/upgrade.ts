import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { extractChangelog } from "../changelog"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade altimate to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        // altimate_change start — choco/scoop removed: altimate-code is not
        // distributed via chocolatey or scoop, and Installation.upgrade()
        // hard-fails these methods with a helpful error. Offering them in
        // `--help` would lead users into that failure path.
        choices: ["curl", "npm", "pnpm", "bun", "brew"],
        // altimate_change end
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`altimate is installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (Installation.VERSION === target) {
      prompts.log.warn(`altimate upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${Installation.VERSION} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // altimate_change start — choco/scoop now synthesize their own helpful
        // stderr ("altimate-code is not distributed via choco..."), so the old
        // `method === "choco" && stderr.includes("not running from an elevated
        // command shell")` branch was unreachable. Print the stderr directly.
        prompts.log.error(err.data.stderr)
        // altimate_change end
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")

    const changelog = extractChangelog(Installation.VERSION, target)
    if (changelog) {
      prompts.log.info("What's new:\n\n" + changelog)
    }

    prompts.outro("Done")
  },
}
