import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Snapshot } from "../snapshot"
import { Project } from "./project"
import { Vcs } from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
// altimate_change start — upstream_fix: bridge merge dropped the Truncate.init()
// call below. Without it the hourly Scheduler cleanup task for tool-output files
// (Global.Path.data/tool-output/tool_*) never registers, so the directory grows
// unboundedly. Restore main's call site.
import { Truncate } from "../tool/truncation"
// altimate_change end

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  File.init()
  FileWatcher.init()
  Vcs.init()
  Snapshot.init()
  // altimate_change start — upstream_fix: see header note for why this is here
  Truncate.init()
  // altimate_change end

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      Project.setInitialized(Instance.project.id)
    }
  })
}
