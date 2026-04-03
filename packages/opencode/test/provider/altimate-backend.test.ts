import { describe, test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Auth } from "../../src/auth"
import { ProviderID } from "../../src/provider/schema"

const PROVIDER_ID = ProviderID.make("altimate-backend")

afterEach(async () => {
  await Auth.remove(PROVIDER_ID).catch(() => {})
})

describe("altimate-backend provider loader", () => {
  test("loads from ~/.altimate/altimate.json when it exists", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json" }),
        )
      },
    })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    // Write fake credentials file
    const altimateDir = path.join(tmp.path, ".altimate")
    await fs.mkdir(altimateDir, { recursive: true })
    await Bun.write(
      path.join(altimateDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.getaltimate.com",
        altimateInstanceName: "mycompany",
        altimateApiKey: "test-key-123",
      }),
    )

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const p = providers["altimate-backend"]
          expect(p).toBeDefined()
          expect(p.options.baseURL).toBe("https://api.getaltimate.com/agents/v1")
          expect(p.options.apiKey).toBe("test-key-123")
          expect(p.options.headers["x-tenant"]).toBe("mycompany")
        },
      })
    } finally {
      if (originalHome !== undefined) {
        process.env.OPENCODE_TEST_HOME = originalHome
      } else {
        delete process.env.OPENCODE_TEST_HOME
      }
    }
  })

  test("strips trailing slashes from altimateUrl in baseURL", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json" }),
        )
      },
    })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    const altimateDir = path.join(tmp.path, ".altimate")
    await fs.mkdir(altimateDir, { recursive: true })
    await Bun.write(
      path.join(altimateDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.getaltimate.com///",
        altimateInstanceName: "tenant",
        altimateApiKey: "key",
      }),
    )

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const p = providers["altimate-backend"]
          expect(p).toBeDefined()
          // Trailing slashes should be stripped before appending /agents/v1
          expect(p.options.baseURL).toBe("https://api.getaltimate.com/agents/v1")
        },
      })
    } finally {
      if (originalHome !== undefined) {
        process.env.OPENCODE_TEST_HOME = originalHome
      } else {
        delete process.env.OPENCODE_TEST_HOME
      }
    }
  })

  test("falls back to auth store when config file is absent", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json" }),
        )
      },
    })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // No ~/.altimate/altimate.json exists — populate auth store instead
          await Auth.set(PROVIDER_ID, {
            type: "api",
            key: "https://api.getaltimate.com::mycompany::auth-key-456",
          })

          const providers = await Provider.list()
          const p = providers["altimate-backend"]
          expect(p).toBeDefined()
          expect(p.options.baseURL).toBe("https://api.getaltimate.com/agents/v1")
          expect(p.options.apiKey).toBe("auth-key-456")
          expect(p.options.headers["x-tenant"]).toBe("mycompany")
        },
      })
    } finally {
      if (originalHome !== undefined) {
        process.env.OPENCODE_TEST_HOME = originalHome
      } else {
        delete process.env.OPENCODE_TEST_HOME
      }
    }
  })

  test("cleans up stale auth when key format is invalid", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json" }),
        )
      },
    })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Set an invalid key format (missing :: separators)
          await Auth.set(PROVIDER_ID, {
            type: "api",
            key: "not-a-valid-altimate-key",
          })

          // First call triggers cleanup of stale auth entry
          await Provider.list()

          // After the loader cleaned up the invalid auth, subsequent calls
          // should not find the stale entry
          const auth = await Auth.get(PROVIDER_ID)
          expect(auth).toBeUndefined()
        },
      })
    } finally {
      if (originalHome !== undefined) {
        process.env.OPENCODE_TEST_HOME = originalHome
      } else {
        delete process.env.OPENCODE_TEST_HOME
      }
    }
  })

  test("returns autoload:false when neither credentials file nor auth store exists", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json" }),
        )
      },
    })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          // Without any credentials, the provider should not autoload
          expect(providers["altimate-backend"]).toBeUndefined()
        },
      })
    } finally {
      if (originalHome !== undefined) {
        process.env.OPENCODE_TEST_HOME = originalHome
      } else {
        delete process.env.OPENCODE_TEST_HOME
      }
    }
  })

  test("altimate-backend model registration includes correct defaults", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://altimate.ai/config.json" }),
        )
      },
    })
    const originalHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    const altimateDir = path.join(tmp.path, ".altimate")
    await fs.mkdir(altimateDir, { recursive: true })
    await Bun.write(
      path.join(altimateDir, "altimate.json"),
      JSON.stringify({
        altimateUrl: "https://api.getaltimate.com",
        altimateInstanceName: "tenant",
        altimateApiKey: "key",
      }),
    )

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const providers = await Provider.list()
          const p = providers["altimate-backend"]
          expect(p).toBeDefined()
          expect(p.name).toBe("Altimate")
          expect(p.source).toBe("custom")
          // Should have the altimate-default model
          expect(p.models["altimate-default"]).toBeDefined()
          expect(p.models["altimate-default"].name).toBe("Altimate AI")
          expect(p.models["altimate-default"].capabilities.toolcall).toBe(true)
        },
      })
    } finally {
      if (originalHome !== undefined) {
        process.env.OPENCODE_TEST_HOME = originalHome
      } else {
        delete process.env.OPENCODE_TEST_HOME
      }
    }
  })
})
