import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Pack } from "../../src/pack"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

type PackFixture = {
  name: string
  description?: string
  version?: string
  tier?: string
  skills?: unknown[]
  mcp?: Record<string, unknown>
  plugins?: string[]
  instructions?: string
  detect?: Array<{ files: string[]; message?: string }>
  skill_groups?: Record<string, unknown>
}

function yamlify(pack: PackFixture): string {
  const lines: string[] = [
    `name: ${pack.name}`,
    `description: ${pack.description ?? "Test pack"}`,
  ]
  if (pack.version) lines.push(`version: ${pack.version}`)
  if (pack.tier) lines.push(`tier: ${pack.tier}`)
  if (pack.plugins && pack.plugins.length > 0) {
    lines.push("plugins:")
    for (const p of pack.plugins) lines.push(`  - ${JSON.stringify(p)}`)
  }
  if (pack.skills && pack.skills.length > 0) {
    lines.push("skills:")
    for (const s of pack.skills) {
      if (typeof s === "string") lines.push(`  - ${s}`)
      else lines.push(`  - ${JSON.stringify(s)}`)
    }
  }
  if (pack.instructions) {
    lines.push("instructions: |")
    for (const l of pack.instructions.split("\n")) lines.push(`  ${l}`)
  }
  if (pack.detect && pack.detect.length > 0) {
    lines.push("detect:")
    for (const d of pack.detect) {
      lines.push(`  - files: ${JSON.stringify(d.files)}`)
      if (d.message) lines.push(`    message: ${JSON.stringify(d.message)}`)
    }
  }
  return lines.join("\n") + "\n"
}

async function writePackFile(dir: string, pack: PackFixture): Promise<string> {
  const packDir = path.join(dir, ".opencode", "packs", pack.name)
  await fs.mkdir(packDir, { recursive: true })
  const packFile = path.join(packDir, "PACK.yaml")
  await fs.writeFile(packFile, yamlify(pack), "utf-8")
  return packFile
}

describe("Pack schema + discovery", () => {
  test("discovers PACK.yaml from .opencode/packs/ and parses core fields", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, {
          name: "hello-pack",
          description: "A test pack",
          version: "1.2.3",
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const packs = await Pack.all()
        expect(packs.length).toBe(1)
        const hello = await Pack.get("hello-pack")
        expect(hello).toBeDefined()
        expect(hello!.name).toBe("hello-pack")
        expect(hello!.description).toBe("A test pack")
        expect(hello!.version).toBe("1.2.3")
      },
    })
  })

  test("rejects packs whose name fails the slug validator", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // Name with uppercase letters + underscores is invalid.
        // gray-matter/yaml would happily parse it — Pack's validator must reject it.
        await writePackFile(dir, { name: "Bad_Name" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const packs = await Pack.all()
        expect(packs.length).toBe(0)
      },
    })
  })

  test("Pack.dirs includes the scanned directory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, { name: "dir-pack" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dirs = await Pack.dirs()
        expect(dirs.some((d) => d.includes(path.join(".opencode", "packs")))).toBe(true)
      },
    })
  })
})

describe("Pack.detect", () => {
  test("surfaces packs whose detect.files match project contents", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, {
          name: "detect-pack",
          detect: [{ files: ["dbt_project.yml"], message: "Detected dbt" }],
        })
        await fs.writeFile(path.join(dir, "dbt_project.yml"), "name: test\n", "utf-8")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const detected = await Pack.detect()
        expect(detected.length).toBe(1)
        expect(detected[0].pack.name).toBe("detect-pack")
        expect(detected[0].matched).toContain("dbt_project.yml")
      },
    })
  })

  test("returns no matches when project has none of the detect files", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, {
          name: "no-match-pack",
          detect: [{ files: ["nonexistent.yml"] }],
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const detected = await Pack.detect()
        expect(detected.length).toBe(0)
      },
    })
  })
})

describe("Pack.activate / deactivate lifecycle", () => {
  test("activate adds pack name to .opencode/active-packs; deactivate removes it", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, { name: "lifecycle-pack" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Pack.activate("lifecycle-pack")
        const activeFile = path.join(tmp.path, ".opencode", "active-packs")
        const content = await fs.readFile(activeFile, "utf-8")
        expect(content.trim()).toBe("lifecycle-pack")

        const activeAfter = await Pack.active()
        expect(activeAfter.map((p) => p.name)).toContain("lifecycle-pack")

        await Pack.deactivate("lifecycle-pack")
        // When empty, deactivate unlinks the file entirely
        await expect(fs.access(activeFile)).rejects.toThrow()

        Pack.invalidate()
        const activeEmpty = await Pack.active()
        expect(activeEmpty.length).toBe(0)
      },
    })
  })

  test("multiple active packs coexist in .opencode/active-packs in insertion order", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, { name: "alpha-pack" })
        await writePackFile(dir, { name: "beta-pack" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Pack.activate("alpha-pack")
        await Pack.activate("beta-pack")
        const activeFile = path.join(tmp.path, ".opencode", "active-packs")
        const lines = (await fs.readFile(activeFile, "utf-8")).split("\n").filter(Boolean)
        expect(lines).toEqual(["alpha-pack", "beta-pack"])

        // Deactivating only the first should leave the second intact.
        await Pack.deactivate("alpha-pack")
        const remaining = (await fs.readFile(activeFile, "utf-8")).split("\n").filter(Boolean)
        expect(remaining).toEqual(["beta-pack"])
      },
    })
  })

  test("activate is idempotent — running twice does not duplicate the entry", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, { name: "idem-pack" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Pack.activate("idem-pack")
        await Pack.activate("idem-pack")
        const activeFile = path.join(tmp.path, ".opencode", "active-packs")
        const lines = (await fs.readFile(activeFile, "utf-8")).split("\n").filter(Boolean)
        expect(lines.length).toBe(1)
      },
    })
  })
})

describe("Pack.computeContentHash", () => {
  test("produces the same hash for identical content", () => {
    const a = "name: foo\ndescription: bar\n"
    const b = "name: foo\ndescription: bar\n"
    expect(Pack.computeContentHash(a)).toBe(Pack.computeContentHash(b))
  })

  test("produces different hashes when content differs", () => {
    const a = "name: foo\n"
    const b = "name: bar\n"
    expect(Pack.computeContentHash(a)).not.toBe(Pack.computeContentHash(b))
  })

  test("normalizes CRLF vs LF line endings — hash is stable across platforms", () => {
    const unix = "name: foo\ndescription: bar\n"
    const windows = "name: foo\r\ndescription: bar\r\n"
    expect(Pack.computeContentHash(unix)).toBe(Pack.computeContentHash(windows))
  })
})

describe("Pack manifest + integrity", () => {
  test("writeManifest roundtrips: loadPack detects no tamper when hash matches", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const packFile = await writePackFile(dir, { name: "manifest-pack", version: "1.0.0" })
        await Pack.writeManifest(path.dirname(packFile), packFile, {
          name: "manifest-pack",
          version: "1.0.0",
          tier: "community",
        })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("manifest-pack")
        expect(pack).toBeDefined()
        expect(pack!.trust?.manifest_present).toBe(true)
        expect(pack!.trust?.tamper_detected).toBe(false)
      },
    })
  })

  test("tamper_detected flips to true when PACK.yaml is edited after manifest is written", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const packFile = await writePackFile(dir, { name: "tamper-pack" })
        await Pack.writeManifest(path.dirname(packFile), packFile, {
          name: "tamper-pack",
          tier: "community",
        })
        // Modify content AFTER writing manifest — this is the tamper scenario.
        await fs.appendFile(packFile, "# injected\n", "utf-8")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("tamper-pack")
        expect(pack).toBeDefined()
        expect(pack!.trust?.tamper_detected).toBe(true)
      },
    })
  })

  test("manifest-vs-yaml metadata mismatch is flagged as tamper (name, version, tier)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const packFile = await writePackFile(dir, {
          name: "meta-pack",
          version: "1.0.0",
          tier: "community",
        })
        // Write a manifest whose `tier` disagrees with PACK.yaml. This simulates
        // an attempt to elevate trust by editing only the manifest, or to
        // downgrade the yaml after install.
        const matterMod = (await import("gray-matter")).default
        const raw = await fs.readFile(packFile, "utf-8")
        const parsed = matterMod("---\n" + raw + "\n---")
        await Pack.writeManifest(
          path.dirname(packFile),
          packFile,
          {
            name: (parsed.data.name as string) || "meta-pack",
            version: (parsed.data.version as string) || "1.0.0",
            tier: "verified", // ← manifest claims verified, yaml says community
          },
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("meta-pack")
        expect(pack).toBeDefined()
        // Metadata mismatch must trigger tamper detection even if content_hash matches.
        expect(pack!.trust?.tamper_detected).toBe(true)
      },
    })
  })

  test("packs without a manifest load without tamper detection (user-authored local packs)", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // No manifest written — simulates `pack create` scaffold.
        await writePackFile(dir, { name: "local-pack" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("local-pack")
        expect(pack).toBeDefined()
        expect(pack!.trust?.manifest_present).toBe(false)
        expect(pack!.trust?.tamper_detected).toBe(false)
      },
    })
  })
})

describe("Pack tier allowlist enforcement", () => {
  // Each test mutates env vars; clean up after.
  const prevVerified = process.env.ALTIMATE_CODE_VERIFIED_PACKS
  const prevBuiltin = process.env.ALTIMATE_CODE_BUILTIN_PACKS
  afterEach(() => {
    if (prevVerified === undefined) delete process.env.ALTIMATE_CODE_VERIFIED_PACKS
    else process.env.ALTIMATE_CODE_VERIFIED_PACKS = prevVerified
    if (prevBuiltin === undefined) delete process.env.ALTIMATE_CODE_BUILTIN_PACKS
    else process.env.ALTIMATE_CODE_BUILTIN_PACKS = prevBuiltin
  })

  test("pack claiming verified tier but not in allowlist is downgraded to community", async () => {
    delete process.env.ALTIMATE_CODE_VERIFIED_PACKS
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, { name: "faux-verified", tier: "verified" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("faux-verified")
        expect(pack).toBeDefined()
        expect(pack!.tier).toBe("community")
        expect(pack!.trust?.tier_downgraded).toBe(true)
        expect(pack!.trust?.original_tier).toBe("verified")
      },
    })
  })

  test("env-var allowlist (ALTIMATE_CODE_VERIFIED_PACKS) honors the verified claim", async () => {
    process.env.ALTIMATE_CODE_VERIFIED_PACKS = "real-verified,other-pack"
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, { name: "real-verified", tier: "verified" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("real-verified")
        expect(pack).toBeDefined()
        expect(pack!.tier).toBe("verified")
        expect(pack!.trust?.tier_downgraded).toBe(false)
      },
    })
  })

  test("built-in tier claim without allowlist entry is also downgraded", async () => {
    delete process.env.ALTIMATE_CODE_BUILTIN_PACKS
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await writePackFile(dir, { name: "faux-builtin", tier: "built-in" })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("faux-builtin")
        expect(pack).toBeDefined()
        expect(pack!.tier).toBe("community")
        expect(pack!.trust?.tier_downgraded).toBe(true)
      },
    })
  })
})

describe("Pack.allSkillsFromGroups", () => {
  test("returns the flat skills array when skill_groups is empty", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const packDir = path.join(dir, ".opencode", "packs", "flat-pack")
        await fs.mkdir(packDir, { recursive: true })
        await fs.writeFile(
          path.join(packDir, "PACK.yaml"),
          `name: flat-pack
description: flat skills
skills:
  - foo
  - bar
`,
          "utf-8",
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("flat-pack")
        expect(pack).toBeDefined()
        const flat = Pack.allSkillsFromGroups(pack!)
        expect(flat).toEqual(["foo", "bar"])
      },
    })
  })

  test("flattens skill_groups into a single list when present", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const packDir = path.join(dir, ".opencode", "packs", "grouped-pack")
        await fs.mkdir(packDir, { recursive: true })
        await fs.writeFile(
          path.join(packDir, "PACK.yaml"),
          `name: grouped-pack
description: grouped skills
skill_groups:
  core:
    activation: always
    skills:
      - a
      - b
  advanced:
    activation: detect
    skills:
      - c
`,
          "utf-8",
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pack = await Pack.get("grouped-pack")
        expect(pack).toBeDefined()
        const all = Pack.allSkillsFromGroups(pack!)
        expect(all.sort()).toEqual(["a", "b", "c"])
      },
    })
  })
})
