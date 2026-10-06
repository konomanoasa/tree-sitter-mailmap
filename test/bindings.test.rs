use konomanoasa_tree_sitter_mailmap as grammar;
use tree_sitter::{InputEdit, Node, Parser, Point, Query};

fn parser() -> Parser {
  let mut parser = Parser::new();
  parser.set_language(&grammar::LANGUAGE.into()).unwrap();
  parser
}

#[test]
fn parses_valid_source() {
  let source = "Name <new> Old <old>\n";
  let tree = parser().parse(source, None).unwrap();
  let root = tree.root_node();
  assert_eq!(root.kind(), "document");
  assert_eq!(root.byte_range(), 0..source.len());
  assert!(!root.has_error());
  let mapping = root.named_child(0).unwrap();
  for (field, expected) in [
    ("canonical_name", 0..4),
    ("canonical_email", 5..10),
    ("commit_name", 11..14),
    ("commit_email", 15..20),
  ] {
    assert_eq!(
      mapping.child_by_field_name(field).unwrap().byte_range(),
      expected
    );
  }
  assert!(grammar::NODE_TYPES.contains("\"syntax_issue\""));
  Query::new(&grammar::LANGUAGE.into(), grammar::HIGHLIGHTS_QUERY).unwrap();
}

#[test]
fn missing_close_is_a_zero_width_issue_owned_by_the_email() {
  let tree = parser().parse("Name <old", None).unwrap();
  let root = tree.root_node();
  assert!(!root.has_error());
  let email = root
    .named_child(0)
    .unwrap()
    .child_by_field_name("commit_email")
    .unwrap();
  let issue = email.child_by_field_name("issue").unwrap();
  let outcome = issue.named_child(0).unwrap();
  let reason = outcome.named_child(0).unwrap();
  assert_eq!(issue.kind(), "syntax_issue");
  assert_eq!(outcome.kind(), "incomplete_syntax");
  assert_eq!(reason.kind(), "missing_email_close");
  for node in [issue, outcome, reason] {
    assert_eq!(node.byte_range(), 9..9);
  }
}

fn snapshot(node: Node<'_>) -> Vec<(String, Option<String>, usize, usize)> {
  fn visit(
    node: Node<'_>,
    field: Option<&str>,
    out: &mut Vec<(String, Option<String>, usize, usize)>,
  ) {
    out.push((
      node.kind().to_owned(),
      field.map(str::to_owned),
      node.start_byte(),
      node.end_byte(),
    ));
    for index in 0..node.child_count() {
      visit(
        node.child(index).unwrap(),
        node.field_name_for_child(index),
        out,
      );
    }
  }
  let mut result = Vec::new();
  visit(node, None, &mut result);
  result
}

#[test]
fn binary_edits_preserve_nul_boundaries_and_decoding_issues() {
  let mut parser = parser();
  let mut source = b"N <a>".to_vec();
  let mut tree = parser.parse(&source, None).unwrap();
  for (start, delete, insert) in
    [(3, 0, &[0u8][..]), (3, 1, &[255u8][..]), (3, 1, &[][..])]
  {
    let old_end = start + delete;
    tree.edit(&InputEdit {
      start_byte: start,
      old_end_byte: old_end,
      new_end_byte: start + insert.len(),
      start_position: Point::new(0, start),
      old_end_position: Point::new(0, old_end),
      new_end_position: Point::new(0, start + insert.len()),
    });
    source.splice(start..old_end, insert.iter().copied());
    tree = parser.parse(&source, Some(&tree)).unwrap();
    let fresh = parser.parse(&source, None).unwrap();
    assert!(!tree.root_node().has_error());
    assert_eq!(snapshot(tree.root_node()), snapshot(fresh.root_node()));
    let kinds = tree.root_node().to_sexp();
    match insert {
      [0] => {
        assert!(kinds.contains("ignored_suffix"));
        assert!(kinds.contains("missing_email_close"));
      }
      [255] => assert!(kinds.contains("invalid_encoding")),
      _ => assert!(!kinds.contains("syntax_issue")),
    }
  }
}

#[test]
fn reusing_a_parser_does_not_carry_state_between_documents() {
  let mut reused = parser();
  for source in [
    "<",
    "Name <old>",
    "# c\n",
    "N<a>M<b>tail#c\0end",
    "",
    "<new> <old>",
  ] {
    let tree = reused.parse(source, None).unwrap();
    let fresh = parser().parse(source, None).unwrap();
    assert!(!tree.root_node().has_error());
    assert_eq!(snapshot(tree.root_node()), snapshot(fresh.root_node()));
  }
}
