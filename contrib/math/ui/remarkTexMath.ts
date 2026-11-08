// Remark plugin: TeX math to `math-inline` and `math-display` elements.

import remarkMath from "remark-math";
import type { Code, Construct, Effects, Extension, State, TokenizeContext } from "micromark-util-types";
import type { CompileContext, Extension as FromMarkdownExtension, Token } from "mdast-util-from-markdown";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    texMath: "texMath";
    texMathMarker: "texMathMarker";
    texMathData: "texMathData";
  }
}

const BACKSLASH = 92;
const CLOSER: Record<number, number> = { 40: 41, 91: 93 }; // ( -> ), [ -> ]
const isLineEnding = (code: Code) => code !== null && code < -2;

// `\(…\)` and `\[…\]`: opener, TeX, matching closer.
const texMath: Construct = { name: "texMath", tokenize: tokenizeTexMath };

function tokenizeTexMath(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let close = 0;

  const closer: Construct = { tokenize: tokenizeCloser, partial: true };
  function tokenizeCloser(this: TokenizeContext, fx: Effects, done: State, fail: State): State {
    return (code) => {
      fx.enter("texMathMarker");
      fx.consume(code);
      return (next) => {
        if (next !== close) return fail(next);
        fx.consume(next);
        fx.exit("texMathMarker");
        return done(next);
      };
    };
  }

  return start;

  function start(code: Code) {
    effects.enter("texMath");
    effects.enter("texMathMarker");
    effects.consume(code);
    return open;
  }

  function open(code: Code) {
    if (code === null || !(code in CLOSER)) return nok(code);
    close = CLOSER[code];
    effects.consume(code);
    effects.exit("texMathMarker");
    return between;
  }

  function between(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === BACKSLASH) return effects.attempt(closer, after, escaped)(code);
    if (isLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("texMathData");
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === null || code === BACKSLASH || isLineEnding(code)) {
      effects.exit("texMathData");
      return between(code);
    }
    effects.consume(code);
    return data;
  }

  // A non-closing backslash escape is TeX, both characters.
  function escaped(code: Code) {
    effects.enter("texMathData");
    effects.consume(code);
    return (next: Code) => {
      if (next === null || isLineEnding(next)) return data(next);
      effects.consume(next);
      return data;
    };
  }

  function after(code: Code) {
    effects.exit("texMath");
    return ok(code);
  }
}

const syntax: Extension = { text: { [BACKSLASH]: texMath } };

const fromMarkdown: FromMarkdownExtension = {
  enter: {
    texMath(this: CompileContext, token: Token) {
      this.enter({ type: "inlineMath", value: "" }, token);
      this.buffer();
    },
  },
  exit: {
    texMath(this: CompileContext, token: Token) {
      this.resume();
      const source = this.sliceSerialize(token);
      const node = this.stack[this.stack.length - 1] as { value: string; data?: { display?: boolean } };
      node.value = source.slice(2, -2).trim();
      node.data = { display: source[1] === "[" };
      this.exit(token);
    },
  },
};

interface MdNode {
  type: string;
  lang?: string | null;
  value?: string;
  data?: Record<string, unknown> & { display?: boolean };
  children?: MdNode[];
}

const mathElement = (node: MdNode, display: boolean) => {
  node.data = {
    hName: display ? "math-display" : "math-inline",
    hProperties: {},
    hChildren: [{ type: "text", value: node.value ?? "" }],
  };
};

const toElements = (node: MdNode): void => {
  if (node.type === "inlineMath") mathElement(node, node.data?.display === true);
  else if (node.type === "math") mathElement(node, true);
  // As a `math` node, the fence loses its <pre> wrapper.
  else if (node.type === "code" && node.lang === "math") {
    node.type = "math";
    mathElement(node, true);
  }
  node.children?.forEach(toElements);
};

interface ProcessorData {
  micromarkExtensions?: Extension[];
  fromMarkdownExtensions?: FromMarkdownExtension[];
}

// remark-math without single `$`, plus `\(…\)` and `\[…\]`.
export default function remarkTexMath(this: unknown) {
  // `unknown`: unified's Processor type is not a UI dependency.
  remarkMath.call(this as never, { singleDollarTextMath: false });
  const data = (this as { data(): ProcessorData }).data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
  return (tree: MdNode) => toElements(tree);
}
