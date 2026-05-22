import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getViewportEnabledElement } from '../utils/getViewportEnabledElement';


const SYSTEM_PROMPT = `You are a radiology AI assistant embedded in a DICOM viewer, supporting radiologists and clinicians.

When analyzing images, respond using this structure:

## Findings
Systematic description of technique, anatomy, and observed abnormalities if any are present.  — include location, size, attenuation/signal, morphology, and any incidental findings.

## Assessment
Differential diagnosis ranked by likelihood with concise reasoning for each.

## Recommendation
Next steps if clinically relevant (additional sequences, correlation, follow-up interval). Omit if not applicable.

---

Use standard radiological terminology. Be precise and concise. For general questions, answer directly without the structured format.`;

type MessageRole = 'user' | 'assistant';

interface Message {
  role: MessageRole;
  text: string;
  images?: string[];
}

interface GeminiHistoryPart {
  role: 'user' | 'model';
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureAllViewportCanvases(viewportGridService: any): string[] {
  try {
    const { viewports } = viewportGridService.getState();
    const results: string[] = [];
    for (const [viewportId] of viewports) {
      try {
        const enabledElement = getViewportEnabledElement(viewportId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const canvas: HTMLCanvasElement | undefined = (enabledElement?.viewport as any)?.canvas;
        if (canvas) {
          results.push(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
        }
      } catch {
        // skip viewports that can't be captured
      }
    }
    return results;
  } catch {
    return [];
  }
}

function buildGeminiHistory(messages: Message[]): GeminiHistoryPart[] {
  return messages.map(msg => {
    const parts: GeminiHistoryPart['parts'] = [];
    for (const img of msg.images ?? []) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
    }
    parts.push({ text: msg.text });
    return {
      role: msg.role === 'user' ? 'user' : 'model',
      parts,
    };
  });
}

interface PanelAIAssistantProps {
  servicesManager: AppTypes.ServicesManager;
}

export default function PanelAIAssistant({ servicesManager }: PanelAIAssistantProps) {
  const { viewportGridService } = servicesManager.services;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [attachImage, setAttachImage] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const genAIRef = useRef<GoogleGenerativeAI | null>(null);

  useEffect(() => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      genAIRef.current = new GoogleGenerativeAI(apiKey);
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleToggleAttach = useCallback(() => {
    if (!attachImage) {
      const images = captureAllViewportCanvases(viewportGridService);
      setPendingImages(images);
      setAttachImage(true);
      if (images.length === 0) {
        setError('No viewport images found. Load a DICOM series first.');
      } else {
        setError(null);
      }
    } else {
      setAttachImage(false);
      setPendingImages([]);
      setError(null);
    }
  }, [attachImage, viewportGridService]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) {
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      setError('GEMINI_API_KEY is not set. Add it to platform/app/.env and restart the dev server.');
      return;
    }

    if (!genAIRef.current) {
      genAIRef.current = new GoogleGenerativeAI(apiKey);
    }

    const images = attachImage ? pendingImages : [];

    const userMessage: Message = { role: 'user', text, images: images.length ? images : undefined };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput('');
    setAttachImage(false);
    setPendingImages([]);
    setError(null);
    setIsStreaming(true);

    const assistantPlaceholder: Message = { role: 'assistant', text: '' };
    setMessages(prev => [...prev, assistantPlaceholder]);

    try {
      const model = genAIRef.current.getGenerativeModel({
        model: process.env.MODEL,
        systemInstruction: SYSTEM_PROMPT,
      });

      const history = buildGeminiHistory(updatedMessages.slice(0, -1));

      const chat = model.startChat({ history });

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> =
        [];
      for (const img of images) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
      }
      parts.push({ text });

      const result = await chat.sendMessageStream(parts);

      let accumulated = '';
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        accumulated += chunkText;
        setMessages(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', text: accumulated };
          return next;
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setMessages(prev => {
        const next = [...prev];
        next[next.length - 1] = { role: 'assistant', text: `Error: ${message}` };
        return next;
      });
      setError(message);
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming, messages, attachImage, pendingImages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Message thread */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground p-6 gap-3">
            <div className="text-4xl">🩻</div>
            <p className="text-sm font-medium">AI Medical Imaging Assistant</p>
            <p className="text-xs leading-relaxed">
              Ask questions about the current images or general radiology topics. Toggle{' '}
              <span className="text-primary font-semibold">Attach all viewports</span> to share all
              open viewports with the AI.
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            message={msg}
          />
        ))}
        {isStreaming && messages[messages.length - 1]?.text === '' && (
          <div className="flex gap-1 px-1">
            <span className="animate-bounce text-primary">●</span>
            <span
              className="animate-bounce text-primary"
              style={{ animationDelay: '0.15s' }}
            >
              ●
            </span>
            <span
              className="animate-bounce text-primary"
              style={{ animationDelay: '0.3s' }}
            >
              ●
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-3 mb-2 rounded bg-destructive/20 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Pending image thumbnails */}
      {attachImage && pendingImages.length > 0 && (
        <div className="mx-3 mb-2 rounded border border-border bg-muted p-2">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {pendingImages.map((img, i) => (
              <img
                key={i}
                src={`data:image/jpeg;base64,${img}`}
                alt={`Viewport ${i + 1}`}
                className="h-14 w-14 flex-shrink-0 rounded object-cover"
              />
            ))}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {pendingImages.length} viewport{pendingImages.length > 1 ? 's' : ''} attached
            </p>
            <button
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={handleToggleAttach}
              title="Remove images"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* No image warning when toggle is on but capture failed */}
      {attachImage && pendingImages.length === 0 && (
        <div className="mx-3 mb-2 rounded border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          No viewport images available — load a DICOM series to attach images.
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-border p-3 space-y-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleToggleAttach}
            disabled={isStreaming}
            className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
              attachImage
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            } disabled:opacity-50`}
          >
            <span>🖼</span>
            <span>
              {attachImage
                ? `${pendingImages.length} image${pendingImages.length !== 1 ? 's' : ''} attached`
                : 'Attach all viewports'}
            </span>
          </button>
        </div>
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about the image… (Enter to send, Shift+Enter for newline)"
            disabled={isStreaming}
            rows={3}
            className="flex-1 resize-none rounded border border-border bg-input px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={isStreaming || !input.trim()}
            className="self-end rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {isStreaming ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={i} className="italic text-muted-foreground">{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function MarkdownRenderer({ text }: { text: string }) {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length === 0) return;
    nodes.push(
      <ul key={nodes.length} className="list-disc pl-4 mb-2 space-y-0.5">
        {listBuffer.map((item, i) => (
          <li key={i} className="text-sm">{renderInline(item)}</li>
        ))}
      </ul>
    );
    listBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^##\s+/.test(line)) {
      flushList();
      nodes.push(
        <h2 key={nodes.length} className="font-semibold text-foreground mt-3 mb-1 first:mt-0 text-xs uppercase tracking-wide border-b border-border pb-0.5">
          {line.replace(/^##\s+/, '')}
        </h2>
      );
    } else if (/^---+$/.test(line.trim())) {
      flushList();
      nodes.push(<hr key={nodes.length} className="border-border my-2" />);
    } else if (/^[-*]\s+/.test(line)) {
      listBuffer.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      nodes.push(
        <p key={nodes.length} className="mb-1 last:mb-0">{renderInline(line)}</p>
      );
    }
  }
  flushList();

  return <div>{nodes}</div>;
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      {(message.images?.length ?? 0) > 0 && (
        <div className="flex gap-1 flex-wrap">
          {message.images!.map((img, i) => (
            <img
              key={i}
              src={`data:image/jpeg;base64,${img}`}
              alt={`Attached image ${i + 1}`}
              className="h-24 w-24 rounded border border-border object-cover"
            />
          ))}
        </div>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground'
        }`}
      >
        {message.text ? (
          isUser ? (
            message.text
          ) : (
            <MarkdownRenderer text={message.text} />
          )
        ) : (
          <span className="italic text-muted-foreground opacity-70">Thinking…</span>
        )}
      </div>
    </div>
  );
}
