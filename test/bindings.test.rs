use konomanoasa_tree_sitter_mailmap as grammar;
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

#[test]
fn parses_valid_source() {
  let source = "Name <new> Old <old>\n";
  let language = grammar::LANGUAGE.into();
  let mut parser = Parser::new();
  parser.set_language(&language).unwrap();
  let tree = parser.parse(source, None).unwrap();
  let root = tree.root_node();
  assert_eq!(root.kind(), "document");
  assert_eq!(root.byte_range(), 0..source.len());
  assert!(!root.has_error());
  assert!(grammar::NODE_TYPES.contains("\"document\""));
  let query = Query::new(&language, grammar::HIGHLIGHTS_QUERY).unwrap();
  let mut cursor = QueryCursor::new();
  let mut captures = cursor.captures(&query, root, source.as_bytes());
  let mut actual = Vec::new();
  while let Some((matched, index)) = captures.next() {
    let capture = matched.captures()[*index];
    actual.push((
      query.capture_names()[capture.index as usize],
      capture.node.utf8_text(source.as_bytes()).unwrap(),
    ));
  }
  assert_eq!(
    actual,
    [
      ("string", "Name"),
      ("punctuation.bracket", "<"),
      ("string.special", "new"),
      ("punctuation.bracket", ">"),
      ("string", "Old"),
      ("punctuation.bracket", "<"),
      ("string.special", "old"),
      ("punctuation.bracket", ">")
    ]
  );
}
