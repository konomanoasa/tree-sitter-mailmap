import assert from "node:assert/strict";
import { test } from "node:test";
import { issues, leaves, owners } from "./support/cst.js";
import {
  applyEdits,
  assertIncrementalEqualsFresh,
  parse,
} from "./support/parser.js";

test("mailmap: missing commit addresses follow trailing layout at every line boundary", () => {
  const prefixes = [
    { prefix: "Name \t\r", expectedFields: [["canonical_name", "name", 0, 4]] },
    {
      prefix: "<new> \t\r",
      expectedFields: [["canonical_email", "email", 0, 5]],
    },
    {
      prefix: "<new> Old \t\r",
      expectedFields: [
        ["canonical_email", "email", 0, 5],
        ["commit_name", "name", 6, 9],
      ],
    },
  ];
  const endings = [
    { ending: "", outcome: "incomplete_syntax", issueOffsetBytes: 0 },
    { ending: "\nNext <ok>", outcome: "invalid_syntax", issueOffsetBytes: -1 },
    { ending: "\r\nNext <ok>", outcome: "invalid_syntax", issueOffsetBytes: 0 },
    { ending: "# note", outcome: "invalid_syntax", issueOffsetBytes: 0 },
    { ending: "\0tail", outcome: "invalid_syntax", issueOffsetBytes: 0 },
  ];
  for (const { prefix, expectedFields } of prefixes) {
    for (const { ending, outcome, issueOffsetBytes } of endings) {
      const source = prefix + ending;
      const context = JSON.stringify(source);
      const nodes = parse(source);
      const position = Buffer.byteLength(prefix) + issueOffsetBytes;
      assert.deepEqual(
        issues(nodes),
        [[outcome, "missing_commit_email", position, position]],
        context,
      );
      assert.deepEqual(owners(nodes), ["mapping"], context);
      assert.deepEqual(
        nodes
          .filter(
            ({ parent, field }) => parent === 1 && field && field !== "issue",
          )
          .map(({ field, kind, start, end }) => [field, kind, start, end]),
        expectedFields,
        context,
      );
      assert.equal(
        nodes.find(({ kind }) => kind === "syntax_issue").field,
        "issue",
        context,
      );
    }
  }
});

test("mailmap: ignored tails exclude surrounding layout but retain NUL suffix bytes", () => {
  for (const prefix of ["N <old>", "N <new> <old>"]) {
    for (const ending of ["", "\n", "\r\n", "# note", "\0 \t\r"]) {
      const source = `${prefix} \t tail \t middle \t\r${ending}`;
      const nodes = parse(source);
      assert.deepEqual(issues(nodes), []);
      assert.equal(nodes[1].end, Buffer.byteLength(source));
      assert.deepEqual(
        leaves(source, nodes).filter(([kind]) => kind === "ignored_text"),
        [
          ["ignored_text", "tail \t middle"],
          ...(ending.startsWith("\0") ? [["ignored_text", ending]] : []),
        ],
      );
    }
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

test("mailmap: repairing a byte-only name and completing its address preserve issue positions", () => {
  const source = Buffer.from([255, 32, 9]);
  assert.deepEqual(issues(parse(source)), [
    ["invalid_syntax", "invalid_encoding", 0, 1],
    ["incomplete_syntax", "missing_commit_email", 3, 3],
  ]);
  const steps = [
    {
      edit: { byte: 0, deleteBytes: 1, insert: "N" },
      expected: [["incomplete_syntax", "missing_commit_email", 3, 3]],
    },
    {
      edit: { byte: 3, deleteBytes: 0, insert: "#c" },
      expected: [["invalid_syntax", "missing_commit_email", 3, 3]],
    },
    { edit: { byte: 3, deleteBytes: 0, insert: "<old>" }, expected: [] },
    {
      edit: { byte: 3, deleteBytes: 5, insert: "  " },
      expected: [["invalid_syntax", "missing_commit_email", 5, 5]],
    },
    {
      edit: { byte: 5, deleteBytes: 2, insert: "" },
      expected: [["incomplete_syntax", "missing_commit_email", 5, 5]],
    },
  ];
  const edits = [];
  for (const { edit, expected } of steps) {
    edits.push(edit);
    const actual = assertIncrementalEqualsFresh(
      source,
      edits,
      applyEdits(source, edits),
    );
    assert.deepEqual(issues(actual), expected);
    assert.deepEqual(
      owners(actual),
      expected.map(() => "mapping"),
    );
  }
});

test("mailmap: long lines and the last mapping are never truncated", () => {
  const addressLength = 70_000;
  const source = `N <${"x".repeat(addressLength)}>\nLast <ok>`;
  const nodes = parse(source);
  assert.deepEqual(issues(nodes), []);
  assert.equal(nodes.filter(({ kind }) => kind === "mapping").length, 2);
  assert.ok(
    leaves(source, nodes).some(
      ([kind, text]) => kind === "name_text" && text === "Last",
    ),
  );
});
