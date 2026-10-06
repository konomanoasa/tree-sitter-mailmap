import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";
import { createTreeSitter, grammars, root } from "../../scripts/tree-sitter.js";

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
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
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
  const bytes = applyEdits(source, edits);
  const starts = [0];
  for (const [offset, value] of bytes.entries())
    if (value === 10) starts.push(offset + 1);
  const nodes = [],
    ancestors = [];
  for (const line of text.split("\n")) {
    const location =
      /^([0-9]+):([0-9]+)( +)- ([0-9]+):([0-9]+)( +)(([a-z_]+): )?([a-z_]+|ERROR|MISSING|"[^"]*")/.exec(
        line,
      );
    if (!location) continue;
    const width = location[1].length + location[2].length + location[3].length;
    const endWidth = location[4].length + 1 + location[5].length;
    const depth = (location[6].length - Math.max(width - endWidth, 0) - 3) / 2;
    assert.ok(Number.isInteger(depth) && depth >= 0, line);
    ancestors.length = depth;
    nodes.push({
      kind: location[9].startsWith('"') ? JSON.parse(location[9]) : location[9],
      field: location[8] ?? null,
      start: starts[Number(location[1])] + Number(location[2]),
      end: starts[Number(location[4])] + Number(location[5]),
      parent: ancestors.at(-1) ?? null,
    });
    ancestors.push(nodes.length - 1);
  }
  assert.equal(nodes[0]?.kind, "document", text);
  assert.equal(nodes[0].end, bytes.length, text);
  assert.ok(
    !nodes.some(({ kind }) => kind === "ERROR" || kind === "MISSING"),
    text,
  );
  return nodes;
}

function issues(nodes) {
  return nodes.flatMap((node, index) => {
    if (node.kind !== "syntax_issue") return [];
    const outcome = nodes[index + 1],
      reason = nodes[index + 2];
    assert.equal(outcome.parent, index);
    assert.equal(reason.parent, index + 1);
    assert.deepEqual(
      [outcome.start, outcome.end, reason.start, reason.end],
      [node.start, node.end, node.start, node.end],
    );
    return [[outcome.kind, reason.kind, node.start, node.end]];
  });
}

function owners(nodes) {
  return nodes
    .filter(({ kind }) => kind === "syntax_issue")
    .map(({ parent }) => nodes[parent].kind);
}

function leaves(source, nodes) {
  const parents = new Set(nodes.map(({ parent }) => parent));
  return nodes.flatMap((node, index) =>
    parents.has(index)
      ? []
      : [
          [
            node.kind,
            Buffer.from(source).subarray(node.start, node.end).toString(),
          ],
        ],
  );
}

export { applyEdits, issues, leaves, owners, parse };
