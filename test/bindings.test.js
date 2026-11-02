import assert from "node:assert/strict";
import { test } from "node:test";
import language from "@konomanoasa/tree-sitter-mailmap";
import Parser from "tree-sitter";

test("Node.js language parses mailmap and exposes node metadata and highlights", () => {
  const parser = new Parser();
  parser.setLanguage(language);
  const source = "Name <new> Old <old>\n";
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.type, "document");
  assert.equal(tree.rootNode.hasError, false);
  assert.equal(tree.rootNode.text, source);
  assert.ok(
    language.nodeTypeInfo.some(
      (node) => node.type === "document" && node.named,
    ),
  );
  const query = new Parser.Query(language, language.HIGHLIGHTS_QUERY);
  assert.deepEqual(
    query.captures(tree.rootNode).map(({ name, node }) => [name, node.text]),
    [
      ["string", "Name"],
      ["punctuation.bracket", "<"],
      ["string.special", "new"],
      ["punctuation.bracket", ">"],
      ["string", "Old"],
      ["punctuation.bracket", "<"],
      ["string.special", "old"],
      ["punctuation.bracket", ">"],
    ],
  );
});
