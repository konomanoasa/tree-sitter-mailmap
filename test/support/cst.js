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
  const markedNodes = new Set();
  for (const line of text.split("\n")) {
    const marked = /^[0-9]+:[0-9]+ +- [0-9]+:[0-9]+ +([a-z_]+: )?•/.test(line);
    const location =
      /^([0-9]+):([0-9]+)( +)- ([0-9]+):([0-9]+)( +)(([a-z_]+): )?([a-z_]+|ERROR|"[^"]*")/.exec(
        line.replaceAll(/ •/g, " "),
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
    // Recovery markers occupy an extra display column on some CLI lines.
    const depth = Math.floor(
      (nodePadding.length - Math.max(width - endWidth, 0) - rootIndentWidth) /
        nodeIndentWidth,
    );
    assert.ok(depth >= 0 && depth <= ancestors.length, line);
    ancestors.length = depth;
    if (marked) markedNodes.add(nodes.length);
    nodes.push({
      kind: kind.startsWith('"') ? JSON.parse(kind) : kind,
      field: field ?? null,
      start: starts[Number(startRow)] + Number(startColumn),
      end: starts[Number(endRow)] + Number(endColumn),
      parent: ancestors.at(-1) ?? null,
    });
    ancestors.push(nodes.length - 1);
  }
  assert.ok(["document", "ERROR"].includes(nodes[0]?.kind), text);
  assert.equal(nodes[0].end, bytes.length, text);
  const parents = new Set(nodes.map(({ parent }) => parent));
  for (const index of markedNodes) {
    const node = nodes[index];
    if (
      node.start === node.end &&
      !parents.has(index) &&
      node.kind !== "ERROR" &&
      !node.kind.startsWith("MISSING")
    ) {
      node.kind = `MISSING ${node.kind}`;
    }
  }
  return nodes;
}

function hasError(nodes) {
  return nodes.some(
    ({ kind }) => kind === "ERROR" || kind.startsWith("MISSING"),
  );
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

export { hasError, leaves, parseCst };
