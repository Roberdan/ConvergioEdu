/**
 * Use-character-chat hook - main implementation
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { logger } from '@/lib/logger';
import { useConversationStore } from '@/lib/stores';
import { useVoiceSession, type ConnectionInfo } from '@/lib/hooks/use-voice-session';
import type { ToolType, ToolState } from '@/types/tools';
import type { CharacterInfo } from '../../utils/character-utils';
import { characterToMaestro } from '../../utils/character-utils';
import type { Message } from './types';
import {
  loadMessagesFromServer,
  convertStoreMessages,
  createGreetingMessage,
} from './conversation-loader';
import {
  sendChatMessage,
  createUserMessage,
  createAssistantMessage,
  createErrorMessage,
} from './message-handler';
import {
  isStreamingAvailable,
  sendStreamingMessage,
  messageRequiresTool,
} from './streaming-handler';
import {
  requestTool,
  createInitialToolState,
  createErrorToolState,
} from './tool-handler';
import {
  fetchVoiceConnectionInfo,
  handleMicrophoneError,
} from './voice-handler';

export function useCharacterChat(
  characterId: string,
  character: CharacterInfo
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolState | null>(null);

  // Streaming state
  const [streamingEnabled, setStreamingEnabled] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedContent, setStreamedContent] = useState('');
  const streamAbortRef = useRef<AbortController | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasAttemptedConnection = useRef(false);
  const conversationIdRef = useRef<string | null>(null);
  const hasLoadedMessages = useRef(false);
  const lastCharacterIdRef = useRef<string | null>(null);

  const { conversations, createConversation, addMessage: addMessageToStore } =
    useConversationStore();

  const voiceSession = useVoiceSession({
    onTranscript: (role, text) => {
      if (role === 'user') {
        setMessages((prev) => [
          ...prev,
          {
            id: `voice-${Date.now()}`,
            role: 'user',
            content: text,
            timestamp: new Date(),
            isVoice: true,
          },
        ]);
      }
    },
  });

  const { isConnected, connectionState, connect, disconnect } = voiceSession;

  // Reset messages when character changes
  useEffect(() => {
    if (lastCharacterIdRef.current !== null && lastCharacterIdRef.current !== characterId) {
      hasLoadedMessages.current = false;
      setMessages([]);
      conversationIdRef.current = null;
    }
    lastCharacterIdRef.current = characterId;
  }, [characterId]);

  // Fetch voice connection info
  useEffect(() => {
    fetchVoiceConnectionInfo().then(({ connectionInfo: info, error }) => {
      if (error) {
        setConfigError(error);
      } else if (info) {
        setConnectionInfo(info);
      }
    });
  }, []);

  // Check streaming availability
  useEffect(() => {
    isStreamingAvailable().then((available) => {
      setStreamingEnabled(available);
      if (available) {
        logger.debug('[CharacterChat] Streaming enabled');
      }
    });
  }, []);

  // Handle voice activation
  useEffect(() => {
    const startConnection = async () => {
      if (!isVoiceActive || hasAttemptedConnection.current) return;
      if (!connectionInfo || isConnected || connectionState !== 'idle') return;

      hasAttemptedConnection.current = true;
      setConfigError(null);

      try {
        const maestroLike = characterToMaestro(character, characterId);
        await connect(maestroLike, connectionInfo);
      } catch (error) {
        logger.error('Voice connection failed', { error: String(error) });
        setConfigError(handleMicrophoneError(error));
      }
    };

    startConnection();
  }, [
    isVoiceActive,
    connectionInfo,
    isConnected,
    connectionState,
    character,
    characterId,
    connect,
  ]);

  // Reset connection attempt when voice deactivates
  useEffect(() => {
    if (!isVoiceActive) {
      hasAttemptedConnection.current = false;
    }
  }, [isVoiceActive]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Initialize conversation
  useEffect(() => {
    if (hasLoadedMessages.current) return;
    hasLoadedMessages.current = true;

    async function initConversation() {
      const existingConv = conversations.find((c) => c.maestroId === characterId);

      if (existingConv) {
        conversationIdRef.current = existingConv.id;

        const serverMessages = await loadMessagesFromServer(existingConv.id);
        if (serverMessages) {
          setMessages(serverMessages);
          return;
        }

        if (existingConv.messages.length > 0) {
          setMessages(convertStoreMessages(existingConv.messages));
          return;
        }
      }

      const newConvId = await createConversation(characterId);
      conversationIdRef.current = newConvId;

      const greetingMessage = createGreetingMessage(character);
      setMessages([greetingMessage]);
      await addMessageToStore(newConvId, {
        role: 'assistant',
        content: character.greeting,
      });
    }

    initConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, character.greeting, conversations, createConversation, addMessageToStore]);

  // Handle send message
  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = createUserMessage(input);
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setStreamedContent('');

    if (conversationIdRef.current) {
      addMessageToStore(conversationIdRef.current, {
        role: 'user',
        content: userMessage.content,
      });
    }

    // Try streaming if enabled AND message doesn't require tools
    // Tool requests must go through non-streaming endpoint for tool support
    const needsTool = messageRequiresTool(userMessage.content);
    if (streamingEnabled && !needsTool) {
      const abortController = new AbortController();
      streamAbortRef.current = abortController;
      setIsStreaming(true);

      // Create placeholder message for streaming content
      const streamingMsgId = `streaming-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: streamingMsgId, role: 'assistant', content: '', timestamp: new Date() },
      ]);

      const streamed = await sendStreamingMessage({
        input: userMessage.content,
        messages,
        character,
        characterId,
        signal: abortController.signal,
        onChunk: (_chunk, accumulated) => {
          setStreamedContent(accumulated);
          // Update the streaming message in place
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingMsgId ? { ...m, content: accumulated } : m
            )
          );
        },
        onComplete: (fullResponse) => {
          setIsStreaming(false);
          streamAbortRef.current = null;

          // Finalize the message
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingMsgId
                ? { ...m, id: `assistant-${Date.now()}`, content: fullResponse }
                : m
            )
          );

          if (conversationIdRef.current) {
            addMessageToStore(conversationIdRef.current, {
              role: 'assistant',
              content: fullResponse,
            });
          }

          setIsLoading(false);
        },
        onError: (error) => {
          logger.error('Streaming error', { error });
          setIsStreaming(false);
          streamAbortRef.current = null;
          // Remove the placeholder and show error
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== streamingMsgId),
            createErrorMessage(),
          ]);
          setIsLoading(false);
        },
      });

      // If streaming was used (returned true), we're done
      if (streamed) return;

      // Otherwise fall through to non-streaming
      setIsStreaming(false);
      setMessages((prev) => prev.filter((m) => m.id !== streamingMsgId));
    }

    // Non-streaming fallback
    try {
      const { responseContent, toolState } = await sendChatMessage(
        userMessage.content,
        messages,
        character,
        characterId
      );

      const assistantMessage = createAssistantMessage(responseContent);
      setMessages((prev) => [...prev, assistantMessage]);

      if (conversationIdRef.current) {
        addMessageToStore(conversationIdRef.current, {
          role: 'assistant',
          content: assistantMessage.content,
        });
      }

      if (toolState) {
        setActiveTool(toolState);
      }
    } catch (error) {
      logger.error('Chat error', { error });
      setMessages((prev) => [...prev, createErrorMessage()]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, messages, character, characterId, addMessageToStore, streamingEnabled]);

  // Handle tool request
  const handleToolRequest = useCallback(
    async (toolType: ToolType) => {
      if (isLoading) return;

      setIsLoading(true);
      const newTool = createInitialToolState(toolType);
      setActiveTool(newTool);

      const userMessage = createUserMessage(`Usa lo strumento ${toolType}`);
      setMessages((prev) => [...prev, userMessage]);

      try {
        const { assistantMessage, toolState } = await requestTool(
          toolType,
          messages,
          character,
          characterId
        );

        if (assistantMessage) {
          setMessages((prev) => [...prev, assistantMessage]);
        }

        setActiveTool(toolState);
      } catch (error) {
        logger.error('Tool request error', { error });
        setMessages((prev) => [...prev, createErrorMessage()]);
        setActiveTool(createErrorToolState(toolType, 'Tool request failed'));
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, messages, character, characterId]
  );

  // Handle voice call toggle
  const handleVoiceCall = useCallback(() => {
    if (isVoiceActive) {
      disconnect();
    }
    setIsVoiceActive((prev) => !prev);
  }, [isVoiceActive, disconnect]);

  // Cancel stream handler
  const cancelStream = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
      setIsStreaming(false);
      setIsLoading(false);
    }
  }, []);

  return {
    messages,
    input,
    setInput,
    isLoading,
    isVoiceActive,
    isConnected,
    connectionState,
    configError,
    activeTool,
    setActiveTool,
    messagesEndRef,
    handleSend,
    handleToolRequest,
    handleVoiceCall,
    // Streaming state
    isStreaming,
    streamingEnabled,
    streamedContent,
    cancelStream,
  };
}
