import assert from "node:assert/strict";
import { test } from "node:test";
import { hasError } from "./support/cst.js";
import {
  applyEdits,
  assertEditHistory,
  assertEditMatchesContract,
} from "./support/parser.js";

const histories = [
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
];
for (const entry of histories) {
  test(`mailmap: ${entry.name}`, () => {
    assertEditHistory(entry);
  });
}

for (const [owner, prefix, suffix] of [
  ["name", "Na", "me <a>"],
  ["email", "Name <", "a>"],
  ["comment", "# a", "b"],
]) {
  test(`mailmap: repairing a split character after a decoding failure restores ${owner}`, () => {
    const offset = Buffer.byteLength(prefix);
    const source = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([255]),
      Buffer.from(`é${suffix}`),
    ]);
    const edits = [
      { byte: offset + 2, deleteBytes: 1, insert: "" },
      { byte: offset, deleteBytes: 2, insert: "é" },
    ];
    const incremental = assertEditMatchesContract(
      source,
      edits,
      applyEdits(source, edits),
    );
    assert.equal(hasError(incremental), false);
  });
}

test("mailmap: repairing byte edits across Unicode boundaries restores normal CST", () => {
  for (const bom of ["", "\uFEFF"]) {
    for (const character of ["¿", "€", "😀"]) {
      for (const [context, prefix, suffix] of [
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
        edits.push({
          byte: head.length,
          deleteBytes: encoded.length,
          insert: "z",
        });
        const actual = assertEditMatchesContract(
          source,
          edits,
          applyEdits(source, edits),
        );
        assert.equal(hasError(actual), false, context);
      }
    }
  }
});

test("mailmap: fixed-seed generated histories preserve normal CST and fresh determinism", () => {
  const seed = 0x341ac9;
  const multiplier = 1664525;
  const increment = 1013904223;
  const historyCount = 120;
  const editsPerHistory = 4;
  const maxDeletedBytes = 3;
  let state = seed;
  const next = (maximum) => {
    state = (Math.imul(state, multiplier) + increment) >>> 0;
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
  for (let sample = 0; sample < historyCount; sample++) {
    const source = seeds[sample % seeds.length];
    let bytes = Buffer.from(source);
    const edits = [];
    for (let step = 0; step < editsPerHistory; step++) {
      const byte = next(bytes.length + 1);
      const edit = {
        byte,
        deleteBytes: Math.min(next(maxDeletedBytes + 1), bytes.length - byte),
        insert: alphabet[next(alphabet.length)],
      };
      edits.push(edit);
      bytes = applyEdits(bytes, [edit]);
      assertEditMatchesContract(source, edits, bytes);
    }
  }
});
