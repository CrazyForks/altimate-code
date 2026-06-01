import { afterEach, describe, expect, test } from "bun:test"
import { Critic } from "../../src/tool/critic"

afterEach(() => delete process.env["ALTIMATE_CRITIC_GATE"])

describe("Critic.gate", () => {
  test("disabled by default -> allow even a gated+denying call", async () => {
    const deny: Critic.Verifier = { verify: () => ({ ok: false, reason: "x" }) }
    expect((await Critic.gate("bash", {}, deny)).allow).toBe(true)
  })

  test("enabled: non-gated tool always allowed", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    expect((await Critic.gate("read", {}, Critic.ALLOW_ALL)).allow).toBe(true)
  })

  test("enabled: gated + allow-all verifier -> allow", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    expect((await Critic.gate("bash", { command: "ls" }, Critic.ALLOW_ALL)).allow).toBe(true)
  })

  test("enabled: gated + failing verifier -> block with feedback", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const deny: Critic.Verifier = { verify: () => ({ ok: false, reason: "unsafe SQL" }) }
    const g = await Critic.gate("sql_execute", { q: "drop" }, deny)
    expect(g.allow).toBe(false)
    expect(g.feedback).toContain("unsafe SQL")
  })

  test("enabled: verifier throws -> fail-open (allow)", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const boom: Critic.Verifier = {
      verify: () => {
        throw new Error("down")
      },
    }
    expect((await Critic.gate("bash", {}, boom)).allow).toBe(true)
  })

  test("enabled: verifier rejects (async throw) -> fail-open (allow)", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const boom: Critic.Verifier = {
      verify: async () => {
        throw new Error("async down")
      },
    }
    expect((await Critic.gate("bash", {}, boom)).allow).toBe(true)
  })

  test("isGated: side-effecting yes, reads no", () => {
    expect(Critic.isGated("bash")).toBe(true)
    expect(Critic.isGated("read")).toBe(false)
  })

  test("custom gated list overrides default", () => {
    expect(Critic.isGated("bash", ["sql_execute"])).toBe(false)
    expect(Critic.isGated("sql_execute", ["sql_execute"])).toBe(true)
  })
})

describe("Critic.detectDangerousBash — blocks catastrophic commands", () => {
  const dangerous: [string, string][] = [
    ["rm -rf /", "root"],
    ["rm -fr /", "flag order"],
    ["rm --recursive --force /", "long flags"],
    ["rm -rf /*", "root glob"],
    ["rm -rf ~", "home"],
    ["rm -rf ~/", "home slash"],
    ["rm -rf /etc", "system path"],
    ["rm -rf /usr/", "system path trailing slash"],
    ["rm  -rf   /", "extra whitespace"],
    ["sudo rm -rf /", "sudo prefix"],
    ["cd /tmp && rm -rf /home", "compound command, last rm"],
    [":(){ :|:& };:", "fork bomb"],
    ["rm -rf --no-preserve-root /", "no-preserve-root"],
    ["mkfs.ext4 /dev/sda", "mkfs on device"],
    ["dd if=/dev/zero of=/dev/sda bs=1M", "dd to raw disk"],
    ["echo x > /dev/sda", "redirect to raw disk"],
    ["chmod -R 777 /", "recursive chmod of root"],
    ["rm -rf / && rm -rf ./safe", "fatal rm first in a compound (not just the last rm)"],
    ["rm -rf ./safe && rm -rf /", "fatal rm last in a compound"],
    ["rm -rf /;", "separator glued to the target"],
    ["rm -rf / | tee log", "fatal rm before a pipe"],
    ["rm -rf / & echo bg", "backgrounded fatal rm"],
    // regression — glob wipe of a system dir (was a false negative)
    ["rm -rf /var/*", "glob wipe of /var"],
    ["rm -rf /etc/*", "glob wipe of /etc"],
    ["rm -rf /.", "root dot"],
    ["rm -rf /..", "root dotdot"],
    // regression — fully-qualified rm path (was a false negative)
    ["/bin/rm -rf /", "fully-qualified rm"],
    ["/usr/bin/rm -rf /", "fully-qualified rm in /usr/bin"],
    // regression — brace expansion of $HOME (was a false negative)
    ["rm -rf ${HOME}", "brace-expanded home"],
    // regression — long-form / glob chmod of root (was a false negative)
    ["chmod --recursive 777 /", "long-form recursive chmod of root"],
    ["chmod -R 777 /*", "recursive chmod of root glob"],
  ]
  for (const [cmd, label] of dangerous) {
    test(`blocks: ${label} — ${cmd}`, () => {
      expect(Critic.detectDangerousBash(cmd)).not.toBeNull()
    })
  }

  test("quote-stripping catches bash -c wrapped rm", () => {
    expect(Critic.detectDangerousBash(`bash -c "rm -rf /"`)).not.toBeNull()
    expect(Critic.detectDangerousBash(`r''m -rf /`)).not.toBeNull()
  })
})

describe("Critic.detectDangerousBash — allows ordinary commands (no false positives)", () => {
  const safe = [
    "ls -la",
    "echo hello",
    "rm -rf ./build",
    "rm -rf node_modules",
    "rm -rf /tmp/my-scratch-dir",
    "rm file.txt",
    "rm -r /tmp/x", // recursive but not forced
    "git rm -rf cached-thing",
    "dd if=/dev/zero of=./disk.img bs=1M count=10",
    "find . -name '*.log' -delete",
    "chmod -R 755 ./scripts",
    // workspace cleanup — common and safe; must NOT be blocked (no workdir context)
    "rm -rf *",
    "rm -rf .",
    "rm -rf ./",
    "rm -rf ./dist/*",
    "rm -rf /var/log/myapp", // scoped subpath of a system dir, not a glob wipe
    // rm mentioned as an argument, not the command — must NOT be blocked
    `git commit -m "fix: avoid rm -rf / in cleanup script"`,
    `echo "never run rm -rf /"`,
    "echo rm -rf /",
    "",
    "   ",
  ]
  for (const cmd of safe) {
    test(`allows: ${JSON.stringify(cmd)}`, () => {
      expect(Critic.detectDangerousBash(cmd)).toBeNull()
    })
  }

  test("non-string input is safe (null)", () => {
    expect(Critic.detectDangerousBash(undefined as any)).toBeNull()
    expect(Critic.detectDangerousBash(null as any)).toBeNull()
    expect(Critic.detectDangerousBash(42 as any)).toBeNull()
  })
})

describe("Critic.basicSafetyVerifier — the wired default", () => {
  test("blocks catastrophic bash with a reason", () => {
    const v = Critic.basicSafetyVerifier.verify("bash", { command: "rm -rf /" })
    expect((v as Critic.Verdict).ok).toBe(false)
    expect((v as Critic.Verdict).reason).toContain("recursive force-delete")
  })

  test("allows ordinary bash", () => {
    expect((Critic.basicSafetyVerifier.verify("bash", { command: "ls" }) as Critic.Verdict).ok).toBe(true)
  })

  test("allows non-bash gated tools (out of scope for the default heuristic)", () => {
    expect((Critic.basicSafetyVerifier.verify("sql_execute", { q: "DROP DATABASE x" }) as Critic.Verdict).ok).toBe(true)
    expect((Critic.basicSafetyVerifier.verify("write", { path: "/etc/passwd" }) as Critic.Verdict).ok).toBe(true)
  })

  test("missing/empty command arg is allowed", () => {
    expect((Critic.basicSafetyVerifier.verify("bash", {}) as Critic.Verdict).ok).toBe(true)
    expect((Critic.basicSafetyVerifier.verify("bash", { command: "" }) as Critic.Verdict).ok).toBe(true)
  })
})

describe("Critic.gate — end-to-end with the basic safety verifier", () => {
  test("enabled: catastrophic bash is blocked with actionable feedback", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const g = await Critic.gate("bash", { command: "rm -rf /" }, Critic.basicSafetyVerifier)
    expect(g.allow).toBe(false)
    expect(g.feedback).toContain("Blocked by altimate verifier")
    expect(g.feedback).toContain("retry")
  })

  test("enabled: ordinary bash passes", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const g = await Critic.gate("bash", { command: "echo hi" }, Critic.basicSafetyVerifier)
    expect(g.allow).toBe(true)
  })

  test("disabled: even catastrophic bash passes (default off, no behavior change)", async () => {
    const g = await Critic.gate("bash", { command: "rm -rf /" }, Critic.basicSafetyVerifier)
    expect(g.allow).toBe(true)
  })

  test("enabled: a hung verifier times out and fails open (never hangs the agent)", async () => {
    process.env["ALTIMATE_CRITIC_GATE"] = "1"
    const hang: Critic.Verifier = { verify: () => new Promise<Critic.Verdict>(() => {}) } // never resolves
    const start = performance.now()
    const g = await Critic.gate("bash", { command: "ls" }, hang, undefined, 50)
    expect(g.allow).toBe(true)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})
