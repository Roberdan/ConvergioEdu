# ADR 0034: Chat Streaming Architecture

## Status
Accepted

## Date
2026-01-11

## Context

MirrorBuddy's chat with Maestri (AI tutors) previously used a non-streaming approach:
1. User sends message
2. Full request sent to Azure OpenAI
3. Wait 3-8 seconds for complete response
4. Display entire response at once

This created UX problems:

| Issue | Impact |
|-------|--------|
| Long wait times | Students unsure if app is working |
| No progress feedback | Anxiety, especially for ADHD students |
| Perceived slowness | Even fast responses feel slow |
| All-or-nothing | No benefit during generation |

### Verification

Azure OpenAI deployment verified to support streaming:
- Model: `gpt-4o-mini`
- Capability: `chatCompletion: true`
- API version: `2024-08-01-preview`
- Endpoint supports `stream: true` parameter

### Options Considered

#### Option 1: Vercel AI SDK
Use Vercel's AI SDK for streaming abstraction.

**Pros:**
- Mature library with React hooks
- Handles SSE parsing automatically
- Good TypeScript support

**Cons:**
- Additional dependency
- Abstracts away control
- May conflict with existing patterns
- Not needed for our simple use case

#### Option 2: Native SSE (Chosen)
Implement streaming using native fetch and ReadableStream.

**Pros:**
- No new dependencies
- Full control over implementation
- Consistent with existing tool streaming (ADR 0005)
- Simpler debugging

**Cons:**
- More code to maintain
- Need to handle edge cases manually

## Decision

Implement **native SSE streaming** for chat responses, consistent with existing tool streaming.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    STUDENT BROWSER                           │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │   Character Chat Component                           │  │
│  │   - useCharacterChat hook                           │  │
│  │   - Streaming message placeholder                   │  │
│  │   - Real-time content updates                       │  │
│  └──────────────────────────────────────────────────────┘  │
│           │                                                 │
└───────────│─────────────────────────────────────────────────┘
            │ POST + ReadableStream
            ▼
┌─────────────────────────────────────────────────────────────┐
│                    NEXT.JS SERVER                            │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │   POST /api/chat/stream                              │  │
│  │   - Feature flag: ENABLE_CHAT_STREAMING              │  │
│  │   - Returns SSE stream                               │  │
│  │   - Rate limiting, budget check                      │  │
│  └──────────────────────────────────────────────────────┘  │
│           │                                                 │
│           ▼                                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │   azureStreamingCompletion()                         │  │
│  │   - AsyncGenerator pattern                          │  │
│  │   - Yields StreamChunk objects                      │  │
│  │   - Content filter handling                         │  │
│  │   - Usage extraction                                │  │
│  └──────────────────────────────────────────────────────┘  │
│           │                                                 │
└───────────│─────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│                    AZURE OPENAI                              │
│   stream: true, stream_options: { include_usage: true }     │
└─────────────────────────────────────────────────────────────┘
```

### API Design

#### Streaming Endpoint

```
POST /api/chat/stream
Content-Type: application/json

{
  "messages": [...],
  "systemPrompt": "...",
  "maestroId": "physics",
  "enableMemory": true
}

Response: text/event-stream
data: {"content": "Ciao"}
data: {"content": " studente!"}
data: {"content": " Come posso"}
data: {"usage": {"total_tokens": 150, ...}}
data: [DONE]
```

#### Feature Flag

```typescript
// Server-side: env var
ENABLE_CHAT_STREAMING=true  // default: true

// Client-side: runtime check
GET /api/chat/stream → { streaming: true }
```

### Chunk Types

| Type | Payload | Purpose |
|------|---------|---------|
| `content` | `{ content: string }` | Text delta |
| `usage` | `{ usage: TokenUsage }` | Token counts |
| `error` | `{ error: string }` | Error occurred |
| `filtered` | `{ filtered: true }` | Content blocked |
| `[DONE]` | (none) | Stream complete |

### Client Implementation

```typescript
// useCharacterChat hook integration
if (streamingEnabled) {
  const streamed = await sendStreamingMessage({
    input: userMessage.content,
    messages,
    character,
    characterId,
    onChunk: (chunk, accumulated) => {
      // Update message in place
      setMessages(prev =>
        prev.map(m => m.id === streamingMsgId
          ? { ...m, content: accumulated }
          : m
        )
      );
    },
    onComplete: (fullResponse) => {
      // Finalize and persist
      addMessageToStore(conversationId, { role: 'assistant', content: fullResponse });
    },
  });
}
```

### Safety Integration

Streaming integrates with existing safety systems:

1. **Input filter**: Applied before streaming starts
2. **StreamingSanitizer**: Processes chunks in real-time
3. **Content filter**: Azure-side filtering, yields `filtered` chunk
4. **Memory injection**: Enhanced system prompt includes context

### Tool Calls

**Important**: Streaming endpoint does NOT support tool calls.

- Tool-enabled requests → `/api/chat` (non-streaming)
- Simple chat requests → `/api/chat/stream` (streaming)

This is by design: tool calls require full response for JSON parsing.

**Automatic Detection**: The client detects tool-intent keywords (mappa, quiz, flashcard, riassunto, etc.) and automatically routes to non-streaming:

```typescript
const TOOL_KEYWORDS = ['mappa', 'quiz', 'flashcard', 'riassunto', 'crea', 'genera', ...];

if (streamingEnabled && !messageRequiresTool(input)) {
  // Use streaming
} else {
  // Use non-streaming with tool support
}
```

### Voice Integration

**Voice Realtime**: Completely unaffected - uses separate WebSocket system.

**TTS Integration**: TTS should trigger on stream completion, not during streaming:

```typescript
onComplete: (fullResponse) => {
  if (ttsEnabled) {
    triggerTTS(fullResponse);  // After stream ends
  }
};
```

## Consequences

### Positive
- Immediate visual feedback (first token in ~100ms)
- Reduced perceived latency
- Better UX for anxious/ADHD students
- Consistent with tool streaming pattern
- Graceful fallback if streaming unavailable

### Negative
- Two endpoints to maintain (`/api/chat`, `/api/chat/stream`)
- Slightly more complex client code
- No tool call support in streaming mode

### Performance

| Metric | Before (Non-streaming) | After (Streaming) |
|--------|------------------------|-------------------|
| First visible content | 3-8s | ~100-200ms |
| Perceived responsiveness | Low | High |
| Memory usage | Full response buffered | Incremental |
| Network requests | 1 | 1 (same) |

### Rollback

If issues arise:
1. Set `ENABLE_CHAT_STREAMING=false` in env
2. Client auto-detects and uses `/api/chat` fallback
3. No code changes required

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/ai/providers/azure-streaming.ts` | Azure SSE client |
| `src/app/api/chat/stream/route.ts` | Streaming endpoint |
| `src/lib/hooks/use-streaming-chat.ts` | React hook |
| `src/components/.../streaming-handler.ts` | UI integration |

## References
- ADR 0005: Real-time SSE Architecture (tool streaming)
- Azure OpenAI Streaming Documentation
- MDN: ReadableStream API
