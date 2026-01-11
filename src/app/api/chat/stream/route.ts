/**
 * Streaming Chat API Route Handler
 * Server-Sent Events (SSE) streaming for chat completions
 *
 * IMPORTANT: This endpoint does NOT support tool calls.
 * For tool-enabled chat, use the standard /api/chat endpoint.
 *
 * @see ADR 0034 for streaming architecture
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { azureStreamingCompletion, getActiveProvider, type AIProvider } from '@/lib/ai/providers';
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { checkRateLimit, getClientIdentifier, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit';
import { filterInput, StreamingSanitizer } from '@/lib/safety';
import { loadPreviousContext } from '@/lib/conversation/memory-loader';
import { enhanceSystemPrompt } from '@/lib/conversation/prompt-enhancer';
import { findSimilarMaterials } from '@/lib/rag/retrieval-service';

import type { ChatRequest } from '../types';

/**
 * Feature flag for streaming - can be disabled via env var
 */
const STREAMING_ENABLED = process.env.ENABLE_CHAT_STREAMING !== 'false';

export async function POST(request: NextRequest) {
  // Check feature flag
  if (!STREAMING_ENABLED) {
    return NextResponse.json(
      { error: 'Streaming is disabled', fallback: '/api/chat' },
      { status: 503 }
    );
  }

  // Rate limiting
  const clientId = getClientIdentifier(request);
  const rateLimit = checkRateLimit(`chat:${clientId}`, RATE_LIMITS.CHAT);

  if (!rateLimit.success) {
    logger.warn('Rate limit exceeded', { clientId, endpoint: '/api/chat/stream' });
    return rateLimitResponse(rateLimit);
  }

  try {
    const body: ChatRequest = await request.json();
    const { messages, systemPrompt, maestroId, enableMemory = true } = body;

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: 'Messages array is required' },
        { status: 400 }
      );
    }

    // Get userId from cookie
    const cookieStore = await cookies();
    const userId = cookieStore.get('mirrorbuddy-user-id')?.value;

    // Get provider preference and check budget
    let providerPreference: AIProvider | 'auto' | undefined;
    let userSettings: { provider: string; budgetLimit: number; totalSpent: number } | null = null;

    if (userId) {
      try {
        userSettings = await prisma.settings.findUnique({
          where: { userId },
          select: { provider: true, budgetLimit: true, totalSpent: true },
        });

        if (userSettings?.provider && (userSettings.provider === 'azure' || userSettings.provider === 'ollama')) {
          providerPreference = userSettings.provider;
        }

        // Budget check
        if (userSettings && userSettings.totalSpent >= userSettings.budgetLimit) {
          return NextResponse.json(
            {
              error: 'Budget limit exceeded',
              message: `Hai raggiunto il limite di budget di $${userSettings.budgetLimit.toFixed(2)}.`,
              fallback: '/api/chat',
            },
            { status: 402 }
          );
        }
      } catch (e) {
        logger.debug('Failed to load settings', { error: String(e) });
      }
    }

    // Get provider config - streaming only works with Azure
    const config = getActiveProvider(providerPreference);
    if (!config) {
      return NextResponse.json(
        { error: 'No AI provider configured', fallback: '/api/chat' },
        { status: 503 }
      );
    }

    if (config.provider !== 'azure') {
      // Ollama doesn't support streaming in our implementation, redirect to standard endpoint
      return NextResponse.json(
        { error: 'Streaming only available with Azure OpenAI', fallback: '/api/chat' },
        { status: 400 }
      );
    }

    // Build enhanced system prompt
    let enhancedSystemPrompt = systemPrompt;

    // Inject conversation memory if enabled
    if (enableMemory && userId && maestroId) {
      try {
        const memory = await loadPreviousContext(userId, maestroId);
        if (memory.recentSummary || memory.keyFacts.length > 0) {
          enhancedSystemPrompt = enhanceSystemPrompt({
            basePrompt: enhancedSystemPrompt,
            memory,
            safetyOptions: { role: 'maestro' },
          });
        }
      } catch (memoryError) {
        logger.warn('Failed to load memory', { error: String(memoryError) });
      }
    }

    // RAG context injection
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    if (userId && lastUserMessage) {
      try {
        const relevantMaterials = await findSimilarMaterials({
          userId,
          query: lastUserMessage.content,
          limit: 3,
          minSimilarity: 0.6,
        });

        if (relevantMaterials.length > 0) {
          const ragContext = relevantMaterials.map(m => `- ${m.content}`).join('\n');
          enhancedSystemPrompt = `${enhancedSystemPrompt}\n\n[Materiali rilevanti]\n${ragContext}`;
        }
      } catch (ragError) {
        logger.warn('Failed to load RAG context', { error: String(ragError) });
      }
    }

    // Safety filter on input
    if (lastUserMessage) {
      const filterResult = filterInput(lastUserMessage.content);
      if (!filterResult.safe && filterResult.action === 'block') {
        logger.warn('Content blocked by safety filter', { clientId });
        // Return blocked response as SSE
        return createSSEResponse(async function* () {
          yield `data: ${JSON.stringify({ content: filterResult.suggestedResponse, blocked: true })}\n\n`;
          yield 'data: [DONE]\n\n';
        });
      }
    }

    // Create streaming response
    const sanitizer = new StreamingSanitizer();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let totalTokens = 0;

        try {
          const generator = azureStreamingCompletion(
            config,
            messages.map(m => ({ role: m.role, content: m.content })),
            enhancedSystemPrompt,
            { signal: request.signal }
          );

          for await (const chunk of generator) {
            if (chunk.type === 'content' && chunk.content) {
              // Sanitize the chunk
              const sanitized = sanitizer.processChunk(chunk.content);
              if (sanitized) {
                const sseData = `data: ${JSON.stringify({ content: sanitized })}\n\n`;
                controller.enqueue(encoder.encode(sseData));
              }
            } else if (chunk.type === 'content_filter') {
              // Content was filtered
              const fallbackMsg = 'Mi dispiace, non posso rispondere a questa domanda.';
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: fallbackMsg, filtered: true })}\n\n`));
            } else if (chunk.type === 'usage' && chunk.usage) {
              totalTokens = chunk.usage.total_tokens;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage: chunk.usage })}\n\n`));
            } else if (chunk.type === 'error') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: chunk.error })}\n\n`));
            }
          }

          // Flush any remaining sanitizer buffer
          const remaining = sanitizer.flush();
          if (remaining) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: remaining })}\n\n`));
          }

          // Send done signal
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

          // Update budget if we have usage data
          if (userId && userSettings && totalTokens > 0) {
            try {
              const estimatedCost = totalTokens * 0.000002;
              await prisma.settings.update({
                where: { userId },
                data: { totalSpent: { increment: estimatedCost } },
              });
            } catch (e) {
              logger.warn('Failed to update budget', { error: String(e) });
            }
          }
        } catch (error) {
          if ((error as Error).name !== 'AbortError') {
            logger.error('Streaming error', { error: String(error) });
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Streaming failed' })}\n\n`));
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    logger.error('Chat stream API error', { error: String(error) });
    return NextResponse.json(
      { error: 'Internal server error', fallback: '/api/chat' },
      { status: 500 }
    );
  }
}

/**
 * Helper to create SSE response from async generator
 */
function createSSEResponse(generator: () => AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of generator()) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * GET endpoint for connection test
 * Returns streaming availability based on feature flag AND provider support
 */
export async function GET() {
  // Check if streaming is enabled AND provider supports it
  const config = getActiveProvider();
  const providerSupportsStreaming = config?.provider === 'azure';
  const streamingAvailable = STREAMING_ENABLED && providerSupportsStreaming;

  return NextResponse.json({
    streaming: streamingAvailable,
    provider: config?.provider ?? null,
    endpoint: '/api/chat/stream',
    method: 'POST',
    note: 'Tool calls not supported - use /api/chat for tools',
  });
}
