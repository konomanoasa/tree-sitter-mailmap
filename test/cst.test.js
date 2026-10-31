import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { root } from "../scripts/tree-sitter.js";
import { hasError, leaves, parseCst } from "./support/cst.js";
import { parse } from "./support/parser.js";

function parseCorpus(text) {
  const sections = text.split("==================\n");
  assert.equal(sections.shift(), "", "corpus must begin with a header");
  assert.equal(sections.length % 2, 0, "corpus headers must be paired");
  const cases = [];
  for (let index = 0; index < sections.length; index += 2) {
    const [name, ...attributes] = sections[index].trimEnd().split("\n");
    assert.ok(name, "corpus case must have a name");
    for (const attribute of attributes) {
      assert.ok(
        attribute === ":cst" || attribute === ":error",
        `unsupported corpus attribute: ${attribute}`,
      );
    }
    const parts = sections[index + 1].split("\n---\n");
    assert.equal(parts.length, 2, `${name}: expected one output separator`);
    const source = parts[0].endsWith("\r") ? parts[0].slice(0, -1) : parts[0];
    cases.push({ name, source });
  }
  return cases;
}

test("mailmap: long lines and the last mapping are never truncated", () => {
  const addressLength = 70_000;
  const source = `N <${"x".repeat(addressLength)}>\nLast <ok>`;
  const nodes = parse(source);
  assert.equal(hasError(nodes), false);
  assert.equal(nodes.filter(({ kind }) => kind === "mapping").length, 2);
  assert.ok(
    leaves(source, nodes).some(
      ([kind, text]) => kind === "name_text" && text === "Last",
    ),
  );
});

const corpusDirectory = join(root, "test/corpus");
for (const file of readdirSync(corpusDirectory).sort()) {
  assert.ok(file.endsWith(".txt"), `unexpected corpus entry: ${file}`);
  const entries = parseCorpus(
    readFileSync(join(corpusDirectory, file), "utf8"),
  );
  for (const { name, source } of entries) {
    test(`mailmap: corpus source coverage and fresh determinism: ${file}: ${name}`, () => {
      const tree = parse(source);
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

test("mailmap: invalid UTF-8 is rejected in every textual context", () => {
  const invalidBytes = Buffer.from([255, 128, 254]);
  const contexts = [
    ["name", "N", " <a>"],
    ["email", "N <", ">"],
    ["comment", "#", ""],
    ["ignored_suffix", "\0", ""],
    ["ignored_suffix", "N <a> ", ""],
  ];
  for (const [context, prefix, suffix] of contexts) {
    const source = Buffer.concat([
      Buffer.from(prefix),
      invalidBytes,
      Buffer.from(suffix),
    ]);
    assert.equal(hasError(parse(source)), true, context);
  }
});

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

test("mailmap: CST helpers retain standard recovery and reject truncated roots", () => {
  assert.throws(() => parseCst("0:0 - 0:1   document", "é"));
  assert.deepEqual(parseCst("0:0 - 0:1   •ERROR", "a"), [
    { kind: "ERROR", field: null, start: 0, end: 1, parent: null },
  ]);
  const missing = parseCst(
    "0:0 - 0:1   •document\n0:1 - 0:1     •email_close",
    "a",
  );
  assert.deepEqual(missing[1], {
    kind: "MISSING email_close",
    field: null,
    start: 1,
    end: 1,
    parent: 0,
  });
  assert.equal(hasError(missing), true);
});

test("mailmap: public metadata exposes normal roles without diagnostic nodes", () => {
  const types = JSON.parse(
    readFileSync(join(root, "src/node-types.json"), "utf8"),
  );
  assert.equal(
    types.some(({ type }) => /issue|invalid|incomplete|missing/.test(type)),
    false,
  );
  const mapping = types.find(({ type }) => type === "mapping");
  assert.deepEqual(Object.keys(mapping.fields).sort(), [
    "canonical_email",
    "canonical_name",
    "commit_email",
    "commit_name",
  ]);
  assert.equal(mapping.fields.commit_email.required, true);
  const email = types.find(({ type }) => type === "email");
  assert.equal(email.fields.opening.required, true);
  assert.equal(email.fields.closing.required, true);
  assert.equal(email.children.required, false);
});
