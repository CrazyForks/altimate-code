import { describe, test, expect } from "bun:test"
import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

describe("file/index Filesystem patterns", () => {
  describe("File.read() - text content", () => {
    test("reads text file via Filesystem.readText()", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      await fs.writeFile(filepath, "Hello World", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("test.txt")
          expect(result.type).toBe("text")
          expect(result.content).toBe("Hello World")
        },
      })
    })

    test("reads with Filesystem.exists() check", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Non-existent file should return empty content
          const result = await File.read("nonexistent.txt")
          expect(result.type).toBe("text")
          expect(result.content).toBe("")
        },
      })
    })

    test("trims whitespace from text content", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      await fs.writeFile(filepath, "  content with spaces  \n\n", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("test.txt")
          expect(result.content).toBe("content with spaces")
        },
      })
    })

    test("handles empty text file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "empty.txt")
      await fs.writeFile(filepath, "", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("empty.txt")
          expect(result.type).toBe("text")
          expect(result.content).toBe("")
        },
      })
    })

    test("handles multi-line text files", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "multiline.txt")
      await fs.writeFile(filepath, "line1\nline2\nline3", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("multiline.txt")
          expect(result.content).toBe("line1\nline2\nline3")
        },
      })
    })
  })

  describe("File.read() - binary content", () => {
    test("reads binary file via Filesystem.readArrayBuffer()", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "image.png")
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      await fs.writeFile(filepath, binaryContent)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("image.png")
          expect(result.type).toBe("text") // Images return as text with base64 encoding
          expect(result.encoding).toBe("base64")
          expect(result.mimeType).toBe("image/png")
          expect(result.content).toBe(binaryContent.toString("base64"))
        },
      })
    })

    test("returns empty for binary non-image files", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "binary.so")
      await fs.writeFile(filepath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "binary")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("binary.so")
          expect(result.type).toBe("binary")
          expect(result.content).toBe("")
        },
      })
    })
  })

  describe("File.read() - Filesystem.mimeType()", () => {
    test("detects MIME type via Filesystem.mimeType()", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.json")
      await fs.writeFile(filepath, '{"key": "value"}', "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          expect(Filesystem.mimeType(filepath)).toContain("application/json")

          const result = await File.read("test.json")
          expect(result.type).toBe("text")
        },
      })
    })

    test("handles various image MIME types", async () => {
      await using tmp = await tmpdir()
      const testCases = [
        { ext: "jpg", mime: "image/jpeg" },
        { ext: "png", mime: "image/png" },
        { ext: "gif", mime: "image/gif" },
        { ext: "webp", mime: "image/webp" },
      ]

      for (const { ext, mime } of testCases) {
        const filepath = path.join(tmp.path, `test.${ext}`)
        await fs.writeFile(filepath, Buffer.from([0x00, 0x00, 0x00, 0x00]), "binary")

        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            expect(Filesystem.mimeType(filepath)).toContain(mime)
          },
        })
      }
    })
  })

  describe("File.list() - Filesystem.exists() and readText()", () => {
    test("reads .gitignore via Filesystem.exists() and readText()", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const gitignorePath = path.join(tmp.path, ".gitignore")
          await fs.writeFile(gitignorePath, "node_modules\ndist\n", "utf-8")

          // This is used internally in File.list()
          expect(await Filesystem.exists(gitignorePath)).toBe(true)

          const content = await Filesystem.readText(gitignorePath)
          expect(content).toContain("node_modules")
        },
      })
    })

    test("reads .ignore file similarly", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ignorePath = path.join(tmp.path, ".ignore")
          await fs.writeFile(ignorePath, "*.log\n.env\n", "utf-8")

          expect(await Filesystem.exists(ignorePath)).toBe(true)
          expect(await Filesystem.readText(ignorePath)).toContain("*.log")
        },
      })
    })

    test("handles missing .gitignore gracefully", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const gitignorePath = path.join(tmp.path, ".gitignore")
          expect(await Filesystem.exists(gitignorePath)).toBe(false)

          // File.list() should still work
          const nodes = await File.list()
          expect(Array.isArray(nodes)).toBe(true)
        },
      })
    })
  })

  describe("File.changed() - Filesystem.readText() for untracked files", () => {
    test("reads untracked files via Filesystem.readText()", async () => {
      await using tmp = await tmpdir({ git: true })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const untrackedPath = path.join(tmp.path, "untracked.txt")
          await fs.writeFile(untrackedPath, "new content\nwith multiple lines", "utf-8")

          // This is how File.changed() reads untracked files
          const content = await Filesystem.readText(untrackedPath)
          const lines = content.split("\n").length
          expect(lines).toBe(2)
        },
      })
    })
  })

  describe("Error handling", () => {
    test("handles errors gracefully in Filesystem.readText()", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "readonly.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const nonExistentPath = path.join(tmp.path, "does-not-exist.txt")
          // Filesystem.readText() on non-existent file throws
          await expect(Filesystem.readText(nonExistentPath)).rejects.toThrow()

          // But File.read() handles this gracefully
          const result = await File.read("does-not-exist.txt")
          expect(result.content).toBe("")
        },
      })
    })

    test("handles errors in Filesystem.readArrayBuffer()", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const nonExistentPath = path.join(tmp.path, "does-not-exist.bin")
          const buffer = await Filesystem.readArrayBuffer(nonExistentPath).catch(() => new ArrayBuffer(0))
          expect(buffer.byteLength).toBe(0)
        },
      })
    })

    test("returns empty array buffer on error for images", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "broken.png")
      // Don't create the file

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // File.read() handles missing images gracefully
          const result = await File.read("broken.png")
          expect(result.type).toBe("text")
          expect(result.content).toBe("")
        },
      })
    })
  })

  describe("shouldEncode() logic", () => {
    test("treats .ts files as text", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.ts")
      await fs.writeFile(filepath, "export const value = 1", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("test.ts")
          expect(result.type).toBe("text")
          expect(result.content).toBe("export const value = 1")
        },
      })
    })

    test("treats .mts files as text", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.mts")
      await fs.writeFile(filepath, "export const value = 1", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("test.mts")
          expect(result.type).toBe("text")
          expect(result.content).toBe("export const value = 1")
        },
      })
    })

    test("treats .sh files as text", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.sh")
      await fs.writeFile(filepath, "#!/usr/bin/env bash\necho hello", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("test.sh")
          expect(result.type).toBe("text")
          expect(result.content).toBe("#!/usr/bin/env bash\necho hello")
        },
      })
    })

    test("treats Dockerfile as text", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "Dockerfile")
      await fs.writeFile(filepath, "FROM alpine:3.20", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("Dockerfile")
          expect(result.type).toBe("text")
          expect(result.content).toBe("FROM alpine:3.20")
        },
      })
    })

    test("returns encoding info for text files", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.txt")
      await fs.writeFile(filepath, "simple text", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("test.txt")
          expect(result.encoding).toBeUndefined()
          expect(result.type).toBe("text")
        },
      })
    })

    test("returns base64 encoding for images", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "test.jpg")
      await fs.writeFile(filepath, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "binary")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await File.read("test.jpg")
          expect(result.encoding).toBe("base64")
          expect(result.mimeType).toBe("image/jpeg")
        },
      })
    })
  })

  describe("Path security", () => {
    test("throws for paths outside project directory", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(File.read("../outside.txt")).rejects.toThrow("Access denied")
        },
      })
    })

    test("throws for paths outside project directory", async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(File.read("../outside.txt")).rejects.toThrow("Access denied")
        },
      })
    })
  })
})

// ---------------------------------------------------------------------------
// File.list() — behavior (sorting, exclusions, gitignore marking)
// ---------------------------------------------------------------------------

describe("File.list() — behavior", () => {
  test("sorts directories before files, then alphabetically", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.mkdir(path.join(dir, "zebra-dir"), { recursive: true })
        await fs.mkdir(path.join(dir, "alpha-dir"), { recursive: true })
        await fs.writeFile(path.join(dir, "zebra.txt"), "z")
        await fs.writeFile(path.join(dir, "alpha.txt"), "a")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const nodes = await File.list()
        const names = nodes.map((n) => n.name)
        // Directories come first, then files — each group sorted alphabetically
        const dirNames = nodes.filter((n) => n.type === "directory").map((n) => n.name)
        const fileNames = nodes.filter((n) => n.type === "file").map((n) => n.name)
        expect(dirNames).toEqual(["alpha-dir", "zebra-dir"])
        expect(fileNames).toEqual(["alpha.txt", "zebra.txt"])
        // Directories appear before files in the combined list
        const firstFile = names.indexOf("alpha.txt")
        const lastDir = names.indexOf("zebra-dir")
        expect(lastDir).toBeLessThan(firstFile)
      },
    })
  })

  test("excludes .git and .DS_Store entries", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // .git already exists from git init; add .DS_Store
        await fs.writeFile(path.join(dir, ".DS_Store"), "")
        await fs.writeFile(path.join(dir, "visible.txt"), "ok")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const nodes = await File.list()
        const names = nodes.map((n) => n.name)
        expect(names).not.toContain(".git")
        expect(names).not.toContain(".DS_Store")
        expect(names).toContain("visible.txt")
      },
    })
  })

  test("sets ignored=true on nodes matching .gitignore patterns", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.writeFile(path.join(dir, ".gitignore"), "*.log\nbuild/\n")
        await fs.writeFile(path.join(dir, "app.ts"), "code")
        await fs.writeFile(path.join(dir, "debug.log"), "log data")
        await fs.mkdir(path.join(dir, "build"), { recursive: true })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const nodes = await File.list()
        const byName = Object.fromEntries(nodes.map((n) => [n.name, n]))
        expect(byName["app.ts"].ignored).toBe(false)
        expect(byName["debug.log"].ignored).toBe(true)
        expect(byName["build"].ignored).toBe(true)
        // .gitignore itself is present and not marked ignored
        expect(byName[".gitignore"]).toBeDefined()
        expect(byName[".gitignore"].ignored).toBe(false)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// File.status() — git change detection (modified, added, deleted)
// ---------------------------------------------------------------------------

describe("File.status() — git change detection", () => {
  test("detects modified files with correct line counts", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Trailing newlines avoid "no newline at end of file" noise in git diff
        await fs.writeFile(path.join(dir, "file.txt"), "line1\nline2\nline3\n")
        await $`git add file.txt && git commit -m "init"`.cwd(dir).quiet()
      },
    })

    // Modify the committed file: change line2→modified, add line4
    await fs.writeFile(path.join(tmp.path, "file.txt"), "line1\nmodified\nline3\nline4\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changes = await File.status()
        const modified = changes.find((c) => c.path === "file.txt")
        expect(modified).toBeDefined()
        expect(modified!.status).toBe("modified")
        // git diff --numstat reports exactly 2 added, 1 removed for this edit
        expect(modified!.added).toBe(2)
        expect(modified!.removed).toBe(1)
      },
    })
  })

  test("detects untracked files as added with line count", async () => {
    await using tmp = await tmpdir({ git: true })

    // File has no trailing newline — split("\n") yields 3 elements
    await fs.writeFile(path.join(tmp.path, "new-file.txt"), "line1\nline2\nline3")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changes = await File.status()
        const added = changes.find((c) => c.path === "new-file.txt")
        expect(added).toBeDefined()
        expect(added!.status).toBe("added")
        expect(added!.added).toBe(3)
        expect(added!.removed).toBe(0)
      },
    })
  })

  test("detects deleted files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "to-delete.txt"), "content\n")
        await $`git add to-delete.txt && git commit -m "init"`.cwd(dir).quiet()
      },
    })

    await fs.unlink(path.join(tmp.path, "to-delete.txt"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changes = await File.status()
        // Deleted files appear in both numstat (as "modified") and diff-filter=D
        // (as "deleted"); look for the "deleted" status entry specifically.
        const deleted = changes.find((c) => c.path === "to-delete.txt" && c.status === "deleted")
        expect(deleted).toBeDefined()
      },
    })
  })

  test("returns empty array for non-git project", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changes = await File.status()
        expect(changes).toEqual([])
      },
    })
  })

  test("returns empty array for clean working tree", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "clean.txt"), "committed")
        await $`git add clean.txt && git commit -m "init"`.cwd(dir).quiet()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const changes = await File.status()
        expect(changes).toEqual([])
      },
    })
  })
})
