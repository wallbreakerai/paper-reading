"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useMemo,
  type ReactNode,
} from "react";
import katex from "katex";
import ReactMarkdown from "react-markdown";
import remarkGfmImport from "remark-gfm";
import "katex/dist/katex.min.css";

const remarkGfm =
  ((remarkGfmImport as { default?: typeof remarkGfmImport }).default ??
    remarkGfmImport) as typeof remarkGfmImport;

type Props = {
  content: string;
  streaming?: boolean;
};

const MATH_PH = "⟦KATEX";
const MATH_PH_RE = /⟦KATEX(\d+)⟧/g;

/** Markdown collapses lone newlines; turn them into hard breaks for chat. */
function withHardLineBreaks(content: string): string {
  return content.replace(/([^\n])\n(?!\n)/g, "$1  \n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
  } catch {
    return displayMode
      ? `<pre class="chat-md-math-fallback">${escapeHtml(tex)}</pre>`
      : `<code class="chat-md-code">${escapeHtml(tex)}</code>`;
  }
}

/**
 * Pull math out before Markdown (progress-style remark-gfm), then reinject
 * KaTeX HTML into text nodes — avoids $B_r$ underscores and rehype-raw issues.
 */
function extractMath(content: string): { text: string; htmls: string[] } {
  const htmls: string[] = [];
  const fences: string[] = [];
  const codes: string[] = [];

  let s = content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => {
      return `\n$$\n${inner.trim()}\n$$\n`;
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner: string) => {
      return `$${inner.trim()}$`;
    });

  s = s.replace(/```[\s\S]*?```/g, (m) => {
    const i = fences.length;
    fences.push(m);
    return `\uE020${i}\uE021`;
  });
  s = s.replace(/`[^`\n]+`/g, (m) => {
    const i = codes.length;
    codes.push(m);
    return `\uE022${i}\uE023`;
  });

  const push = (tex: string, displayMode: boolean) => {
    const i = htmls.length;
    htmls.push(renderKatex(tex, displayMode));
    return `${MATH_PH}${i}⟧`;
  };

  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => push(tex, true));
  s = s.replace(/\$((?:\\\$|[^$\n])+?)\$/g, (_m, tex: string) =>
    push(tex, false),
  );

  s = s.replace(/\uE022(\d+)\uE023/g, (_m, i: string) => codes[Number(i)] || "");
  s = s.replace(/\uE020(\d+)\uE021/g, (_m, i: string) => fences[Number(i)] || "");

  return { text: s, htmls };
}

function injectMathIntoString(text: string, htmls: string[]): ReactNode {
  if (!text.includes(MATH_PH)) return text;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(MATH_PH_RE.source, "g");
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const html = htmls[Number(m[1])] || "";
    nodes.push(
      <span
        key={`k-${m.index}-${m[1]}`}
        className="chat-md-katex"
        dangerouslySetInnerHTML={{ __html: html }}
      />,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length === 1 ? nodes[0] : nodes;
}

function injectMath(children: ReactNode, htmls: string[]): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return injectMathIntoString(child, htmls);
    if (typeof child === "number") return child;
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    return cloneElement(child, {
      ...child.props,
      children: injectMath(child.props.children, htmls),
    });
  });
}

export function ChatMarkdown({ content, streaming = false }: Props) {
  const { text, htmls } = useMemo(() => extractMath(content), [content]);
  const prepared = useMemo(() => withHardLineBreaks(text), [text]);
  const withMath = (children: ReactNode) => injectMath(children, htmls);

  if (streaming) {
    return <div className="chat-md chat-md-streaming">{content}</div>;
  }

  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{withMath(children)}</p>,
          li: ({ children }) => <li>{withMath(children)}</li>,
          strong: ({ children }) => <strong>{withMath(children)}</strong>,
          em: ({ children }) => <em>{withMath(children)}</em>,
          h1: ({ children }) => <h1>{withMath(children)}</h1>,
          h2: ({ children }) => <h2>{withMath(children)}</h2>,
          h3: ({ children }) => <h3>{withMath(children)}</h3>,
          h4: ({ children }) => <h4>{withMath(children)}</h4>,
          td: ({ children }) => <td>{withMath(children)}</td>,
          th: ({ children }) => <th>{withMath(children)}</th>,
          blockquote: ({ children }) => (
            <blockquote>{withMath(children)}</blockquote>
          ),
          ul: ({ children }) => <ul>{children}</ul>,
          ol: ({ children }) => <ol>{children}</ol>,
          code: ({ children, className }) => {
            const block = Boolean(className);
            return block ? (
              <code className="chat-md-code-block">{children}</code>
            ) : (
              <code className="chat-md-code">{children}</code>
            );
          },
          pre: ({ children }) => <pre className="chat-md-pre">{children}</pre>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {withMath(children)}
            </a>
          ),
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}
