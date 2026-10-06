import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, issues, owners, parse } from "./support/parser.js";

for (const [owner, prefix, suffix] of [
  ["name", "Na", "me <a>"],
  ["email", "Name <", "a>"],
  ["comment", "# a", "b"],
]) {
  test(`mailmap: splitting the character after a decoding failure merges the issue in ${owner}`, () => {
    const source = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([255]),
      Buffer.from(`é${suffix}`),
    ]);
    const edits = [
      { byte: Buffer.byteLength(prefix) + 2, deleteBytes: 1, insert: "" },
    ];
    const incremental = parse(source, edits);
    assert.deepEqual(incremental, parse(applyEdits(source, edits)));
    assert.deepEqual(
      incremental
        .filter(({ kind }) => kind === "syntax_issue")
        .map(({ start, end }) => [start, end]),
      [[Buffer.byteLength(prefix), Buffer.byteLength(prefix) + 2]],
    );
  });
}

const histories = [
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
    name: "terminate and reopen an incomplete name",
    source: "Name",
    edits: [
      { byte: 4, deleteBytes: 0, insert: "\nNext <ok>" },
      { byte: 4, deleteBytes: 10, insert: " <old>" },
    ],
  },
  {
    name: "split CRLF",
    source: "Name <old>\r\nNext <ok>",
    edits: [{ byte: 11, deleteBytes: 1, insert: "" }],
  },
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
for (const { name, source, edits } of histories) {
  test(`mailmap: ${name}`, () => {
    for (let step = 1; step <= edits.length; step++) {
      const prefix = edits.slice(0, step);
      assert.deepEqual(
        parse(source, prefix),
        parse(applyEdits(source, prefix)),
      );
    }
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
    const actual = parse(source, edits);
    assert.deepEqual(actual, parse(applyEdits(source, edits)));
    assert.deepEqual(issues(actual), expected);
    assert.deepEqual(
      owners(actual),
      expected.map(() => "mapping"),
    );
  }
});

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
        const actual = parse(source, edits);
        assert.deepEqual(actual, parse(applyEdits(source, edits)));
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

test("mailmap: fixed-seed generated histories preserve roles, issues and byte ranges", () => {
  let state = 0x341ac9;
  const next = (maximum) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % maximum;
  };
  const alphabet = "ab <>#\r\n\t\v\f@é";
  const seeds = [
    "",
    "N <a>\nM <b>",
    "<a> <b>",
    "N <a> M <b>",
    "# hi\nN <a>",
    "N <",
    "<>",
    "N <a> ignored",
    "N<a>M<b>tail#c\0tail",
    "\0ignored\nN <b>",
  ];
  for (let sample = 0; sample < 120; sample++) {
    const source = seeds[sample % seeds.length];
    let bytes = Buffer.from(source);
    const edits = [];
    for (let step = 0; step < 4; step++) {
      const byte = next(bytes.length + 1);
      const edit = {
        byte,
        deleteBytes: Math.min(next(4), bytes.length - byte),
        insert: alphabet[next(alphabet.length)],
      };
      edits.push(edit);
      bytes = applyEdits(bytes, [edit]);
      try {
        assert.deepEqual(parse(source, edits), parse(bytes));
      } catch (error) {
        if (error instanceof Error)
          error.message += `\n${JSON.stringify({ source, edits })}`;
        throw error;
      }
    }
  }
});
