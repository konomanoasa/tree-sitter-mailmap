import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";
import { createTreeSitter, grammars, root } from "../../scripts/tree-sitter.js";
import { parseCst } from "./cst.js";

const commandTimeoutMs = 30_000;
const commandMaxBufferBytes = 64 * 1024 * 1024;

const [{ name: language }] = grammars;

let runner;
let directory;
let configuration;
let library;
before(() => {
  runner = createTreeSitter();
  directory = runner.directory;
  configuration = runner.configPath;
  library = process.platform === "win32" ? "parser.dll" : "parser";
  run(["build", "--output", join(directory, library), root]);
});
after(() => runner?.close());

function run(args) {
  const result = runner.run(args, {
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: commandMaxBufferBytes,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

function applyEdits(source, edits) {
  let bytes = Buffer.from(source);
  for (const edit of edits) {
    const { byte, deleteBytes, insert } = edit;
    const description = JSON.stringify(edit);
    assert.ok(
      Number.isSafeInteger(byte) && byte >= 0,
      `invalid byte offset: ${description}`,
    );
    assert.ok(
      Number.isSafeInteger(deleteBytes) && deleteBytes >= 0,
      `invalid deletion length: ${description}`,
    );
    assert.equal(typeof insert, "string", `invalid insertion: ${description}`);
    assert.ok(
      byte <= bytes.length && deleteBytes <= bytes.length - byte,
      `edit exceeds ${bytes.length} source bytes: ${description}`,
    );
    bytes = Buffer.concat([
      bytes.subarray(0, byte),
      Buffer.from(insert),
      bytes.subarray(byte + deleteBytes),
    ]);
  }
  return bytes;
}

function parse(source, edits = []) {
  const path = join(directory, `input.${language}`);
  writeFileSync(path, source);
  const text = run([
    "parse",
    "--config-path",
    configuration,
    "--lib-path",
    join(directory, library),
    "--lang-name",
    language,
    "--encoding",
    "utf8",
    "--cst",
    path,
    ...(edits.length
      ? [
          "--edits",
          ...edits.map(
            ({ byte, deleteBytes, insert }) =>
              `${byte} ${deleteBytes} ${insert}`,
          ),
        ]
      : []),
  ]);
  return parseCst(text, applyEdits(source, edits));
}

function assertIncrementalEqualsFresh(initial, edits, source) {
  try {
    const incremental = parse(initial, edits);
    assert.deepEqual(incremental, parse(source));
    return incremental;
  } catch (error) {
    if (error instanceof Error)
      error.message += `\n${JSON.stringify({ initial, edits, source })}`;
    throw error;
  }
}

function assertEditHistory({ source, edits }) {
  for (let count = 1; count <= edits.length; count++) {
    const history = edits.slice(0, count);
    assertIncrementalEqualsFresh(source, history, applyEdits(source, history));
  }
}

export { applyEdits, assertEditHistory, assertIncrementalEqualsFresh, parse };
