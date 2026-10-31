import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasError, leaves } from "./support/cst.js";
import {
  applyEdits,
  assertEditMatchesContract,
  parse,
} from "./support/parser.js";

test("mailmap: inserting required commit addresses repairs every line boundary", () => {
  for (const prefix of ["Name \t\r", "<new> \t\r", "<new> Old \t\r"]) {
    for (const ending of [
      "",
      "\nNext <ok>",
      "\r\nNext <ok>",
      "# note",
      "\0tail",
    ]) {
      const source = prefix + ending;
      const context = JSON.stringify(source);
      assert.equal(hasError(parse(source)), true, context);
      const edits = [
        { byte: Buffer.byteLength(prefix), deleteBytes: 0, insert: "<old>" },
      ];
      const actual = assertEditMatchesContract(
        source,
        edits,
        applyEdits(source, edits),
      );
      assert.equal(hasError(actual), false, context);
      assert.ok(
        actual.some(({ field }) => field === "commit_email"),
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
      assert.equal(hasError(nodes), false);
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

test("mailmap: repairing byte-only names and separators restores role fields", () => {
  const cases = [
    { before: "", after: " <old>", field: "canonical_name", separator: true },
    { before: "", after: "<old>", field: "canonical_name", separator: false },
    {
      before: "Name <new> ",
      after: " <old>",
      field: "commit_name",
      separator: true,
    },
    {
      before: "Name <new> ",
      after: "<old>",
      field: "commit_name",
      separator: false,
    },
  ];
  for (const { before, after, field, separator } of cases) {
    const source = Buffer.concat([
      Buffer.from(before),
      Buffer.from([255]),
      Buffer.from(after),
    ]);
    assert.equal(hasError(parse(source)), true);
    const offset = Buffer.byteLength(before);
    const edits = [{ byte: offset, deleteBytes: 1, insert: "名" }];
    const repairedName = applyEdits(source, edits);
    assert.equal(hasError(parse(repairedName)), !separator);
    if (!separator)
      edits.push({ byte: offset + 3, deleteBytes: 0, insert: " " });
    const actual = assertEditMatchesContract(
      source,
      edits,
      applyEdits(source, edits),
    );
    assert.equal(hasError(actual), false);
    assert.deepEqual(
      actual.find((node) => node.field === field),
      {
        kind: "name",
        field,
        start: offset,
        end: offset + 3,
        parent: 1,
      },
    );
  }
});

test("mailmap: repairing an invalid name and completing its address restores normal structure", () => {
  for (const ending of ["", "\n", "\r\n", "# note", "\0tail"]) {
    const source = Buffer.concat([
      Buffer.from([255]),
      Buffer.from(` \t${ending}`),
    ]);
    const edits = [
      { byte: 0, deleteBytes: 1, insert: "Name" },
      { byte: 6, deleteBytes: 0, insert: "<old>" },
    ];
    assert.equal(hasError(parse(source)), true);
    const actual = assertEditMatchesContract(
      source,
      edits,
      applyEdits(source, edits),
    );
    assert.equal(hasError(actual), false);
    assert.deepEqual(
      actual
        .filter(
          ({ field }) => field === "canonical_name" || field === "commit_email",
        )
        .map(({ field, start, end }) => [field, start, end]),
      [
        ["canonical_name", 0, 4],
        ["commit_email", 6, 11],
      ],
    );
  }
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
      output: syntaxContacts,
    },
    {
      source: "<> <old@example.org>",
      contacts: syntaxContacts,
      output: syntaxContacts,
    },
    {
      source: "Name <> <old@example.org>",
      contacts: syntaxContacts,
      output: syntaxContacts,
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
      output: syntaxContacts,
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
      output: syntaxContacts,
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
      output: syntaxContacts,
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
      output: syntaxContacts,
    },
    {
      source: "Name <old@example.org\u0000>",
      contacts: syntaxContacts,
      output: syntaxContacts,
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
      output: syntaxContacts,
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
      output: boundaryContacts,
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
      output: boundaryContacts,
    },
    {
      source: "<> <old@example.org>",
      contacts: boundaryContacts,
      output: boundaryContacts,
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
      output: boundaryContacts,
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
      output: boundaryContacts,
    },
    {
      source: "Name <old@example.org> <other\t>",
      contacts: boundaryContacts,
      output: boundaryContacts,
    },
    {
      source: "#Name <old@example.org>",
      contacts: boundaryContacts,
      output: boundaryContacts,
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
      output: boundaryContacts,
    },
    {
      source: "\f",
      contacts: boundaryContacts,
      output: boundaryContacts,
    },
    {
      source: "\r",
      contacts: boundaryContacts,
      output: boundaryContacts,
    },
    {
      source: "\u0000",
      contacts: boundaryContacts,
      output: boundaryContacts,
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
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    ),
    LC_ALL: "C",
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
