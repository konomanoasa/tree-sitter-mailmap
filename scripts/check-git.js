import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evidence = JSON.parse(
  readFileSync(
    new URL("../test/fixtures/git-2.56.0.json", import.meta.url),
    "utf8",
  ),
);
const directory = mkdtempSync(join(tmpdir(), "mailmap-git-"));
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_COUNT: "0",
};

function git(arguments_, input) {
  const result = spawnSync("git", arguments_, {
    cwd: directory,
    env,
    input,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

function lines(values) {
  return Buffer.concat(
    values.flatMap((value) => [Buffer.from(value), Buffer.from("\n")]),
  );
}

try {
  assert.equal(git(["--version"]).stdout.toString().trim(), evidence.version);
  assert.equal(git(["init", "--quiet"]).status, 0);
  const path = join(directory, "input.mailmap");
  for (const { source, contacts, output, status, stderr } of evidence.cases) {
    writeFileSync(path, Buffer.from(source));
    const result = git(
      ["check-mailmap", `--mailmap-file=${path}`, "--stdin"],
      lines(contacts),
    );
    const context = JSON.stringify(source);
    assert.equal(result.status, status, context);
    assert.deepEqual(result.stderr, Buffer.from(stderr), context);
    assert.deepEqual(result.stdout, lines(output), context);
  }
  console.log(
    `${evidence.version}: ${evidence.cases.length} observations match`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
