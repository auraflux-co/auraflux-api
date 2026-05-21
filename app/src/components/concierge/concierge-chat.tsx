'use client';

/**
 * ConciergeChat — AI Concierge chat widget (CPD-47)
 *
 * Sends messages to POST /concierge/chat via the AuraFlux API client.
 * Displays a conversation thread. Accepts an optional currentSpec prop
 * that is sent with every message for context-aware guidance.
 */

import { useState, useRef, useEffect, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { chatWithConcierge, type ChatMessage } from '@/lib/api';

interface ConciergeChatProps {
  currentSpec?: Record<string, unknown>;
  planTier?: string;
  className?: string;
}

const WELCOME_MESSAGE: ChatMessage = {
  role: 'assistant',
  content:
    'Hi! I\'m your AuraFlux assistant. I can help you configure your video job, explain what each option does, and guide you toward a ready-to-submit setup.\n\nWhat would you like help with today?',
};

export function ConciergeChat({ currentSpec, planTier, className }: ConciergeChatProps) {
  const { getToken } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isPending) return;

    const userMessage: ChatMessage = { role: 'user', content: text };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput('');
    setError(null);

    startTransition(async () => {
      try {
        const token = await getToken();
        const result = await chatWithConcierge(
          nextMessages,
          currentSpec,
          planTier,
          token ?? undefined,
        );
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: result.response },
        ]);
      } catch (err: unknown) {
        setError('Something went wrong. Please try again.');
        // Remove the user message from display so they can retry
        setMessages(nextMessages.slice(0, -1));
        setInput(text);
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <Card className={cn('flex flex-col h-full', className)}>
      <CardHeader className="pb-2 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">Help</CardTitle>
          <Badge variant="secondary" className="text-xs">AuraFlux</Badge>
        </div>
      </CardHeader>

      {/* Message thread */}
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {isPending && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <span className="animate-pulse">Thinking…</span>
          </div>
        )}
        {error && (
          <p className="text-destructive text-xs bg-destructive/10 rounded px-3 py-2">
            {error}
          </p>
        )}
        <div ref={bottomRef} />
      </CardContent>

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-border p-3 flex gap-2 items-end">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask what to select for your video job, or get guided help…"
          className="min-h-[60px] max-h-[150px] resize-none text-sm flex-1"
          disabled={isPending}
        />
        <Button
          onClick={handleSend}
          disabled={!input.trim() || isPending}
          size="sm"
          className="self-end"
        >
          Send
        </Button>
      </div>
    </Card>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground',
        )}
      >
        {message.content}
      </div>
    </div>
  );
}
