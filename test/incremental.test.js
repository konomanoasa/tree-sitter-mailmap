import { test } from "node:test";
import {
  applyEdits,
  assertEditHistory,
  assertIncrementalEqualsFresh,
} from "./support/parser.js";

const histories = [
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

test("mailmap: fixed-seed generated histories preserve roles, issues and byte ranges", () => {
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
      assertIncrementalEqualsFresh(source, edits, bytes);
    }
  }
});
