/**
 * One pass over a JavaScript or TypeScript file, separating code from the things
 * that only look like it.
 *
 * Two checkers here read source text and neither can afford to be fooled by the
 * same characters. `references.mjs` wants the comments and nothing else, because
 * a path in a string literal is data rather than a note. `exports.mjs` wants the
 * module specifiers and nothing else, because a specifier named in a comment or
 * quoted inside a prompt is not an import. Those are the same question asked from
 * both ends, so the answer has one home: this lexer classifies the text once and
 * each checker reads the half it needs.
 *
 * A lexer rather than a parser, and string-aware because it has to be: `"image/*"`
 * is a real value in this train, and a scan that does not track quotes reads it
 * as opening a block comment and runs to the next `*​/`. Template interpolations
 * are tracked too, by brace depth, so a nested template literal cannot end the
 * outer one early and shift every span after it. The text inside a `${…}` is code
 * and is returned as code, because it is: an `import()` can live there.
 *
 * **Regex literals are read, because every delimiter can appear inside one.** A
 * `` /[`]/ `` is the worst of them: taken for a template literal it opens a frame
 * that no newline closes, and the scan then goes blind to the next backtick in the
 * file, which is a comment disappearing rather than a failure anybody sees. `[/*]`
 * and `/\/*$/` are the other direction, a comment opening inside a regex and
 * swallowing the code after it, which hides every import below it from a publish
 * gate. So a `/` in a regex position is consumed with its escapes and its
 * character classes, and `regexEnd` holds what bounds a wrong guess.
 *
 * Comments win over a regex, which is the language's own order: `//` and `/*` are
 * always comments, and an empty regex has to be written `/(?:)/`. The guards below
 * stay as a second rule each, for the case where the `/` was read as division.
 */

/** Characters that can end a value, after which a `/` divides. */
const VALUE_END = /[\w$)\]]/;

/** Names that take an expression after them, so a `/` there opens a regex. */
const KEYWORD_BEFORE_REGEX =
  /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

/**
 * Where the regex literal opening at `from` closes, or -1 if it does not.
 *
 * A regex literal cannot carry a raw newline, so running into one means that `/`
 * divided after all. That is what bounds a wrong guess about which it was to the
 * line the guess was made on, the same way an unterminated quote is bounded.
 */
function regexEnd(text, from) {
  let inClass = false;
  for (let i = from + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") i += 1;
    else if (c === "\n") return -1;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "/") return i;
  }
  return -1;
}

/**
 * The comments, the string literals, and the code with everything that is not
 * code blanked out.
 *
 * `code` is the same length as the input, with every comment, every regex
 * literal and the *contents* of every string literal replaced by spaces, and
 * newlines kept. Equal length is the point: an offset into `code` is an offset
 * into the file, so a caller can ask what precedes a string literal without a
 * second pass, and a line counted from an offset still names the right line.
 *
 * A string's delimiters stay, and that is not cosmetic: blanking them too would
 * leave a run of whitespace where the string was, and a caller asking what code
 * precedes a specifier would read straight through it.
 *
 * A string literal is recorded only where it closed. A `'` or `"` left open at
 * the end of a line was never a string, which is the language's own rule and is
 * what bounds a misread quote to the line it happened on; `interpolated` marks a
 * template literal carrying a `${…}`, whose value is not a literal at all.
 */
export function lex(text) {
  const comments = [];
  const strings = [];
  const code = [...text];

  /** Blank [from, to) in `code`, keeping newlines so offsets and lines both hold. */
  const blank = (from, to) => {
    for (let at = from; at < to && at < code.length; at += 1)
      if (code[at] !== "\n") code[at] = " ";
  };

  /** Open quotes and interpolations, innermost last. */
  const stack = [];
  /** Whether the last token read could end a value. See `VALUE_END`. */
  let valueBefore = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const frame = stack.at(-1);

    if (frame?.quote) {
      if (c === "\\") {
        blank(i, i + 2);
        i += 1;
      }
      // A `'` or `"` string cannot carry a raw newline, so one still open at the
      // end of a line was never a string: the quote was a character inside
      // something this read as code. Closing it here is the language's own rule,
      // and it bounds that to the line it happened on. Without it, a `"` inside a
      // regex went on swallowing text to the next quote in the file, which cost a
      // doc comment and the reference in it.
      else if (frame.quote !== "`" && c === "\n") stack.pop();
      else if (frame.quote === "`" && c === "$" && text[i + 1] === "{") {
        frame.interpolated = true;
        stack.push({ braces: 0 });
        i += 1;
      } else {
        if (c === frame.quote) {
          stack.pop();
          strings.push({
            start: frame.start,
            end: i,
            quote: frame.quote,
            value: text.slice(frame.start + 1, i),
            interpolated: frame.interpolated === true
          });
          valueBefore = true;
        } else blank(i, i + 1);
      }
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      stack.push({ quote: c, start: i });
      continue;
    }

    // Inside a `${…}`, so a `}` may be this interpolation's end rather than an
    // object literal's or a block's.
    if (frame && c === "{") {
      frame.braces += 1;
      continue;
    }
    if (frame && c === "}") {
      if (frame.braces === 0) stack.pop();
      else frame.braces -= 1;
      continue;
    }

    // The second rule, for a `/` this read as division when it was a regex: an
    // escaped slash is only ever inside one, so it opens nothing.
    if (c === "/" && text[i - 1] === "\\") continue;

    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      comments.push({ start: i, text: text.slice(i, stop) });
      blank(i, stop);
      i = stop - 1;
      continue;
    }

    // The same second rule for a line comment: a `//` opens one at the start of a
    // line or after whitespace, which is where every one prettier formats lives.
    if (
      c === "/" &&
      text[i + 1] === "/" &&
      (i === 0 || /\s/.test(text[i - 1]))
    ) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      comments.push({ start: i, text: text.slice(i, stop) });
      blank(i, stop);
      i = stop - 1;
      continue;
    }

    // Not a comment, so a `/` here is a regex literal or a division. Reading the
    // regex is what keeps its delimiters out of everything above.
    if (c === "/") {
      const regexHere =
        !valueBefore ||
        // `trimEnd`, because the keyword has whitespace after it: `return /x/`.
        KEYWORD_BEFORE_REGEX.test(text.slice(Math.max(0, i - 24), i).trimEnd());
      const end = regexHere ? regexEnd(text, i) : -1;
      if (end !== -1) {
        blank(i, end + 1);
        i = end;
        valueBefore = true;
        continue;
      }
    }

    if (!/\s/.test(c)) valueBefore = VALUE_END.test(c);
  }

  return { comments, strings, code: code.join("") };
}
