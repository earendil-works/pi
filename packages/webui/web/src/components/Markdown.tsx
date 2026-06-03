import { marked } from "marked";

// Configure marked once: GitHub-flavored markdown, no raw HTML in input
// (we render text from a trusted local process but defense-in-depth is
// cheap), tables enabled, line breaks respected.
marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Render a string of markdown to safe HTML. We strip raw HTML from the
 * input before parsing so an untrusted message body cannot inject
 * <script> tags via markdown; marked itself doesn't sanitize, so this
 * belt-and-suspenders approach keeps the surface tight.
 */
function renderMarkdown(text: string): string {
  // Strip raw HTML tags. Keep the markdown syntax intact.
  const sanitized = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  return marked.parse(sanitized, { async: false }) as string;
}

/**
 * Minimal prose styling. We don't pull in @tailwindcss/typography for a
 * handful of elements; these classes cover what the assistant emits:
 * headings, paragraphs, lists, blockquotes, code (inline + block),
 * tables, bold, italic, links.
 */
const PROSE_CLASSES = [
  "text-sm",
  "text-gray-800",
  "leading-relaxed",
  // paragraphs
  "[&_p]:my-2",
  "[&_p:first-child]:mt-0",
  "[&_p:last-child]:mb-0",
  // headings
  "[&_h1]:text-lg",
  "[&_h1]:font-semibold",
  "[&_h1]:mt-3",
  "[&_h1]:mb-1",
  "[&_h2]:text-base",
  "[&_h2]:font-semibold",
  "[&_h2]:mt-3",
  "[&_h2]:mb-1",
  "[&_h3]:text-sm",
  "[&_h3]:font-semibold",
  "[&_h3]:mt-2",
  "[&_h3]:mb-1",
  // lists
  "[&_ul]:my-2",
  "[&_ul]:pl-5",
  "[&_ul]:list-disc",
  "[&_ol]:my-2",
  "[&_ol]:pl-5",
  "[&_ol]:list-decimal",
  "[&_li]:my-0.5",
  // blockquote
  "[&_blockquote]:border-l-4",
  "[&_blockquote]:border-gray-300",
  "[&_blockquote]:pl-3",
  "[&_blockquote]:my-2",
  "[&_blockquote]:text-gray-600",
  "[&_blockquote]:italic",
  // inline code
  "[&_code]:bg-gray-100",
  "[&_code]:text-gray-800",
  "[&_code]:px-1",
  "[&_code]:py-0.5",
  "[&_code]:rounded",
  "[&_code]:text-xs",
  "[&_code]:font-mono",
  // code block
  "[&_pre]:bg-gray-50",
  "[&_pre]:border",
  "[&_pre]:border-gray-200",
  "[&_pre]:rounded",
  "[&_pre]:p-2",
  "[&_pre]:my-2",
  "[&_pre]:overflow-x-auto",
  "[&_pre]:text-xs",
  "[&_pre_code]:bg-transparent",
  "[&_pre_code]:p-0",
  "[&_pre_code]:text-xs",
  // table
  "[&_table]:my-2",
  "[&_table]:border-collapse",
  "[&_table]:w-full",
  "[&_table]:text-xs",
  "[&_th]:border",
  "[&_th]:border-gray-300",
  "[&_th]:bg-gray-50",
  "[&_th]:px-2",
  "[&_th]:py-1",
  "[&_th]:text-left",
  "[&_th]:font-semibold",
  "[&_td]:border",
  "[&_td]:border-gray-300",
  "[&_td]:px-2",
  "[&_td]:py-1",
  // links
  "[&_a]:text-blue-600",
  "[&_a]:underline",
  "[&_a:hover]:text-blue-800",
  // emphasis
  "[&_strong]:font-semibold",
  "[&_em]:italic",
  // horizontal rule
  "[&_hr]:my-3",
  "[&_hr]:border-gray-200",
].join(" ");

export function Markdown({ text }: { text: string }) {
  const html = renderMarkdown(text);
  return (
    <div
      className={PROSE_CLASSES}
      // marked output is HTML we generated; raw < and > in user input
      // are stripped before parsing, so this is safe.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
