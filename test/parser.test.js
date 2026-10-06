import assert from "node:assert/strict";
import { test } from "node:test";
import { issues, leaves, owners, parse } from "./support/parser.js";

const forms = [
  {
    name: "name mapping",
    source: "Name <old>",
    expected: [
      ["canonical_name", "Name"],
      ["commit_email", "<old>"],
    ],
  },
  {
    name: "email mapping",
    source: "<new> <old>",
    expected: [
      ["canonical_email", "<new>"],
      ["commit_email", "<old>"],
    ],
  },
  {
    name: "name and email mapping",
    source: "Name <new> <old>",
    expected: [
      ["canonical_name", "Name"],
      ["canonical_email", "<new>"],
      ["commit_email", "<old>"],
    ],
  },
  {
    name: "name-qualified mapping",
    source: "Name <new> Old Name <old>",
    expected: [
      ["canonical_name", "Name"],
      ["canonical_email", "<new>"],
      ["commit_name", "Old Name"],
      ["commit_email", "<old>"],
    ],
  },
  {
    name: "omitted canonical name",
    source: "<new> Old <old>",
    expected: [
      ["canonical_email", "<new>"],
      ["commit_name", "Old"],
      ["commit_email", "<old>"],
    ],
  },
  {
    name: "empty second address",
    source: "Name <new><>",
    expected: [
      ["canonical_name", "Name"],
      ["canonical_email", "<new>"],
      ["commit_email", "<>"],
    ],
  },
  {
    name: "source whitespace and Unicode",
    source: " \t名 前\r < a\tb<c >\r",
    expected: [
      ["canonical_name", "名 前"],
      ["commit_email", "< a\tb<c >"],
    ],
  },
];

for (const { name, source, expected } of forms) {
  test(`mailmap: ${name} preserves roles and source spelling`, () => {
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), []);
    assert.equal(nodes[1].kind, "mapping");
    const bytes = Buffer.from(source);
    assert.deepEqual(
      nodes
        .filter(({ parent, field }) => parent === 1 && field)
        .map(({ field, start, end }) => [
          field,
          bytes.subarray(start, end).toString(),
        ]),
      expected,
    );
  });
}

const issueCases = [
  [
    "name without address at EOF",
    "Name",
    [["incomplete_syntax", "missing_commit_email", 4, 4]],
    ["mapping"],
  ],
  [
    "name without address before LF",
    "Name\n",
    [["invalid_syntax", "missing_commit_email", 4, 4]],
    ["mapping"],
  ],
  [
    "first address missing close",
    "Name <old",
    [["incomplete_syntax", "missing_email_close", 9, 9]],
    ["email"],
  ],
  [
    "first address missing close before CRLF",
    "Name <old\r\nNext <ok>\n",
    [["invalid_syntax", "missing_email_close", 9, 9]],
    ["email"],
  ],
  [
    "comment terminates address",
    "Name <old# note",
    [["invalid_syntax", "missing_email_close", 9, 9]],
    ["email"],
  ],
  [
    "NUL terminates address",
    "Name <old\0>\nNext <ok>",
    [["invalid_syntax", "missing_email_close", 9, 9]],
    ["email"],
  ],
  [
    "closed empty first address",
    "Name <>",
    [["invalid_syntax", "missing_email_text", 6, 6]],
    ["email"],
  ],
  [
    "empty first address at EOF",
    "Name <",
    [
      ["incomplete_syntax", "missing_email_text", 6, 6],
      ["incomplete_syntax", "missing_email_close", 6, 6],
    ],
    ["email", "email"],
  ],
  [
    "nameless address needs a commit address",
    "<new>",
    [["incomplete_syntax", "missing_commit_email", 5, 5]],
    ["mapping"],
  ],
  [
    "unclosed nameless address has both omissions",
    "<new",
    [
      ["incomplete_syntax", "missing_email_close", 4, 4],
      ["incomplete_syntax", "missing_commit_email", 4, 4],
    ],
    ["email", "mapping"],
  ],
  [
    "partial second address retains its role",
    "Name <new> Old <old",
    [["incomplete_syntax", "missing_email_close", 19, 19]],
    ["email"],
  ],
  [
    "missing name separator follows the manual",
    "Name<old>",
    [["invalid_syntax", "missing_name_separator", 4, 4]],
    ["mapping"],
  ],
  [
    "both names need separators",
    "Name<new>Old<old>",
    [
      ["invalid_syntax", "missing_name_separator", 4, 4],
      ["invalid_syntax", "missing_name_separator", 12, 12],
    ],
    ["mapping", "mapping"],
  ],
];
for (const [name, source, expected, expectedOwners] of issueCases) {
  test(`mailmap: ${name}`, () => {
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), expected);
    assert.deepEqual(owners(nodes), expectedOwners);
    for (const node of nodes.filter(({ kind }) => kind === "syntax_issue"))
      assert.equal(node.field, "issue");
  });
}

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
    { ending: "", outcome: "incomplete_syntax", offset: 0 },
    { ending: "\nNext <ok>", outcome: "invalid_syntax", offset: -1 },
    { ending: "\r\nNext <ok>", outcome: "invalid_syntax", offset: 0 },
    { ending: "# note", outcome: "invalid_syntax", offset: 0 },
    { ending: "\0tail", outcome: "invalid_syntax", offset: 0 },
  ];
  for (const { prefix, expectedFields } of prefixes) {
    for (const { ending, outcome, offset } of endings) {
      const source = prefix + ending;
      const context = JSON.stringify(source);
      const nodes = parse(source);
      const position = prefix.length + offset;
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

test("mailmap: comments and ignored suffixes preserve each physical line", () => {
  const source =
    " \t# one\r\nName <old> tail# two\0tail\n\0ignored\nNext <new> <old> <extra>\n";
  const nodes = parse(source);
  assert.deepEqual(issues(nodes), []);
  assert.deepEqual(
    nodes
      .filter(({ parent }) => parent === 0)
      .map(({ kind, start, end }) => [kind, start, end]),
    [
      ["comment", 0, 9],
      ["mapping", 9, 35],
      ["blank_line", 35, 44],
      ["mapping", 44, 69],
    ],
  );
  assert.deepEqual(
    leaves(source, nodes).filter(([kind]) =>
      ["comment_text", "ignored_text"].includes(kind),
    ),
    [
      ["comment_text", " one"],
      ["ignored_text", "tail"],
      ["comment_text", " two"],
      ["ignored_text", "\0tail"],
      ["ignored_text", "\0ignored"],
      ["ignored_text", "<extra>"],
    ],
  );
});

test("mailmap: invalid UTF-8 runs are grouped within each textual owner", () => {
  const sources = [
    {
      source: Buffer.from([78, 255, 128, 254, 32, 60, 97, 62]),
      owner: "name",
      start: 1,
    },
    {
      source: Buffer.from([78, 32, 60, 255, 128, 254, 62]),
      owner: "email",
      start: 3,
    },
    { source: Buffer.from([35, 255, 128, 254]), owner: "comment", start: 1 },
    {
      source: Buffer.from([0, 255, 128, 254]),
      owner: "ignored_suffix",
      start: 1,
    },
    {
      source: Buffer.from([78, 32, 60, 97, 62, 32, 255, 128, 254]),
      owner: "ignored_suffix",
      start: 6,
    },
  ];
  for (const { source, owner, start } of sources) {
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), [
      ["invalid_syntax", "invalid_encoding", start, start + 3],
    ]);
    assert.deepEqual(owners(nodes), [owner]);
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

test("mailmap: empty input, whitespace, BOM and noninitial BOM keep original offsets", () => {
  for (const source of [
    "",
    " \t\r",
    "\n\r\n",
    "\uFEFF",
    "\uFEFFName <old>",
    "Name \uFEFF <old>",
  ]) {
    const nodes = parse(source);
    assert.deepEqual(issues(nodes), []);
    if (source === "\uFEFFName <old>")
      assert.equal(nodes.find(({ kind }) => kind === "name_text").start, 3);
    if (source === "Name \uFEFF <old>")
      assert.ok(
        leaves(source, nodes).some(
          ([kind, value]) => kind === "name_text" && value === "Name \uFEFF",
        ),
      );
  }
});

test("mailmap: long lines and the last mapping are never truncated", () => {
  const source = `N <${"x".repeat(70000)}>\nLast <ok>`;
  const nodes = parse(source);
  assert.deepEqual(issues(nodes), []);
  assert.equal(nodes.filter(({ kind }) => kind === "mapping").length, 2);
  assert.ok(
    leaves(source, nodes).some(
      ([kind, text]) => kind === "name_text" && text === "Last",
    ),
  );
});
