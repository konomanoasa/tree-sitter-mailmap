import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { issues, leaves, owners } from "./support/cst.js";
import {
  applyEdits,
  assertEditHistory,
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

const editCases = [
  {
    name: "add and remove a second address",
    source: "Name <new>",
    edits: [
      { byte: 10, deleteBytes: 0, insert: " Old <old>" },
      { byte: 10, deleteBytes: 10, insert: "" },
    ],
  },
  {
    name: "complete a first address",
    source: "Name <old",
    edits: [{ byte: 9, deleteBytes: 0, insert: ">" }],
  },
  {
    name: "close a second address",
    source: "<new> <old",
    edits: [{ byte: 10, deleteBytes: 0, insert: ">" }],
  },
  {
    name: "remove canonical name",
    source: "Name <new> <old>",
    edits: [{ byte: 0, deleteBytes: 5, insert: "" }],
  },
  {
    name: "insert and remove comment marker",
    source: "Name <old>",
    edits: [
      { byte: 7, deleteBytes: 0, insert: "#" },
      { byte: 7, deleteBytes: 1, insert: "" },
    ],
  },
  {
    name: "split and merge invalid UTF-8 runs inside a name",
    source: Buffer.from([78, 255, 254, 128, 32, 60, 97, 62]),
    edits: [
      { byte: 2, deleteBytes: 0, insert: "é" },
      { byte: 2, deleteBytes: 2, insert: "" },
      { byte: 1, deleteBytes: 3, insert: "ame" },
    ],
  },
];
for (const entry of editCases) {
  test(`mailmap: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

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

test("mailmap: Git runtime checks the documented supplementary cases", (t) => {
  const commandTimeoutMs = 10_000;
  const referenceVersion = "git version 2.56.0";
  const syntaxContacts = [
    "Old <old@example.org>",
    "Other <old@example.org>",
    "Old <new@example.org>",
    "Old <>",
    "Old < old@example.org >",
    "Old <old name@example.org>",
    "Old <x>",
    "Old <old#comment@example.org>",
    "Old <<old@example.org>",
  ];
  const boundaryContacts = [
    "Old <old@example.org>",
    "Other <old@example.org>",
    "Old <new@example.org>",
    "Old <>",
    "Old < >",
    "Old <x>",
    "Old <other>",
    "Old <old\t@example.org>",
  ];
  const cases = [
    {
      source: "Name <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "<new@example.org> <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <new@example.org>",
        "Other <new@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name <new@example.org>",
        "Name <new@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> Old <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name <new@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name<old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: " Name <old@example.org> ",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "<> <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <> <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> <>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Name <new@example.org>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "<new@example.org> Old <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <new@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "<old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> garbage",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> Old",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Name <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> <",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> <other>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> <old@example.org> <extra>",
      contacts: syntaxContacts,
      output: [
        "Name <new@example.org>",
        "Name <new@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> <old@example.org> garbage",
      contacts: syntaxContacts,
      output: [
        "Name <new@example.org>",
        "Name <new@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org>\u0000tail",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\u0000 <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org\u0000>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> #comment",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name #comment <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name #comment <old@example.org>",
        "Name #comment <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old#comment@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Name <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: " #comment <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "#comment <old@example.org>",
        "#comment <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name < old@example.org >",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Name < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old name@example.org>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Name <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <x>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Name <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org>\r",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <old@example.org>\rOther <x>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name > <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name > <old@example.org>",
        "Name > <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name <<old@example.org>>",
      contacts: syntaxContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Name <<old@example.org>",
      ],
    },
    {
      source: "\tName <old@example.org>\t",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\t<old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\tMore <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\tMore <old@example.org>",
        "Name\tMore <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "\rName <old@example.org>\r",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\r<old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\rMore <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\rMore <old@example.org>",
        "Name\rMore <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "\u000bName <old@example.org>\u000b",
      contacts: syntaxContacts,
      output: [
        "\u000bName <old@example.org>",
        "\u000bName <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\u000b<old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\u000b <old@example.org>",
        "Name\u000b <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\u000bMore <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\u000bMore <old@example.org>",
        "Name\u000bMore <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "\fName <old@example.org>\f",
      contacts: syntaxContacts,
      output: [
        "\fName <old@example.org>",
        "\fName <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\f<old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\f <old@example.org>",
        "Name\f <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\fMore <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\fMore <old@example.org>",
        "Name\fMore <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "\u00A0Name <old@example.org>\u00A0",
      contacts: syntaxContacts,
      output: [
        "\u00A0Name <old@example.org>",
        "\u00A0Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\u00A0<old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\u00A0 <old@example.org>",
        "Name\u00A0 <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Name\u00A0More <old@example.org>",
      contacts: syntaxContacts,
      output: [
        "Name\u00A0More <old@example.org>",
        "Name\u00A0More <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < old@example.org >",
        "Old <old name@example.org>",
        "Old <x>",
        "Old <old#comment@example.org>",
        "Old <<old@example.org>",
      ],
    },
    {
      source: "Before <old@example.org>\n<old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Before <old@example.org>",
        "Before <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "<old@example.org>\nAfter <old@example.org>",
      contacts: boundaryContacts,
      output: [
        "After <old@example.org>",
        "After <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source:
        "Before <old@example.org>\n<new@example.org> Old <old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Old <new@example.org>",
        "Before <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <new@example.org><old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Name <new@example.org>",
        "Name <new@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <new@example.org>Old<old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Name <new@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> <old@example.org>\u0000tail\nNext <x>",
      contacts: boundaryContacts,
      output: [
        "Name <new@example.org>",
        "Name <new@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Next <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "\u0000tail\nNext <x>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Next <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name\rMore <old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Name\rMore <old@example.org>",
        "Name\rMore <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org>\rOther <x>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <new@example.org>\u0000 <old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Name <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> <>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Name <old@example.org>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <> <old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "<> <old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name < >",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Name < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <new@example.org> Old <>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Name <new@example.org>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "<new@example.org> <old@example.org> tail",
      contacts: boundaryContacts,
      output: [
        "Old <new@example.org>",
        "Other <new@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> dangling <",
      contacts: boundaryContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> dangling <other",
      contacts: boundaryContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> dangling <other>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> <other> <x>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Name <old@example.org>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> <other>>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Name <old@example.org>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> <other\r>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org> <other\t>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "#Name <old@example.org>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old\t@example.org>",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Name <old\t@example.org>",
      ],
    },
    {
      source: "\u000b",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "\f",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "\r",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "\u0000",
      contacts: boundaryContacts,
      output: [
        "Old <old@example.org>",
        "Other <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Old <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org>\r\nOther <x>",
      contacts: boundaryContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Other <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: "Name <old@example.org>\nOther <x>",
      contacts: boundaryContacts,
      output: [
        "Name <old@example.org>",
        "Name <old@example.org>",
        "Old <new@example.org>",
        "Old <>",
        "Old < >",
        "Other <x>",
        "Old <other>",
        "Old <old\t@example.org>",
      ],
    },
    {
      source: [255, 32, 60, 111, 108, 100, 62],
      contacts: ["Old <old>"],
      output: [[255, 32, 60, 111, 108, 100, 62]],
    },
    {
      source: [255, 60, 111, 108, 100, 62],
      contacts: ["Old <old>"],
      output: [[255, 32, 60, 111, 108, 100, 62]],
    },
    {
      source: [78, 97, 109, 101, 255, 32, 60, 111, 108, 100, 62],
      contacts: ["Old <old>"],
      output: [[78, 97, 109, 101, 255, 32, 60, 111, 108, 100, 62]],
    },
    { source: [255], contacts: ["Old <old>"], output: ["Old <old>"] },
    {
      source: [194, 32, 60, 111, 108, 100, 62],
      contacts: ["Old <old>"],
      output: [[194, 32, 60, 111, 108, 100, 62]],
    },
    {
      source: [
        78, 97, 109, 101, 32, 60, 110, 101, 119, 62, 32, 255, 32, 60, 111, 108,
        100, 62,
      ],
      contacts: [[255, 32, 60, 111, 108, 100, 62], "Other <old>"],
      output: ["Name <new>", "Other <old>"],
    },
    {
      source: [255, 10, 78, 97, 109, 101, 32, 60, 111, 108, 100, 62, 10],
      contacts: ["Old <old>"],
      output: ["Name <old>"],
    },
  ];
  const version = spawnSync("git", ["--version"], { encoding: "utf8" });
  assert.ifError(version.error);
  assert.equal(version.status, 0, version.stderr);
  if (version.stdout.trim() !== referenceVersion) {
    t.skip(`${referenceVersion} is required for these observations`);
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "mailmap-git-"));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(directory, "absent-config"),
    GIT_CONFIG_COUNT: "0",
  };
  function git(arguments_, input = Buffer.alloc(0)) {
    const result = spawnSync("git", arguments_, {
      cwd: directory,
      env,
      input,
      timeout: commandTimeoutMs,
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
    assert.equal(git(["init", "--quiet"]).status, 0);
    const path = join(directory, "input.mailmap");
    for (const { source, contacts, output } of cases) {
      writeFileSync(path, Buffer.from(source));
      const result = git(
        ["check-mailmap", `--mailmap-file=${path}`, "--stdin"],
        lines(contacts),
      );
      const context = JSON.stringify(source);
      assert.equal(result.status, 0, context);
      assert.deepEqual(result.stderr, Buffer.alloc(0), context);
      assert.deepEqual(result.stdout, lines(output), context);
    }
    t.diagnostic(`${referenceVersion}: ${cases.length} observations match`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
