import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../scripts/tree-sitter.js";
import { parseCorpus } from "./support/corpus.js";
import { issues, leaves, owners, parseCst } from "./support/cst.js";
import {
  applyEdits,
  assertEditHistory,
  assertIncrementalEqualsFresh,
  parse,
} from "./support/parser.js";

const corpusDirectory = join(root, "test/corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  assert.ok(file.endsWith(".txt"), `unexpected corpus entry: ${file}`);
  const entries = parseCorpus(
    readFileSync(join(corpusDirectory, file), "utf8"),
  );
  for (const { name, source } of entries) {
    test(`mailmap: corpus source coverage issue structure and fresh determinism: ${file}: ${name}`, () => {
      const tree = parse(source);
      issues(tree);
      for (const node of tree.filter(({ kind }) => kind === "syntax_issue")) {
        assert.equal(node.field, "issue");
      }
      assert.deepEqual(parse(source), tree);
    });
  }
}

test("mailmap: corpus inputs retain BOM NUL whitespace and line endings", () => {
  const text = [
    "==================\nEmpty\n==================\n\n---\n(document)\n\n",
    "==================\nLayout\n:cst\n==================\n",
    "\uFEFF \t\v\f\r\na text\n\n\n---\nignored output\n\n",
    "==================\nNUL\n:cst\n==================\n",
    "\0=\0\n---\nignored output\n\n",
    "==================\nFinal CR\n:cst\n==================\n",
    "a text\r\r\n---\nignored output\n",
  ].join("");
  assert.deepEqual(parseCorpus(text), [
    { name: "Empty", source: "" },
    { name: "Layout", source: "\uFEFF \t\v\f\r\na text\n\n" },
    { name: "NUL", source: "\0=\0" },
    { name: "Final CR", source: "a text\r" },
  ]);
});

test("mailmap: corpus input reader rejects unsupported conditions and framing", () => {
  for (const text of [
    "not a corpus file",
    "==================\nUnclosed header\n",
    "==================\nSkipped\n:skip\n==================\na text\n---\n",
    "==================\nNo separator\n==================\na text\n",
  ]) {
    assert.throws(() => parseCorpus(text), { code: "ERR_ASSERTION" }, text);
  }
});

test("mailmap: byte-only names retain their roles and report missing separators independently", () => {
  const cases = [
    [
      Buffer.from([255]),
      [
        ["invalid_syntax", "invalid_encoding", 0, 1],
        ["incomplete_syntax", "missing_commit_email", 1, 1],
      ],
      ["name", "mapping"],
      [["canonical_name", 0, 1]],
      [],
    ],
    [
      Buffer.from([32, 9, 255, 32, 13, 10]),
      [
        ["invalid_syntax", "invalid_encoding", 2, 3],
        ["invalid_syntax", "missing_commit_email", 4, 4],
      ],
      ["name", "mapping"],
      [["canonical_name", 2, 3]],
      [],
    ],
    [
      Buffer.from([255, ...Buffer.from(" <old>")]),
      [["invalid_syntax", "invalid_encoding", 0, 1]],
      ["name"],
      [["canonical_name", 0, 1]],
      [],
    ],
    [
      Buffer.from([255, ...Buffer.from("<old>")]),
      [
        ["invalid_syntax", "invalid_encoding", 0, 1],
        ["invalid_syntax", "missing_name_separator", 1, 1],
      ],
      ["name", "mapping"],
      [["canonical_name", 0, 1]],
      [],
    ],
    [
      Buffer.from([78, 255, ...Buffer.from("<old>")]),
      [
        ["invalid_syntax", "invalid_encoding", 1, 2],
        ["invalid_syntax", "missing_name_separator", 2, 2],
      ],
      ["name", "mapping"],
      [["canonical_name", 0, 2]],
      [["name_text", "N"]],
    ],
    [
      Buffer.from([...Buffer.from("<new> "), 255, ...Buffer.from("<old>")]),
      [
        ["invalid_syntax", "invalid_encoding", 6, 7],
        ["invalid_syntax", "missing_name_separator", 7, 7],
      ],
      ["name", "mapping"],
      [["commit_name", 6, 7]],
      [],
    ],
    [
      Buffer.from([...Buffer.from("<new> "), 255, ...Buffer.from(" <old>")]),
      [["invalid_syntax", "invalid_encoding", 6, 7]],
      ["name"],
      [["commit_name", 6, 7]],
      [],
    ],
  ];
  for (const [
    source,
    expected,
    expectedOwners,
    expectedNames,
    expectedText,
  ] of cases) {
    const context = source.toString("hex");
    const nodes = parse(source);
    assert.equal(nodes[1].kind, "mapping", context);
    assert.deepEqual(issues(nodes), expected, context);
    assert.deepEqual(owners(nodes), expectedOwners, context);
    assert.deepEqual(
      nodes
        .filter(({ kind }) => kind === "name")
        .map(({ field, start, end }) => [field, start, end]),
      expectedNames,
      context,
    );
    assert.deepEqual(
      leaves(source, nodes).filter(([kind]) => kind === "name_text"),
      expectedText,
      context,
    );
    for (const node of nodes.filter(({ kind }) => kind === "syntax_issue"))
      assert.equal(node.field, "issue", context);
  }
});

test("mailmap: invalid UTF-8 runs are grouped within each textual owner", () => {
  const invalidBytes = Buffer.from([255, 128, 254]);
  const contexts = [
    ["name", "N", " <a>"],
    ["email", "N <", ">"],
    ["comment", "#", ""],
    ["ignored_suffix", "\0", ""],
    ["ignored_suffix", "N <a> ", ""],
  ];
  for (const [owner, prefix, suffix] of contexts) {
    const source = Buffer.concat([
      Buffer.from(prefix),
      invalidBytes,
      Buffer.from(suffix),
    ]);
    const start = Buffer.byteLength(prefix);
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), [
      [
        "invalid_syntax",
        "invalid_encoding",
        start,
        start + invalidBytes.length,
      ],
    ]);
    assert.deepEqual(owners(nodes), [owner]);
  }
});

for (const [owner, prefix, suffix] of [
  ["name", "Na", "me <a>"],
  ["email", "Name <", "a>"],
  ["comment", "# a", "b"],
]) {
  test(`mailmap: splitting the character after a decoding failure merges the issue in ${owner}`, () => {
    const offset = Buffer.byteLength(prefix);
    const source = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([255]),
      Buffer.from(`é${suffix}`),
    ]);
    const edits = [{ byte: offset + 2, deleteBytes: 1, insert: "" }];
    const incremental = assertIncrementalEqualsFresh(
      source,
      edits,
      applyEdits(source, edits),
    );
    assert.deepEqual(
      incremental
        .filter(({ kind }) => kind === "syntax_issue")
        .map(({ start, end }) => [start, end]),
      [[offset, offset + 2]],
    );
  });
}

test("mailmap: edits inside a boundary character merge adjacent decoding issues", () => {
  for (const bom of ["", "\uFEFF"]) {
    for (const character of ["¿", "€", "😀"]) {
      for (const [owner, prefix, suffix] of [
        ["name", "N", " <old>"],
        ["email", "N <", ">"],
        ["comment", "#", ""],
        ["ignored_suffix", "N <old> tail", ""],
        ["ignored_suffix", "\0", ""],
      ]) {
        const head = Buffer.from(bom + prefix);
        const encoded = Buffer.from(character);
        const source = Buffer.concat([
          head,
          Buffer.from([255]),
          encoded,
          Buffer.from([255]),
          Buffer.from("x".repeat(encoded.length - 2) + suffix),
        ]);
        const edits = [
          {
            byte: head.length + encoded.length,
            deleteBytes: encoded.length,
            insert: "a",
          },
        ];
        const actual = assertIncrementalEqualsFresh(
          source,
          edits,
          applyEdits(source, edits),
        );
        assert.deepEqual(issues(actual), [
          [
            "invalid_syntax",
            "invalid_encoding",
            head.length,
            head.length + encoded.length,
          ],
        ]);
        assert.deepEqual(owners(actual), [owner]);
      }
    }
  }
});

const editCases = [
  {
    name: "insert BOM",
    source: "Name <old>",
    edits: [{ byte: 0, deleteBytes: 0, insert: "\uFEFF" }],
  },
  {
    name: "remove BOM",
    source: "\uFEFFName <old>",
    edits: [{ byte: 0, deleteBytes: 3, insert: "" }],
  },
  {
    name: "split Unicode",
    source: "名 <old>",
    edits: [{ byte: 1, deleteBytes: 1, insert: "" }],
  },
  {
    name: "repair invalid UTF-8",
    source: Buffer.from([255, 32, 60, 97, 62]),
    edits: [{ byte: 0, deleteBytes: 1, insert: "名" }],
  },
];
for (const entry of editCases) {
  test(`mailmap: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

test("mailmap: CST helpers preserve fields, hierarchy and UTF-8 ranges across CRLF", () => {
  const source = "名 <a>\r\n# b";
  const text = [
    "0:0 - 1:3   document",
    "0:0 - 1:0     mapping",
    "0:0 - 0:3       canonical_name: name",
    "0:0 - 0:3         name_text `名`",
    "0:4 - 0:7       commit_email: email",
    "0:4 - 0:5         opening: email_open `<`",
    "0:5 - 0:6         email_text `a`",
    "0:6 - 0:7         closing: email_close `>`",
    "0:7 - 1:0       line_ending",
    "0:7 - 0:9         `\\r\\n`",
    "1:0 - 1:3     comment",
    "1:0 - 1:1       comment_marker `#`",
    "1:1 - 1:3       comment_text ` b`",
  ].join("\n");
  const nodes = parseCst(text, source);
  assert.deepEqual(nodes, [
    { kind: "document", field: null, start: 0, end: 12, parent: null },
    { kind: "mapping", field: null, start: 0, end: 9, parent: 0 },
    { kind: "name", field: "canonical_name", start: 0, end: 3, parent: 1 },
    { kind: "name_text", field: null, start: 0, end: 3, parent: 2 },
    { kind: "email", field: "commit_email", start: 4, end: 7, parent: 1 },
    { kind: "email_open", field: "opening", start: 4, end: 5, parent: 4 },
    { kind: "email_text", field: null, start: 5, end: 6, parent: 4 },
    { kind: "email_close", field: "closing", start: 6, end: 7, parent: 4 },
    { kind: "line_ending", field: null, start: 7, end: 9, parent: 1 },
    { kind: "comment", field: null, start: 9, end: 12, parent: 0 },
    { kind: "comment_marker", field: null, start: 9, end: 10, parent: 9 },
    { kind: "comment_text", field: null, start: 10, end: 12, parent: 9 },
  ]);
  assert.deepEqual(leaves(source, nodes), [
    ["name_text", "名"],
    ["email_open", "<"],
    ["email_text", "a"],
    ["email_close", ">"],
    ["line_ending", "\r\n"],
    ["comment_marker", "#"],
    ["comment_text", " b"],
  ]);
});

test("mailmap: CST helpers reject truncated roots and native recovery nodes", () => {
  assert.throws(() => parseCst("0:0 - 0:1   document", "é"));
  for (const kind of ["ERROR", "MISSING"]) {
    const text = `0:0 - 0:1   document\n0:0 - 0:1     ${kind}`;
    assert.throws(() => parseCst(text, "a"));
  }
});
