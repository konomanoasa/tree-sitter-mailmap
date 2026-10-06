#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"
#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum Token {
  LINE_START,
  SIMPLE_MAPPING_START,
  PAIRED_MAPPING_START,
  BLANK_START,
  COMMENT_LINE_START,
  NAME_START,
  NAME_END,
  COMMENT_START,
  COMMENT_END,
  IGNORED_START,
  IGNORED_END,
  LAYOUT,
  END_OF_FILE,
  LINE_ENDING,
  NAME_TEXT,
  EMAIL_OPEN,
  EMAIL_TEXT,
  EMAIL_CLOSE,
  COMMENT_MARKER,
  COMMENT_TEXT,
  IGNORED_TEXT,
  INVALID_ENCODING,
  MISSING_NAME_SEPARATOR,
  MISSING_EMAIL_TEXT,
  INCOMPLETE_EMAIL_TEXT,
  MISSING_EMAIL_CLOSE,
  INCOMPLETE_EMAIL_CLOSE,
  MISSING_COMMIT_EMAIL,
  INCOMPLETE_COMMIT_EMAIL,
  ERROR_SENTINEL,
};

#define NONE UINT32_MAX

typedef struct {
  uint32_t start, end, token;
} Step;

// Max steps: names 6, emails 6, suffixes 6, comment 4, separators 2,
// line start 1, ending 1.
enum { STEPS = 26 };

// Positions are character offsets from the physical line start.
typedef struct {
  uint32_t position, count, index;
  Step steps[STEPS];
} Scanner;

typedef char scanner_fits_buffer
  [sizeof(Scanner) <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE ? 1 : -1];

static bool space(int32_t c) {
  return c == ' ' || c == '\t' || c == '\r';
}

static bool textual(uint32_t token) {
  switch (token) {
  case NAME_TEXT:
  case EMAIL_TEXT:
  case COMMENT_TEXT:
  case IGNORED_TEXT:
    return true;
  default:
    return false;
  }
}

static void advance(Scanner *s, TSLexer *lexer) {
  lexer->advance(lexer, false);
  s->position++;
}

static bool accept(TSLexer *lexer, uint32_t token) {
  lexer->result_symbol = (TSSymbol)token;
  return true;
}

static void push(Scanner *s, enum Token token, uint32_t start, uint32_t end) {
  s->steps[s->count++] = (Step){.start = start, .end = end, .token = token};
}

static void span(
  Scanner *s,
  enum Token start,
  enum Token text,
  enum Token end,
  uint32_t from,
  uint32_t to
) {
  if (from >= to)
    return;
  push(s, start, from, from);
  push(s, text, from, to);
  push(s, end, to, to);
}

static void
email(Scanner *s, uint32_t open, uint32_t close, uint32_t end, bool first) {
  const uint32_t text_end = close == NONE ? end : close;
  push(s, EMAIL_OPEN, open, open + 1);
  if (open + 1 < text_end)
    push(s, EMAIL_TEXT, open + 1, text_end);
  else if (first)
    push(s, MISSING_EMAIL_TEXT, text_end, text_end);
  if (close == NONE)
    push(s, MISSING_EMAIL_CLOSE, text_end, text_end);
  else
    push(s, EMAIL_CLOSE, close, close + 1);
}

static void describe(Scanner *s, TSLexer *lexer) {
  *s = (Scanner){0};
  uint32_t open[2] = {NONE, NONE};
  uint32_t close[2] = {NONE, NONE};
  uint32_t word_start[3] = {NONE, NONE, NONE};
  uint32_t word_end[3] = {0, 0, 0};
  uint32_t comment = NONE, nul = NONE;
  unsigned region = 0;
  int32_t last = 0;
  lexer->mark_end(lexer);
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    const int32_t c = lexer->lookahead;
    if (nul == NONE && c == 0)
      nul = s->position;
    if (nul == NONE && comment == NONE) {
      const unsigned word = region / 2;
      if (c == '#') {
        comment = s->position;
      } else if (region < 4 && region % 2 == 0 && c == '<') {
        open[word] = s->position;
        region++;
      } else if (region % 2 == 1 && c == '>') {
        close[word] = s->position;
        region++;
      } else if (region % 2 == 0 && !space(c)) {
        if (word_start[word] == NONE)
          word_start[word] = s->position;
        word_end[word] = s->position + 1;
      }
    }
    last = c;
    advance(s, lexer);
  }
  const bool eof = lexer->eof(lexer);
  const uint32_t content_end = s->position - (last == '\r' && !eof ? 1 : 0);
  const uint32_t line_end = s->position + (eof ? 0 : 1);
  const uint32_t comment_end = nul < content_end ? nul : content_end;
  const uint32_t end = comment < comment_end ? comment : comment_end;
  const bool has_name = word_start[0] < word_end[0];
  const bool has_email = open[0] != NONE;
  if (has_name || has_email) {
    const unsigned email_count = open[1] != NONE || !has_name ? 2 : 1;
    push(
      s,
      email_count == 2 ? PAIRED_MAPPING_START : SIMPLE_MAPPING_START,
      0,
      0
    );
    for (unsigned word = 0; word < email_count; word++) {
      span(
        s,
        NAME_START,
        NAME_TEXT,
        NAME_END,
        word_start[word],
        word_end[word]
      );
      if (open[word] == NONE) {
        push(s, MISSING_COMMIT_EMAIL, end, end);
        continue;
      }
      if (word_start[word] < word_end[word] && word_end[word] == open[word])
        push(s, MISSING_NAME_SEPARATOR, open[word], open[word]);
      email(s, open[word], close[word], end, word == 0);
    }
    span(
      s,
      IGNORED_START,
      IGNORED_TEXT,
      IGNORED_END,
      word_start[email_count],
      word_end[email_count]
    );
  } else {
    push(s, comment < nul ? COMMENT_LINE_START : BLANK_START, 0, 0);
  }
  if (comment < comment_end) {
    push(s, COMMENT_START, comment, comment);
    push(s, COMMENT_MARKER, comment, comment + 1);
    if (comment + 1 < comment_end)
      push(s, COMMENT_TEXT, comment + 1, comment_end);
    push(s, COMMENT_END, comment_end, comment_end);
  }
  span(s, IGNORED_START, IGNORED_TEXT, IGNORED_END, nul, content_end);
  if (line_end > content_end)
    push(s, LINE_ENDING, content_end, line_end);
  else
    push(s, END_OF_FILE, content_end, content_end);
  s->position = 0;
}

static uint32_t outcome(TSLexer *lexer, uint32_t token) {
  if (!lexer->eof(lexer))
    return token;
  switch (token) {
  case MISSING_EMAIL_TEXT:
    return INCOMPLETE_EMAIL_TEXT;
  case MISSING_EMAIL_CLOSE:
    return INCOMPLETE_EMAIL_CLOSE;
  case MISSING_COMMIT_EMAIL:
    return INCOMPLETE_COMMIT_EMAIL;
  default:
    return token;
  }
}

static bool
text(Scanner *s, TSLexer *lexer, const bool *valid, const Step *step) {
  const bool invalid = lexer->lookahead == -1;
  const uint32_t token = invalid ? INVALID_ENCODING : step->token;
  if (!valid[token])
    return false;
  do {
    advance(s, lexer);
  } while (s->position < step->end && (lexer->lookahead == -1) == invalid);
  lexer->mark_end(lexer);
  // Look past the opposite run to invalidate edits inside decoded characters.
  for (
    uint32_t ahead = s->position;
    ahead < step->end && (lexer->lookahead == -1) != invalid;
    ahead++
  )
    lexer->advance(lexer, false);
  if (s->position == step->end)
    s->index++;
  return accept(lexer, token);
}

static unsigned serialized_length(const Scanner *s) {
  return (unsigned)(offsetof(Scanner, steps) + s->count * sizeof(Step));
}

void *tree_sitter_mailmap_external_scanner_create(void) {
  return ts_calloc(1, sizeof(Scanner));
}

void tree_sitter_mailmap_external_scanner_destroy(void *payload) {
  ts_free(payload);
}

unsigned
tree_sitter_mailmap_external_scanner_serialize(void *payload, char *buffer) {
  const unsigned length = serialized_length(payload);
  memcpy(buffer, payload, length);
  return length;
}

void tree_sitter_mailmap_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  Scanner *s = payload;
  memset(s, 0, sizeof(Scanner));
  if (length < offsetof(Scanner, steps) || length > sizeof(Scanner))
    return;
  memcpy(s, buffer, length);
  if (length != serialized_length(s))
    memset(s, 0, sizeof(Scanner));
}

bool tree_sitter_mailmap_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid
) {
  Scanner *s = payload;
  if (valid[ERROR_SENTINEL])
    return false;
  if (s->count == 0) {
    if (lexer->eof(lexer) || !valid[LINE_START])
      return false;
    describe(s, lexer);
    return accept(lexer, LINE_START);
  }
  lexer->mark_end(lexer);
  const Step *step = &s->steps[s->index];
  if (s->position < step->start) {
    if (!valid[LAYOUT])
      return false;
    while (s->position < step->start)
      advance(s, lexer);
    lexer->mark_end(lexer);
    return accept(lexer, LAYOUT);
  }
  if (textual(step->token))
    return text(s, lexer, valid, step);
  const uint32_t token = outcome(lexer, step->token);
  if (!valid[token])
    return false;
  while (s->position < step->end)
    advance(s, lexer);
  lexer->mark_end(lexer);
  if (++s->index == s->count)
    *s = (Scanner){0};
  return accept(lexer, token);
}
