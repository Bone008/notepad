import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Viewer({ text }: { text: string }) {
  return (
    <article className="viewer markdown" data-testid="viewer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </article>
  );
}
