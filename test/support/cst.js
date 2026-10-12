import assert from "node:assert/strict";

function parseCst(text, source) {
  const bytes = Buffer.from(source);
  const newlineByte = 0x0a;
  const rootIndentWidth = 3;
  const nodeIndentWidth = 2;
  const starts = [0];
  for (const [offset, value] of bytes.entries())
    if (value === newlineByte) starts.push(offset + 1);
  const nodes = [],
    ancestors = [];
  for (const line of text.split("\n")) {
    const location =
      /^([0-9]+):([0-9]+)( +)- ([0-9]+):([0-9]+)( +)(([a-z_]+): )?([a-z_]+|ERROR|MISSING|"[^"]*")/.exec(
        line,
      );
    if (!location) continue;
    const [
      ,
      startRow,
      startColumn,
      startPadding,
      endRow,
      endColumn,
      nodePadding,
      ,
      field,
      kind,
    ] = location;
    const width = startRow.length + startColumn.length + startPadding.length;
    const endWidth = endRow.length + 1 + endColumn.length;
    const depth =
      (nodePadding.length - Math.max(width - endWidth, 0) - rootIndentWidth) /
      nodeIndentWidth;
    assert.ok(Number.isInteger(depth) && depth >= 0, line);
    ancestors.length = depth;
    nodes.push({
      kind: kind.startsWith('"') ? JSON.parse(kind) : kind,
      field: field ?? null,
      start: starts[Number(startRow)] + Number(startColumn),
      end: starts[Number(endRow)] + Number(endColumn),
      parent: ancestors.at(-1) ?? null,
    });
    ancestors.push(nodes.length - 1);
  }
  assert.equal(nodes[0]?.kind, "document", text);
  assert.equal(nodes[0].end, bytes.length, text);
  assert.ok(
    !nodes.some(({ kind }) => kind === "ERROR" || kind === "MISSING"),
    text,
  );
  return nodes;
}

function issues(nodes) {
  return nodes.flatMap((node, index) => {
    if (node.kind !== "syntax_issue") return [];
    const outcome = nodes[index + 1],
      reason = nodes[index + 2];
    assert.equal(outcome.parent, index);
    assert.equal(reason.parent, index + 1);
    assert.deepEqual(
      [outcome.start, outcome.end, reason.start, reason.end],
      [node.start, node.end, node.start, node.end],
    );
    return [[outcome.kind, reason.kind, node.start, node.end]];
  });
}

function owners(nodes) {
  return nodes
    .filter(({ kind }) => kind === "syntax_issue")
    .map(({ parent }) => nodes[parent].kind);
}

function leaves(source, nodes) {
  const bytes = Buffer.from(source);
  const parents = new Set(nodes.map(({ parent }) => parent));
  return nodes.flatMap((node, index) =>
    parents.has(index)
      ? []
      : [[node.kind, bytes.subarray(node.start, node.end).toString()]],
  );
}

export { issues, leaves, owners, parseCst };
