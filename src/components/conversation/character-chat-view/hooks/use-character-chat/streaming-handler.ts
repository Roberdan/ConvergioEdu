/**
 * Streaming message handler
 * Sends messages with real-time streaming response
 *
 * @see ADR 0034 for streaming architecture
 */

import type { Message } from './types';
import type { CharacterInfo } from '../../utils/character-utils';
import { logger } from '@/lib/logger';

/**
 * Streaming message options
 */
export interface StreamingMessageOptions {
  input: string;
  messages: Message[];
  character: CharacterInfo;
  characterId: string;
  onChunk: (chunk: string, accumulated: string) => void;
  onComplete: (fullResponse: string) => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}

/**
 * Tool-triggering keywords in Italian
 * If message contains these, skip streaming and use /api/chat for tool support
 */
const TOOL_KEYWORDS = [
  // Mindmap
  'mappa', 'mappe', 'schema', 'schemi', 'diagramma',
  // Quiz
  'quiz', 'domande', 'verifica', 'test', 'interroga',
  // Flashcard
  'flashcard', 'flash card', 'carte', 'schede',
  // Summary
  'riassunto', 'riassumi', 'sintesi', 'sintetizza',
  // Demo
  'demo', 'dimostra', 'esempio', 'simulazione',
  // General tool requests
  'crea', 'genera', 'prepara', 'fammi', 'fai',
];

/**
 * Check if message likely requires a tool
 * Returns true if we should skip streaming and use non-streaming endpoint
 */
export function messageRequiresTool(input: string): boolean {
  const lowerInput = input.toLowerCase();
  return TOOL_KEYWORDS.some(keyword => lowerInput.includes(keyword));
}

/**
 * Check if streaming is available
 * Checks server support via feature flag endpoint
 */
export async function isStreamingAvailable(): Promise<boolean> {
  try {
    const response = await fetch('/api/chat/stream', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) return false;

    const data = await response.json();
    return data.streaming === true;
  } catch {
    return false;
  }
}

/**
 * Send message with streaming response
 * Returns true if streaming was used, false if fallback was needed
 */
export async function sendStreamingMessage(
  options: StreamingMessageOptions
): Promise<boolean> {
  const {
    input,
    messages,
    character,
    characterId,
    onChunk,
    onComplete,
    onError,
    signal,
  } = options;

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: input },
        ],
        systemPrompt: character.systemPrompt,
        maestroId: characterId,
        enableMemory: true,
      }),
      signal,
    });

    // If streaming is disabled, response will be JSON error
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.fallback) {
        logger.debug('[Streaming] Not available, needs fallback');
        return false; // Signal to use fallback
      }
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    // Verify SSE content type
    const contentType = response.headers.get('Content-Type');
    if (!contentType?.includes('text/event-stream')) {
      logger.debug('[Streaming] Not SSE response, needs fallback');
      return false;
    }

    // Process SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith('data: ')) continue;

        const data = trimmedLine.slice(6);

        if (data === '[DONE]') {
          onComplete(accumulated);
          return true;
        }

        try {
          const parsed = JSON.parse(data);

          if (parsed.content) {
            accumulated += parsed.content;
            onChunk(parsed.content, accumulated);
          }

          if (parsed.error) {
            throw new Error(parsed.error);
          }

          // Log content filter but continue
          if (parsed.filtered) {
            logger.warn('[Streaming] Content filtered by Azure');
          }
        } catch (parseError) {
          // Ignore parse errors for individual chunks
          if ((parseError as Error).message.includes('filtered')) {
            throw parseError;
          }
        }
      }
    }

    // Stream ended normally
    onComplete(accumulated);
    return true;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.debug('[Streaming] Aborted by user');
      return true; // Abort is handled, don't fallback
    }

    logger.error('[Streaming] Error', { error: String(error) });
    onError(error as Error);
    return true; // Error is handled, don't fallback
  }
}
