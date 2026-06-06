import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, readlinkSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const vscodeImages = ["button-dark.svg", "button-light.svg", "icon.png"]

describe("release archive symlinks", () => {
  test("VS Code image links resolve inside the repository", () => {
    for (const name of vscodeImages) {
      const link = path.join(root, "sdks/vscode/images", name)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(existsSync(path.resolve(path.dirname(link), readlinkSync(link)))).toBe(true)
    }
  })
})
