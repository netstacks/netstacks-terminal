import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import './MarkdownViewer.css';

interface MarkdownViewerProps {
  content: string;
  isEditing?: boolean;
  onChange?: (content: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
}

export default function MarkdownViewer({
  content,
  isEditing = false,
  onChange,
  onSave,
  onCancel,
}: MarkdownViewerProps) {
  if (isEditing && onChange) {
    return (
      <div className="markdown-editor">
        <div className="markdown-editor-toolbar">
          {onSave && (
            <button className="markdown-editor-btn save" onClick={onSave}>
              Save
            </button>
          )}
          {onCancel && (
            <button className="markdown-editor-btn cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
        <textarea
          className="markdown-editor-textarea"
          value={content}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className="markdown-viewer">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Custom table styling
          table: ({ children }) => (
            <div className="markdown-table-wrapper">
              <table>{children}</table>
            </div>
          ),
          // Custom code block
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="markdown-inline-code" {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          // Custom link handling - open in external browser
          a: ({ href, children, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
