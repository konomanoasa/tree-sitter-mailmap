import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createTreeSitter,
  grammars,
  packageName,
  root,
} from "../scripts/tree-sitter.js";

function decodeEntities(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function renderedCaptures(html, source) {
  const start = html.indexOf("<pre><code>");
  const end = html.indexOf("</code></pre>");
  assert.ok(start >= 0 && end >= start, html);
  const content = html.slice(start + "<pre><code>".length, end);
  const stack = [];
  const captures = [];
  let text = "";
  for (const part of content.matchAll(
    /<span class='([^']*)'>|<[/]span>|([^<]+)/g,
  )) {
    if (part[1] !== undefined) stack.push(part[1].replaceAll(" ", "."));
    else if (part[0] === "</span>") assert.notEqual(stack.pop(), undefined);
    else {
      const decoded = decodeEntities(part[2]);
      text += decoded;
      captures.push(
        ...Array(Buffer.byteLength(decoded)).fill(stack.at(-1) ?? ""),
      );
    }
  }
  assert.equal(stack.length, 0, "unclosed highlight span");
  assert.equal(
    text.replace(/\n$/, ""),
    source.replace(/\n$/, ""),
    "rendered source differs from the input",
  );
  return captures;
}

function createHighlighter({ directory, root, run, captureNames }) {
  const parserDirectory = join(directory, "parsers");
  mkdirSync(parserDirectory);
  symlinkSync(root, join(parserDirectory, "tree-sitter-test"), "junction");
  const configPath = join(directory, "highlight.json");
  const capturePath = join(directory, "captures.txt");
  writeFileSync(
    configPath,
    JSON.stringify({
      "parser-directories": [parserDirectory],
      theme: Object.fromEntries(
        captureNames.map((name, index) => [name, index + 17]),
      ),
    }),
  );
  writeFileSync(capturePath, `${captureNames.join("\n")}\n`);

  return (scope, source, valid = true) => {
    const path = join(directory, "highlight.txt");
    writeFileSync(path, source);
    if (valid) {
      const parsed = run(["parse", "--cst", "--scope", scope, path]);
      assert.doesNotMatch(parsed, /^[0-9: \t-]+•/m, parsed);
    }
    const captures = renderedCaptures(
      run([
        "highlight",
        "--check",
        "--captures-path",
        capturePath,
        "--config-path",
        configPath,
        "--html",
        "--layout",
        "fragment",
        "--style",
        "classes",
        "--scope",
        scope,
        path,
      ]),
      source,
    );
    for (const capture of captures) {
      assert.ok(
        capture === "" || captureNames.includes(capture),
        `unexpected final capture: ${capture}`,
      );
    }
    return captures;
  };
}

function assertCaptures(source, actual, ranges) {
  const bytes = Buffer.from(source);
  const expected = Array(bytes.length).fill("");
  let previousEnd = 0;
  for (const [start, end, capture] of ranges) {
    assert.ok(
      Number.isSafeInteger(start) && start >= previousEnd,
      "expected ranges must be ordered and disjoint",
    );
    assert.ok(
      Number.isSafeInteger(end) && end > start && end <= bytes.length,
      "expected range exceeds source bytes",
    );
    expected.fill(capture, start, end);
    previousEnd = end;
  }
  for (const [index, byte] of bytes.entries()) {
    if (byte !== 10)
      assert.equal(
        actual[index],
        expected[index],
        `byte ${index} in ${JSON.stringify(source)}`,
      );
  }
}

const captureNames = [
  "comment",
  "string",
  "string.special",
  "punctuation.bracket",
];
let highlight;

let directory;
let runner;
before(() => {
  directory = mkdtempSync(join(tmpdir(), `${packageName}-highlight-`));
  runner = createTreeSitter();
  highlight = createHighlighter({
    directory,
    root,
    run: assertCommand,
    captureNames,
  });
});
after(() => {
  try {
    runner?.close();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function assertCommand(arguments_) {
  const result = runner.run(arguments_, {
    timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Non-standard highlight captures/);
  return result.stdout;
}

const grammar = grammars[0];

const cases = [
  [
    "name and address",
    "Name <old>",
    [
      [0, 4, "string"],
      [5, 6, "punctuation.bracket"],
      [6, 9, "string.special"],
      [9, 10, "punctuation.bracket"],
    ],
  ],
  [
    "mapping roles share lexical captures",
    "<new> Old <old>",
    [
      [0, 1, "punctuation.bracket"],
      [1, 4, "string.special"],
      [4, 5, "punctuation.bracket"],
      [6, 9, "string"],
      [10, 11, "punctuation.bracket"],
      [11, 14, "string.special"],
      [14, 15, "punctuation.bracket"],
    ],
  ],
  [
    "comment terminates an incomplete address",
    "N <a# note",
    [
      [0, 1, "string"],
      [2, 3, "punctuation.bracket"],
      [3, 4, "string.special"],
      [4, 10, "comment"],
    ],
  ],
  [
    "missing separator has no capture",
    "N<a>",
    [
      [0, 1, "string"],
      [1, 2, "punctuation.bracket"],
      [2, 3, "string.special"],
      [3, 4, "punctuation.bracket"],
    ],
  ],
  [
    "ignored suffix stays uncolored",
    "N <a> ignored# c",
    [
      [0, 1, "string"],
      [2, 3, "punctuation.bracket"],
      [3, 4, "string.special"],
      [4, 5, "punctuation.bracket"],
      [13, 16, "comment"],
    ],
  ],
  [
    "Unicode uses byte ranges",
    "名 <a>",
    [
      [0, 3, "string"],
      [4, 5, "punctuation.bracket"],
      [5, 6, "string.special"],
      [6, 7, "punctuation.bracket"],
    ],
  ],
  ["name-only input retains highlighting", "Name", [[0, 4, "string"]]],
  ["leading layout is uncolored", " \t# note", [[2, 8, "comment"]]],
];
for (const [name, source, captures] of cases) {
  test(`mailmap: ${name}`, () =>
    assertCaptures(source, highlight(grammar.scope, source, false), captures));
}
