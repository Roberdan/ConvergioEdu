/**
 * Streaming Chat Hook
 * Handles real-time streaming of chat responses via SSE
 *
 * @see ADR 0034 for streaming architecture
 */

'use client';

import { useState, useCallback, useRef } from 'react';
import { logger } from '@/lib/logger';

/**
 * Message format for chat
 */
export interface StreamChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Streaming state
 */
export type StreamingState = 'idle' | 'streaming' | 'complete' | 'error';

/**
 * Usage information from API
 */
export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Hook options
 */
export interface UseStreamingChatOptions {
  onChunk?: (chunk: string, accumulated: string) => void;
  onComplete?: (fullResponse: string, usage?: StreamUsage) => void;
  onError?: (error: Error) => void;
  onContentFiltered?: () => void;
}

/**
 * Hook return type
 */
export interface UseStreamingChatResult {
  /** Current streaming state */
  streamingState: StreamingState;
  /** Accumulated response text */
  streamedContent: string;
  /** Usage stats from last request */
  usage: StreamUsage | null;
  /** Content was blocked by filter */
  wasFiltered: boolean;
  /** Error message if any */
  error: string | null;
  /** Send a streaming message */
  sendStreamingMessage: (params: StreamingMessageParams) => Promise<void>;
  /** Cancel ongoing stream */
  cancelStream: () => void;
  /** Reset state for new conversation */
  reset: () => void;
}

export interface StreamingMessageParams {
  messages: StreamChatMessage[];
  systemPrompt: string;
  maestroId: string;
  enableMemory?: boolean;
}

/**
 * Hook for streaming chat responses
 *
 * @example
 * ```tsx
 * const { streamedContent, sendStreamingMessage, streamingState } = useStreamingChat({
 *   onChunk: (chunk, acc) => console.log('New chunk:', chunk),
 *   onComplete: (full) => console.log('Complete:', full),
 * });
 *
 * await sendStreamingMessage({
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   systemPrompt: 'You are a helpful tutor.',
 *   maestroId: 'physics',
 * });
 * ```
 */
export function useStreamingChat(options: UseStreamingChatOptions = {}): UseStreamingChatResult {
  const { onChunk, onComplete, onError, onContentFiltered } = options;

  // State
  const [streamingState, setStreamingState] = useState<StreamingState>('idle');
  const [streamedContent, setStreamedContent] = useState('');
  const [usage, setUsage] = useState<StreamUsage | null>(null);
  const [wasFiltered, setWasFiltered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Abort controller ref
  const abortControllerRef = useRef<AbortController | null>(null);

  // Store callbacks in refs to avoid stale closures
  const callbacksRef = useRef({ onChunk, onComplete, onError, onContentFiltered });
  callbacksRef.current = { onChunk, onComplete, onError, onContentFiltered };

  /**
   * Cancel ongoing stream
   */
  const cancelStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setStreamingState('idle');
      logger.debug('[StreamingChat] Stream cancelled');
    }
  }, []);

  /**
   * Reset state for new conversation
   */
  const reset = useCallback(() => {
    cancelStream();
    setStreamedContent('');
    setUsage(null);
    setWasFiltered(false);
    setError(null);
    setStreamingState('idle');
  }, [cancelStream]);

  /**
   * Send a streaming message
   */
  const sendStreamingMessage = useCallback(async (params: StreamingMessageParams) => {
    const { messages, systemPrompt, maestroId, enableMemory = true } = params;

    // Cancel any existing stream
    cancelStream();

    // Reset state
    setStreamedContent('');
    setUsage(null);
    setWasFiltered(false);
    setError(null);
    setStreamingState('streaming');

    // Create abort controller
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          systemPrompt,
          maestroId,
          enableMemory,
        }),
        signal: abortController.signal,
      });

      // Handle non-streaming error responses
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));

        // If streaming is disabled, fallback info is in response
        if (errorData.fallback) {
          logger.warn('[StreamingChat] Streaming not available, use fallback', {
            fallback: errorData.fallback,
          });
        }

        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      // Check content type
      const contentType = response.headers.get('Content-Type');
      if (!contentType?.includes('text/event-stream')) {
        throw new Error('Expected SSE response');
      }

      // Read SSE stream
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      let localUsage: StreamUsage | undefined;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          // Skip empty lines
          if (!trimmedLine) continue;

          // Parse SSE data
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6);

            // Check for done signal
            if (data === '[DONE]') {
              setStreamingState('complete');
              callbacksRef.current.onComplete?.(accumulated, localUsage);
              return;
            }

            try {
              const parsed = JSON.parse(data);

              // Handle content chunk
              if (parsed.content) {
                accumulated += parsed.content;
                setStreamedContent(accumulated);
                callbacksRef.current.onChunk?.(parsed.content, accumulated);
              }

              // Handle blocked/filtered content
              if (parsed.blocked || parsed.filtered) {
                setWasFiltered(true);
                callbacksRef.current.onContentFiltered?.();
              }

              // Handle usage
              if (parsed.usage) {
                localUsage = parsed.usage;
                setUsage(parsed.usage);
              }

              // Handle inline error
              if (parsed.error) {
                throw new Error(parsed.error);
              }
            } catch (_parseError) {
              // Only log, don't throw on parse errors
              logger.warn('[StreamingChat] Failed to parse SSE data', {
                data: data.substring(0, 100),
              });
            }
          }
        }
      }

      // Stream ended without [DONE] signal
      setStreamingState('complete');
      callbacksRef.current.onComplete?.(accumulated, localUsage);
    } catch (err) {
      // Handle abort
      if ((err as Error).name === 'AbortError') {
        logger.debug('[StreamingChat] Aborted');
        setStreamingState('idle');
        return;
      }

      // Handle error
      const errorMessage = (err as Error).message || 'Streaming failed';
      logger.error('[StreamingChat] Error', { error: errorMessage });
      setError(errorMessage);
      setStreamingState('error');
      callbacksRef.current.onError?.(err as Error);
    } finally {
      abortControllerRef.current = null;
    }
  }, [cancelStream]);

  return {
    streamingState,
    streamedContent,
    usage,
    wasFiltered,
    error,
    sendStreamingMessage,
    cancelStream,
    reset,
  };
}
