import React, { useState, useMemo } from 'react';
import { MessageSender } from '../types';
import { FileText, Edit3, Eye, Code, Copy, Check, Maximize, Minimize } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface NotepadProps {
  content: string;
  lastUpdatedBy?: MessageSender | null; // This prop is no longer used for display but kept for potential future logic
  isLoading: boolean;
  isNotepadFullscreen: boolean;
  onToggleFullscreen: () => void;
}

const Notepad: React.FC<NotepadProps> = ({ content, lastUpdatedBy, isLoading, isNotepadFullscreen, onToggleFullscreen }) => {
  const [isPreviewMode, setIsPreviewMode] = useState(true);
  const [isCopied, setIsCopied] = useState(false);

  // This function is no longer used for display but kept for potential future logic
  // const getSenderColor = (sender?: MessageSender | null) => {
  //   if (sender === MessageSender.Cognito) return 'text-green-600';
  //   if (sender === MessageSender.Muse) return 'text-purple-600';
  //   return 'text-gray-600';
  // };

  const processedHtml = useMemo(() => {
    if (isPreviewMode) {
      const rawHtml = marked.parse(content) as string;
      return DOMPurify.sanitize(rawHtml);
    }
    return '';
  }, [content, isPreviewMode]);

  const handleCopyNotepad = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('无法复制记事本内容: ', err);
    }
  };

  const notepadBaseClasses = "h-full flex flex-col bg-gray-50 border-l border-gray-300";
  const fullscreenClasses = "fixed top-0 left-0 w-screen h-screen z-50 shadow-2xl";

  return (
    <div className={`${notepadBaseClasses} ${isNotepadFullscreen ? fullscreenClasses : ''}`}>
      <header className="p-3 border-b border-gray-300 flex items-center justify-between bg-gray-100 shrink-0">
        <div className="flex items-center">
          <FileText size={20} className="mr-2 text-sky-600" />
          <h2 className="text-lg font-semibold text-sky-700">Notebook</h2>
        </div>
        <div className="flex items-center space-x-2">
          {isLoading && !isNotepadFullscreen && <span className="text-xs text-gray-500 italic">AI 思考中...</span>}
          <button
            onClick={onToggleFullscreen}
            className="p-1.5 text-gray-500 hover:text-sky-600 transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-sky-500 rounded-md"
            title={isNotepadFullscreen ? "退出全屏" : "全屏"}
            aria-label={isNotepadFullscreen ? "Exit fullscreen notepad" : "Enter fullscreen notepad"}
          >
            {isNotepadFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
          </button>
          <button
            onClick={handleCopyNotepad}
            className="p-1.5 text-gray-500 hover:text-sky-600 transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-sky-500 rounded-md"
            title={isCopied ? "已复制!" : "复制记事本内容"}
            aria-label={isCopied ? "已复制记事本内容到剪贴板" : "复制记事本内容"}
          >
            {isCopied ? <Check size={18} className="text-green-500" /> : <Copy size={18} />}
          </button>
          <button
            onClick={() => setIsPreviewMode(!isPreviewMode)}
            className="p-1.5 text-gray-500 hover:text-sky-600 transition-colors duration-150 focus:outline-none focus:ring-1 focus:ring-sky-500 rounded-md"
            title={isPreviewMode ? "查看原始内容" : "预览 Markdown"}
            aria-label={isPreviewMode ? "Switch to raw text view" : "Switch to Markdown preview"}
          >
            {isPreviewMode ? <Code size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </header>
      <div className="flex-grow overflow-y-auto relative bg-white">
        {isPreviewMode ? (
          <div
            className="markdown-preview"
            dangerouslySetInnerHTML={{ __html: processedHtml }}
            aria-label="Markdown 预览"
          />
        ) : (
          <textarea
            readOnly
            value={content}
            className="w-full h-full p-3 bg-white text-gray-800 resize-none border-none focus:ring-0 font-mono text-sm leading-relaxed"
            aria-label="共享记事本内容 (原始内容)"
          />
        )}
      </div>
      {/* Footer has been removed as per user request */}
    </div>
  );
};

export default Notepad;