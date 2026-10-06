const issueKinds = [
  ["invalid_encoding", "invalid_syntax", "invalid_encoding"],
  ["missing_name_separator", "invalid_syntax", "missing_name_separator"],
  ...["email_text", "email_close", "commit_email"].flatMap((name) => [
    [`missing_${name}`, "invalid_syntax", `missing_${name}`],
    [`incomplete_${name}`, "incomplete_syntax", `missing_${name}`],
  ]),
];
const issueRules = Object.fromEntries(
  issueKinds.flatMap(([token, outcome, reason]) => [
    [`_${token}_outcome`, ($) => alias($[`_${token}`], $[reason])],
    [`_${token}_issue`, ($) => alias($[`_${token}_outcome`], $[outcome])],
  ]),
);
const issue = ($, name) =>
  field("issue", alias($[`_${name}_issue`], $.syntax_issue));
const missing = ($, name) =>
  choice(issue($, `missing_${name}`), issue($, `incomplete_${name}`));
const roleField = ($, role, kind) => field(`${role}_${kind}`, $[kind]);
const name = ($, role) =>
  seq(roleField($, role, "name"), optional(issue($, "missing_name_separator")));
const commitEmail = ($) =>
  choice(roleField($, "commit", "email"), missing($, "commit_email"));

export default grammar({
  name: "mailmap",
  externals: ($) => [
    $._line_start,
    $._simple_mapping_start,
    $._paired_mapping_start,
    $._blank_start,
    $._comment_line_start,
    $._name_start,
    $._name_end,
    $._comment_start,
    $._comment_end,
    $._ignored_start,
    $._ignored_end,
    $._layout,
    $._eof,
    $.line_ending,
    $.name_text,
    $.email_open,
    $.email_text,
    $.email_close,
    $.comment_marker,
    $.comment_text,
    $.ignored_text,
    ...issueKinds.map(([name]) => $[`_${name}`]),
    $._error_sentinel,
  ],
  extras: ($) => [$._line_start, $._layout, $._unmatchable],
  rules: {
    document: ($) => repeat(choice($.mapping, $.comment, $.blank_line)),
    mapping: ($) =>
      seq(
        choice(
          seq($._simple_mapping_start, name($, "canonical"), commitEmail($)),
          seq(
            $._paired_mapping_start,
            optional(name($, "canonical")),
            roleField($, "canonical", "email"),
            optional(name($, "commit")),
            commitEmail($),
          ),
        ),
        repeat(choice(alias($._comment, $.comment), $.ignored_suffix)),
        $._ending,
      ),
    name: ($) =>
      seq(
        $._name_start,
        repeat1(choice($.name_text, issue($, "invalid_encoding"))),
        $._name_end,
      ),
    email: ($) =>
      seq(
        field("opening", $.email_open),
        repeat(choice($.email_text, issue($, "invalid_encoding"))),
        optional(missing($, "email_text")),
        choice(field("closing", $.email_close), missing($, "email_close")),
      ),
    _comment: ($) =>
      seq(
        $._comment_start,
        $.comment_marker,
        repeat(choice($.comment_text, issue($, "invalid_encoding"))),
        $._comment_end,
      ),
    comment: ($) =>
      seq(
        $._comment_line_start,
        $._comment,
        optional($.ignored_suffix),
        $._ending,
      ),
    ignored_suffix: ($) =>
      seq(
        $._ignored_start,
        repeat1(choice($.ignored_text, issue($, "invalid_encoding"))),
        $._ignored_end,
      ),
    blank_line: ($) =>
      seq($._blank_start, optional($.ignored_suffix), $._ending),
    _ending: ($) => choice($.line_ending, $._eof),
    // Prevent Tree-sitter 0.27.0 from accepting EOF before the input ends.
    _unmatchable: () => token(seq(/[\s\S]/, /[^\s\S]/)),
    ...issueRules,
  },
});
