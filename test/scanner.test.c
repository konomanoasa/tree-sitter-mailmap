#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../src/parser.c"
#include "../src/scanner.c"

#ifdef TREE_SITTER_REUSE_ALLOCATOR
static size_t reuse_live_allocations;
static bool reuse_fail_next_calloc;

static void *reuse_calloc(size_t count, size_t size) {
  if (reuse_fail_next_calloc) {
    reuse_fail_next_calloc = false;
    return NULL;
  }
  void *result = calloc(count, size);
  if (result != NULL) {
    reuse_live_allocations += 1;
  }
  return result;
}

static void reuse_free(void *allocation) {
  if (allocation != NULL) {
    assert(reuse_live_allocations > 0);
    reuse_live_allocations -= 1;
  }
  free(allocation);
}

void *(*ts_current_calloc)(size_t, size_t) = reuse_calloc;
void (*ts_current_free)(void *) = reuse_free;
#endif

struct MockLexer {
  TSLexer lexer;
  const int32_t *input;
  size_t length;
  size_t offset;
  size_t mark;
};

static void mock_advance(TSLexer *lexer, bool skip) {
  (void)skip;
  struct MockLexer *mock = (struct MockLexer *)lexer;
  if (mock->offset < mock->length) {
    mock->offset += 1;
  }
  lexer->lookahead =
    mock->offset < mock->length ? mock->input[mock->offset] : 0;
}

static void mock_mark_end(TSLexer *lexer) {
  struct MockLexer *mock = (struct MockLexer *)lexer;
  mock->mark = mock->offset;
}

static bool mock_eof(const TSLexer *lexer) {
  const struct MockLexer *mock = (const struct MockLexer *)lexer;
  return mock->offset == mock->length;
}

static void
init_mock_lexer(struct MockLexer *mock, const int32_t *input, size_t length) {
  *mock = (struct MockLexer){
    .lexer =
      {
        .lookahead = length == 0 ? 0 : input[0],
        .result_symbol = UINT16_MAX,
        .advance = mock_advance,
        .mark_end = mock_mark_end,
        .eof = mock_eof,
      },
    .input = input,
    .length = length,
    .mark = SIZE_MAX,
  };
}

static void test_internal_lexer_accepts_eof_only_at_input_end(void) {
  const int32_t input[] = {'x', 0, '\n', 0xfeff, -1};
  for (size_t index = 0; index < sizeof(input) / sizeof(input[0]); index += 1) {
    struct MockLexer mock;
    init_mock_lexer(&mock, input + index, 1);
    assert(!ts_lex(&mock.lexer, 0));
    assert(mock.lexer.result_symbol != ts_builtin_sym_end);
  }
  struct MockLexer mock;
  init_mock_lexer(&mock, NULL, 0);
  assert(ts_lex(&mock.lexer, 0));
  assert(mock.lexer.result_symbol == ts_builtin_sym_end);
  assert(mock.mark == 0);
}

static void test_lifecycle_and_serialization_round_trip(void) {
  Scanner *scanner = tree_sitter_mailmap_external_scanner_create();
  assert(scanner != NULL);
  const Scanner initial = {0};
  assert(memcmp(scanner, &initial, sizeof(initial)) == 0);
  const Scanner expected = {
    .position = 3,
    .count = 4,
    .index = 1,
    .steps = {
      {.start = 0, .end = 0, .token = SIMPLE_MAPPING_START},
      {.start = 2, .end = 70000, .token = EMAIL_TEXT},
      {.start = 70000, .end = 70001, .token = EMAIL_CLOSE},
      {.start = 70001, .end = 70003, .token = LINE_ENDING}
    },
  };
  *scanner = expected;
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE + 2];
  memset(buffer, 0x5a, sizeof(buffer));
  const unsigned length =
    tree_sitter_mailmap_external_scanner_serialize(scanner, buffer + 1);
  assert(length == offsetof(Scanner, steps) + 4 * sizeof(Step));
  assert(buffer[0] == 0x5a && buffer[length + 1] == 0x5a);
  tree_sitter_mailmap_external_scanner_deserialize(scanner, NULL, 0);
  assert(memcmp(scanner, &initial, sizeof(initial)) == 0);
  tree_sitter_mailmap_external_scanner_deserialize(scanner, buffer + 1, length);
  assert(memcmp(scanner, &expected, sizeof(expected)) == 0);
  tree_sitter_mailmap_external_scanner_deserialize(
    scanner,
    buffer + 1,
    length - 1
  );
  assert(memcmp(scanner, &initial, sizeof(initial)) == 0);
  tree_sitter_mailmap_external_scanner_deserialize(
    scanner,
    buffer + 1,
    length + sizeof(Step)
  );
  assert(memcmp(scanner, &initial, sizeof(initial)) == 0);
  tree_sitter_mailmap_external_scanner_destroy(scanner);
}

static void test_failed_and_recovery_scans_preserve_state(void) {
  const int32_t input[] = {'N', ' ', '<', 'a', '>'};
  for (unsigned recovery = 0; recovery <= 1; recovery++) {
    bool valid[ERROR_SENTINEL + 1] = {false};
    for (unsigned token = 0; token <= ERROR_SENTINEL; token++)
      valid[token] = recovery != 0;
    Scanner scanner = {0};
    const Scanner expected = scanner;
    struct MockLexer mock;
    init_mock_lexer(&mock, input, 5);
    assert(
      !tree_sitter_mailmap_external_scanner_scan(&scanner, &mock.lexer, valid)
    );
    assert(memcmp(&scanner, &expected, sizeof(expected)) == 0);
  }
}

struct Expectation {
  enum Token token;
  size_t start, end, lookahead;
};

static void expect_tokens(
  const int32_t *input,
  size_t length,
  const struct Expectation *cases,
  size_t count
) {
  Scanner scanner = {0};
  for (size_t i = 0; i < count; i++) {
    bool valid[ERROR_SENTINEL + 1] = {false};
    valid[cases[i].token] = true;
    struct MockLexer mock;
    init_mock_lexer(&mock, input + cases[i].start, length - cases[i].start);
    assert(
      tree_sitter_mailmap_external_scanner_scan(&scanner, &mock.lexer, valid)
    );
    assert(mock.lexer.result_symbol == cases[i].token);
    assert(mock.mark == cases[i].end - cases[i].start);
    assert(mock.offset == cases[i].lookahead - cases[i].start);
    char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE];
    unsigned serialized =
      tree_sitter_mailmap_external_scanner_serialize(&scanner, buffer);
    Scanner restored = {0};
    tree_sitter_mailmap_external_scanner_deserialize(
      &restored,
      buffer,
      serialized
    );
    scanner = restored;
  }
  const Scanner initial = {0};
  assert(memcmp(&scanner, &initial, sizeof(initial)) == 0);
}

static void test_restored_tokens_preserve_ranges_and_finish_at_eof(void) {
  const int32_t input[] = {'N', ' ', '<', 'a', '>'};
  const struct Expectation cases[] = {
    {LINE_START, 0, 0, 5},
    {SIMPLE_MAPPING_START, 0, 0, 0},
    {NAME_START, 0, 0, 0},
    {NAME_TEXT, 0, 1, 1},
    {NAME_END, 1, 1, 1},
    {LAYOUT, 1, 2, 2},
    {EMAIL_OPEN, 2, 3, 3},
    {EMAIL_TEXT, 3, 4, 4},
    {EMAIL_CLOSE, 4, 5, 5},
    {END_OF_FILE, 5, 5, 5},
  };
  expect_tokens(input, 5, cases, sizeof(cases) / sizeof(cases[0]));
}

static void test_text_runs_look_ahead_over_the_opposite_run(void) {
  const int32_t input[] = {'a', -1, -1, 'b', 'c', -1, '\n'};
  const struct Expectation cases[] = {
    {LINE_START, 0, 0, 6},
    {SIMPLE_MAPPING_START, 0, 0, 0},
    {NAME_START, 0, 0, 0},
    {NAME_TEXT, 0, 1, 3},
    {INVALID_ENCODING, 1, 3, 5},
    {NAME_TEXT, 3, 5, 6},
    {INVALID_ENCODING, 5, 6, 6},
    {NAME_END, 6, 6, 6},
    {MISSING_COMMIT_EMAIL, 6, 6, 6},
    {LINE_ENDING, 6, 7, 7},
  };
  expect_tokens(input, 7, cases, sizeof(cases) / sizeof(cases[0]));
}

static void test_bounded_line_description_keeps_every_step(void) {
  const int32_t input[] =
    {'N', '<', 'a', '>', 'M', '<', 'b', '>', 't', '#', 'c', 0, 'z'};
  const Step expected[STEPS] = {
    {0, 0, PAIRED_MAPPING_START},
    {0, 0, NAME_START},
    {0, 1, NAME_TEXT},
    {1, 1, NAME_END},
    {1, 1, MISSING_NAME_SEPARATOR},
    {1, 2, EMAIL_OPEN},
    {2, 3, EMAIL_TEXT},
    {3, 4, EMAIL_CLOSE},
    {4, 4, NAME_START},
    {4, 5, NAME_TEXT},
    {5, 5, NAME_END},
    {5, 5, MISSING_NAME_SEPARATOR},
    {5, 6, EMAIL_OPEN},
    {6, 7, EMAIL_TEXT},
    {7, 8, EMAIL_CLOSE},
    {8, 8, IGNORED_START},
    {8, 9, IGNORED_TEXT},
    {9, 9, IGNORED_END},
    {9, 9, COMMENT_START},
    {9, 10, COMMENT_MARKER},
    {10, 11, COMMENT_TEXT},
    {11, 11, COMMENT_END},
    {11, 11, IGNORED_START},
    {11, 13, IGNORED_TEXT},
    {13, 13, IGNORED_END},
    {13, 13, END_OF_FILE},
  };
  struct MockLexer mock;
  init_mock_lexer(&mock, input, sizeof(input) / sizeof(input[0]));
  Scanner scanner = {0};
  bool valid[ERROR_SENTINEL + 1] = {false};
  valid[LINE_START] = true;
  assert(
    tree_sitter_mailmap_external_scanner_scan(&scanner, &mock.lexer, valid)
  );
  assert(scanner.count == STEPS);
  assert(memcmp(scanner.steps, expected, sizeof(expected)) == 0);
}

#ifdef TREE_SITTER_REUSE_ALLOCATOR
static void test_reused_allocator_failure_and_cleanup(void) {
  assert(reuse_live_allocations == 0);
  reuse_fail_next_calloc = true;
  assert(tree_sitter_mailmap_external_scanner_create() == NULL);
  void *scanner = tree_sitter_mailmap_external_scanner_create();
  assert(scanner != NULL && reuse_live_allocations == 1);
  tree_sitter_mailmap_external_scanner_destroy(scanner);
  assert(reuse_live_allocations == 0);
}
#endif

int main(void) {
  test_internal_lexer_accepts_eof_only_at_input_end();
  test_lifecycle_and_serialization_round_trip();
  test_failed_and_recovery_scans_preserve_state();
  test_restored_tokens_preserve_ranges_and_finish_at_eof();
  test_text_runs_look_ahead_over_the_opposite_run();
  test_bounded_line_description_keeps_every_step();
#ifdef TREE_SITTER_REUSE_ALLOCATOR
  test_reused_allocator_failure_and_cleanup();
#endif
  return 0;
}
