const roleField = ($, role, kind) => field(`${role}_${kind}`, $[kind]);
const name = ($, role) => seq(roleField($, role, "name"), $._name_separator);

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
    $._name_separator,
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
    $._error_sentinel,
  ],
  extras: ($) => [$._line_start, $._layout, $._unmatchable],
  rules: {
    document: ($) => repeat(choice($.mapping, $.comment, $.blank_line)),
    mapping: ($) =>
      seq(
        choice(
          seq(
            $._simple_mapping_start,
            name($, "canonical"),
            roleField($, "commit", "email"),
          ),
          seq(
            $._paired_mapping_start,
            optional(name($, "canonical")),
            roleField($, "canonical", "email"),
            optional(name($, "commit")),
            roleField($, "commit", "email"),
          ),
        ),
        repeat(choice(alias($._comment, $.comment), $.ignored_suffix)),
        $._ending,
      ),
    name: ($) => seq($._name_start, $.name_text, $._name_end),
    email: ($) =>
      seq(
        field("opening", $.email_open),
        optional($.email_text),
        field("closing", $.email_close),
      ),
    _comment: ($) =>
      seq(
        $._comment_start,
        $.comment_marker,
        optional($.comment_text),
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
      seq($._ignored_start, $.ignored_text, $._ignored_end),
    blank_line: ($) =>
      seq($._blank_start, optional($.ignored_suffix), $._ending),
    _ending: ($) => choice($.line_ending, $._eof),
    // Prevent premature EOF acceptance in Tree-sitter 0.27.0.
    _unmatchable: () => token(seq(/[\s\S]/, /[^\s\S]/)),
  },
});
