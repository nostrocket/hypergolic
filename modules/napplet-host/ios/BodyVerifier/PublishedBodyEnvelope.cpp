#include "PublishedBodyEnvelope.h"
#include <algorithm>
#include <cstdint>
#include <string_view>
#include <vector>

namespace {
using Text = std::string_view;
constexpr size_t missing = Text::npos;
char lower(char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c + ('a' - 'A')) : c; }
bool letter(char c) { return lower(c) >= 'a' && lower(c) <= 'z'; }
bool nameChar(char c) { return letter(c) || (c >= '0' && c <= '9') || c == '-' || c == ':'; }
bool same(Text a, Text b) {
  return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin(), [](char l, char r) { return lower(l) == lower(r); });
}
bool member(Text name, Text words) {
  size_t start = 0;
  while (start < words.size()) {
    const auto end = words.find(' ', start);
    if (same(name, words.substr(start, end - start))) return true;
    if (end == missing) break;
    start = end + 1;
  }
  return false;
}
bool asciiSpace(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f'; }
bool utf8(Text s) {
  for (size_t i = 0; i < s.size();) {
    const unsigned char first = s[i++];
    if (first < 128) continue;
    if (first < 0xc2 || first > 0xf4 || i == s.size()) return false;
    const unsigned char second = s[i];
    if ((first == 0xe0 && second < 0xa0) || (first == 0xed && second > 0x9f) ||
        (first == 0xf0 && second < 0x90) || (first == 0xf4 && second > 0x8f)) return false;
    const size_t width = first < 0xe0 ? 1 : first < 0xf0 ? 2 : 3;
    if (width > s.size() - i) return false;
    for (size_t j = 0; j < width; j++) if ((static_cast<unsigned char>(s[i++]) & 0xc0) != 0x80) return false;
  }
  return true;
}
// The document head uses HTML ASCII whitespace. The balanced envelope uses ECMAScript whitespace.
size_t space(Text s, size_t i) {
  if (i >= s.size()) return 0;
  if (asciiSpace(s[i]) || s[i] == '\v') return 1;
  const auto part = s.substr(i, 3);
  if (part.substr(0, 2) == "\xc2\xa0") return 2;
  if (part.size() == 3 && (part == "\xe1\x9a\x80" || part == "\xe2\x80\xaf" || part == "\xe2\x81\x9f" ||
      part == "\xe3\x80\x80" || part == "\xef\xbb\xbf" ||
      (part.substr(0, 2) == "\xe2\x80" && ((static_cast<unsigned char>(part[2]) >= 0x80 &&
      static_cast<unsigned char>(part[2]) <= 0x8a) || part[2] == '\xa8' || part[2] == '\xa9')))) return 3;
  return 0;
}
size_t skipSpace(Text s, size_t i) { while (const size_t n = space(s, i)) i += n; return i; }
void asciiSpaces(Text s, size_t& i) { while (i < s.size() && asciiSpace(s[i])) ++i; }
bool word(Text s, size_t& i, Text expected) {
  if (!same(s.substr(i, expected.size()), expected)) return false;
  i += expected.size(); return true;
}
bool headTrivia(Text s, size_t& i) {
  for (;;) {
    asciiSpaces(s, i);
    if (s.substr(i, 4) != "<!--") return true;
    const auto end = s.find("-->", i + 4);
    if (end == missing) return false;
    const auto comment = s.substr(i + 4, end - i - 4);
    if (comment.substr(0, 1) == ">" || comment.substr(0, 2) == "->" ||
        (comment.size() >= 3 && comment.substr(comment.size() - 3) == "<!-") ||
        comment.find("<!--") != missing || comment.find("--!>") != missing || comment.find('\0') != missing) return false;
    i = end + 3;
  }
}
bool headTag(Text s, size_t& i, Text name) {
  if (!headTrivia(s, i) || !word(s, i, "<") || !word(s, i, name)) return false;
  while (i < s.size()) {
    const auto start = i;
    asciiSpaces(s, i);
    if (i < s.size() && s[i] == '>') { ++i; return true; }
    if (start == i || i == s.size() || !letter(s[i])) return false;
    while (i < s.size() && nameChar(s[i])) ++i;
    asciiSpaces(s, i);
    if (!word(s, i, "=")) return false;
    asciiSpaces(s, i);
    if (i == s.size() || (s[i] != '"' && s[i] != '\'')) return false;
    const char quote = s[i++];
    while (i < s.size() && s[i] != quote) { if (s[i] == '<' || s[i] == '>') return false; ++i; }
    if (i == s.size()) return false;
    ++i;
  }
  return false;
}
enum class Context { html, svg, math };
// All tag names refer into the same immutable, at-most-20 MiB document.
struct Tag {
  uint32_t startAndContext;
  Tag(size_t first, Context children)
      : startAndContext(static_cast<uint32_t>(first) << 2 | static_cast<uint32_t>(children)) {}
  Context children() const { return static_cast<Context>(startAndContext & 3); }
  bool matches(Text document, Text wanted) const {
    const size_t first = startAndContext >> 2;
    const size_t after = first + wanted.size();
    return after < document.size() && !nameChar(document[after]) && same(document.substr(first, wanted.size()), wanted);
  }
};
static_assert(sizeof(Tag) == sizeof(uint32_t));
constexpr Text voids = "area base br col embed hr img input link meta param source track wbr";
constexpr Text graphics = "circle ellipse line path polygon polyline rect stop use";
constexpr Text svgBreakouts = "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var";

bool fontBreakout(Text tag) {
  char quote = 0;
  for (size_t i = 0; i < tag.size();) {
    const auto n = space(tag, i);
    const char c = tag[i];
    if (quote) { if (c == quote) quote = 0; ++i; continue; }
    if (c == '"' || c == '\'') { quote = c; ++i; continue; }
    if (!n) { ++i; continue; }
    i += n;
    for (auto attribute : {Text("color"), Text("face"), Text("size")}) {
      size_t after = i;
      if (word(tag, after, attribute) && after < tag.size() &&
          (space(tag, after) || tag[after] == '=' || tag[after] == '/' || tag[after] == '>')) return true;
    }
  }
  return false;
}
bool selfClosing(Text s, size_t nameEnd) {
  size_t end = s.size() - 1;
  // Whitespace between the slash and final greater-than is accepted by the byte verifier.
  const size_t slash = s.rfind('/', end);
  if (slash == missing || skipSpace(s, slash + 1) != end) return false;
  if (slash == nameEnd || (slash && (s[slash - 1] == '"' || s[slash - 1] == '\''))) return true;
  for (size_t n = 1; n <= 3 && n <= slash; ++n) if (space(s, slash - n) == n) return true;
  return false;
}
bool balanced(Text s, size_t cursor) {
  std::vector<Tag> stack;
  bool html = false, head = false, body = false;
  while (cursor < s.size()) {
    // Every open element still needs at least four bytes for its closing tag.
    if (stack.size() > (s.size() - cursor) / 4) return false;
    const size_t start = s.find('<', cursor);
    if (stack.empty() && skipSpace(s, cursor) != (start == missing ? s.size() : start)) return false;
    if (start == missing) break;
    if (s.substr(start, 4) == "<!--") {
      const auto end = s.find("-->", start + 4);
      if (end == missing) return false;
      cursor = end + 3; continue;
    }
    size_t i = start + 1;
    const bool closing = i < s.size() && s[i] == '/';
    if (closing) ++i;
    if (i == s.size() || !letter(s[i])) return false;
    const size_t first = i;
    while (i < s.size() && nameChar(s[i])) ++i;
    const Text name = s.substr(first, i - first);
    const size_t nameEnd = i;
    if (closing) {
      i = skipSpace(s, i);
      if (i == s.size() || s[i] != '>' || stack.empty() || !stack.back().matches(s, name)) return false;
      stack.pop_back(); cursor = i + 1; continue;
    }
    if (i == s.size() || (!space(s, i) && s[i] != '/' && s[i] != '>')) return false;
    char quote = 0;
    for (; i < s.size(); ++i) {
      const char c = s[i];
      if (quote) { if (c == quote) quote = 0; }
      else if (c == '"' || c == '\'') quote = c;
      else if (c == '<') return false;
      else if (c == '>') break;
    }
    if (i == s.size()) return false;
    const Text tag = s.substr(start, i + 1 - start);
    Context ns = stack.empty() ? Context::html : stack.back().children();
    if (ns == Context::html && same(name, "svg")) ns = Context::svg;
    else if (ns == Context::html && same(name, "math")) ns = Context::math;
    const bool svg = ns == Context::svg;
    if (svg && (member(name, svgBreakouts) || (same(name, "font") && fontBreakout(tag)))) return false;
    const bool empty = !svg && member(name, voids);
    const bool self = selfClosing(tag, nameEnd - start);
    if (self && !empty && !(svg && member(name, graphics) && s[i - 1] == '/')) return false;
    const bool parentHtml = !stack.empty() && stack.back().matches(s, "html");
    if (same(name, "html")) { if (html || !stack.empty()) return false; html = true; }
    if (same(name, "head")) { if (head || !parentHtml || body) return false; head = true; }
    if (same(name, "body")) { if (body || !parentHtml || !head) return false; body = true; }
    if (!self && !empty) stack.emplace_back(first, svg && member(name, "desc foreignobject title") ? Context::html : ns);
    cursor = i + 1;
    if (member(name, "script style textarea title") && !(svg && same(name, "title"))) {
      for (;;) {
        cursor = s.find("</", cursor);
        if (cursor == missing) return false;
        size_t after = cursor + 2;
        if (word(s, after, name) && (after = skipSpace(s, after)) < s.size() && s[after] == '>') break;
        cursor += 2;
      }
    }
  }
  return stack.empty() && html && head && body;
}
}
extern "C" int hg_published_html_valid(const uint8_t *bytes, size_t length) {
  if (!bytes || !length || length > 20 * 1024 * 1024) return 0;
  try {
    const Text text(reinterpret_cast<const char *>(bytes), length);
    if (!utf8(text)) return 0;
    size_t i = text.substr(0, 3) == "\xef\xbb\xbf" ? 3 : 0;
    asciiSpaces(text, i);
    if (!word(text, i, "<!doctype") || i == text.size() || !asciiSpace(text[i])) return 0;
    asciiSpaces(text, i);
    if (!word(text, i, "html")) return 0;
    asciiSpaces(text, i);
    if (!word(text, i, ">")) return 0;
    const size_t afterDoctype = i;
    return headTag(text, i, "html") && headTag(text, i, "head") && balanced(text, afterDoctype);
  } catch (...) { return 0; }
}
