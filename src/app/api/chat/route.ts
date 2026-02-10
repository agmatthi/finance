import { streamText, convertToModelMessages, generateId, stepCountIs } from "ai";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { financeTools } from "@/lib/tools";
import { FinanceUIMessage } from "@/lib/types";
import * as db from '@/lib/db';
import { isSelfHostedMode } from '@/lib/local-db/local-auth';

export const maxDuration = 800;

export async function POST(req: Request) {
  try {
    // Clone request for body parsing (can only read body once)
    const body = await req.json();
    const { messages, sessionId, valyuAccessToken }: { messages: FinanceUIMessage[], sessionId?: string, valyuAccessToken?: string } = body;
    const isSelfHosted = isSelfHostedMode();
    // Use getUserFromRequest to support both cookie and header auth
    const { data: { user } } = await db.getUserFromRequest(req);

    console.log("[Chat API] Request | Session:", sessionId, "| Mode:", isSelfHosted ? 'self-hosted' : 'valyu', "| User:", user?.id || 'anonymous', "| Messages:", messages.length);

    if (!isSelfHosted && !valyuAccessToken) {
      return Response.json(
        { error: "AUTH_REQUIRED", message: "Sign in with Valyu to continue. Get $10 free credits on signup!" },
        { status: 401 }
      );
    }

    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const lmstudioBaseUrl = process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234';
    const localEnabled = req.headers.get('x-ollama-enabled') !== 'false';
    const localProvider = (req.headers.get('x-local-provider') as 'ollama' | 'lmstudio') || 'ollama';
    const userPreferredModel = req.headers.get('x-ollama-model');

    const thinkingModels = ['deepseek-r1', 'deepseek-v3', 'deepseek-v3.1', 'qwen3', 'qwq', 'phi4-reasoning', 'phi-4-reasoning', 'cogito'];
    const preferredModels = ['deepseek-r1', 'qwen3', 'phi4-reasoning', 'cogito', 'llama3.1', 'gemma3:4b', 'gemma3', 'llama3.2', 'llama3', 'qwen2.5', 'codestral'];

    let selectedModel: any;
    let modelInfo: string;
    let supportsThinking = false;

    if (isSelfHosted && localEnabled) {
      try {
        const isLMStudio = localProvider === 'lmstudio';
        const baseURL = isLMStudio ? `${lmstudioBaseUrl}/v1` : `${ollamaBaseUrl}/v1`;
        const providerName = isLMStudio ? 'LM Studio' : 'Ollama';
        const apiEndpoint = isLMStudio ? `${lmstudioBaseUrl}/v1/models` : `${ollamaBaseUrl}/api/tags`;

        const response = await fetch(apiEndpoint, { method: 'GET', signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`${providerName} API: ${response.status}`);

        const data = await response.json();
        const models = isLMStudio
          ? (data.data || []).map((m: any) => ({ name: m.id })).filter((m: any) => !m.name.includes('embed') && !m.name.includes('embedding') && !m.name.includes('nomic'))
          : (data.models || []);

        if (models.length === 0) throw new Error(`No models in ${localProvider}`);

        let selectedModelName = models[0].name;
        if (userPreferredModel && models.some((m: any) => m.name === userPreferredModel)) {
          selectedModelName = userPreferredModel;
        } else {
          const match = preferredModels.map(p => models.find((m: any) => m.name.includes(p))).find(Boolean);
          if (match) selectedModelName = match.name;
        }

        supportsThinking = thinkingModels.some(t => selectedModelName.toLowerCase().includes(t.toLowerCase()));

        const localProviderClient = createOpenAI({ baseURL, apiKey: isLMStudio ? 'lm-studio' : 'ollama' });
        selectedModel = localProviderClient.chat(selectedModelName);
        modelInfo = `${providerName} (${selectedModelName})${supportsThinking ? ' [Reasoning]' : ''} - Self-Hosted`;
      } catch (error) {
        console.error('[Chat API] Local provider error:', error);
        selectedModel = hasOpenAIKey ? openai("gpt-5.2-2025-12-11") : "openai/gpt-5.2-2025-12-11";
        modelInfo = hasOpenAIKey ? "OpenAI (gpt-5.2) - Self-Hosted Fallback" : 'Vercel AI Gateway (gpt-5.2) - Self-Hosted Fallback';
      }
    } else {
      selectedModel = hasOpenAIKey ? openai("gpt-5.2-2025-12-11") : "openai/gpt-5.2-2025-12-11";
      modelInfo = hasOpenAIKey ? "OpenAI (gpt-5.2) - Valyu Mode" : 'Vercel AI Gateway (gpt-5.2) - Valyu Mode';
    }

    console.log("[Chat API] Model:", modelInfo);
    const processingStartTime = Date.now();

    const isUsingLocalProvider = isSelfHosted && localEnabled && (modelInfo.includes('Ollama') || modelInfo.includes('LM Studio'));
    const providerOptions = {
      openai: isUsingLocalProvider
        ? { think: supportsThinking }
        : { store: true, reasoningEffort: 'medium', reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] }
    };

    // Save user message immediately before streaming
    if (user && sessionId && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'user') {
        const { randomUUID } = await import('crypto');
        const { data: existingMessages } = await db.getChatMessages(sessionId);

        await db.saveChatMessages(sessionId, [...(existingMessages || []), {
          id: randomUUID(),
          role: 'user' as const,
          content: lastMessage.parts || [],
        }].map((msg: any) => ({
          id: msg.id,
          role: msg.role,
          content: typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content,
        })));

        await db.updateChatSession(sessionId, user.id, { last_message_at: new Date() });
      }
    }

    const convertedMessages = await convertToModelMessages(messages);

    const result = streamText({
      model: selectedModel as any,
      messages: convertedMessages,
      tools: financeTools,
      toolChoice: "auto",
      stopWhen: stepCountIs(10),
      experimental_context: {
        userId: user?.id,
        sessionId,
        valyuAccessToken,
      },
      providerOptions,
      system: `You are a professional financial analyst AI assistant with access to specialized tools for data retrieval, analysis, and visualization.

AVAILABLE TOOLS:
- financeSearch: Stock prices, earnings, financial statements, market data (structured proprietary data)
- secSearch: SEC filings (10-K, 10-Q, 8-K, Form 4 insider transactions)
- economicsSearch: BLS labor statistics, FRED data, World Bank indicators
- patentSearch: USPTO patent databases
- financeJournalSearch: Academic finance literature (Wiley journals, textbooks)
- polymarketSearch: Prediction market data and event probabilities
- webSearch: General web search for news, sentiment, qualitative information. Use as fallback when other tools return no results.
- codeExecution: Secure Python sandbox (Daytona). For calculations, financial modeling, statistical analysis.
- createChart: Interactive charts (line, bar, area, scatter, quadrant)
- createCSV: Downloadable CSV files rendered as inline tables

TOOL SELECTION RULES:
- Use financeSearch for structured data: prices, earnings, financials
- Use webSearch for qualitative info (news, sentiment, analyst opinions) or when financeSearch returns 0 results
- Use secSearch ONLY for 10-K, 10-Q, 8-K, Form 4 filings
- Use codeExecution for ANY calculation or derived metric (correlations, ratios, Sharpe ratios, models)
- Search tools return RAW DATA, not computed results. First search for data, then compute with codeExecution.
- Max 5 parallel tool calls at a time

CITATIONS:
- Use [1], [2], [3] for search result citations
- Place citations ONLY at END of sentences: "Revenue grew 50% [1]."
- NEVER at the beginning: "[1] Revenue grew 50%." is WRONG
- Group multiple: "Strong growth confirmed [1][2][3]."
- Citations are mandatory for specific numbers, financials, quotes, and factual claims

CODE EXECUTION (codeExecution):
- ALWAYS include print() statements - code without print() produces no visible output
- NEVER display Python code as text - ALWAYS execute it with the tool
- Max 10,000 chars per code block; split into multiple calls if needed
- Available: numpy, pandas, scikit-learn (install others via pip)
- Use f-string formatting for professional output with labels, units, currency symbols

CHART CREATION (createChart):
- dataSeries format: [{name: "Series", data: [{x: "date/label", y: number}]}]
- For scatter/quadrant: add optional size and label per data point
- After creating a chart, embed in response: ![Chart Title](/api/charts/{chartId}/image)
- Always visualize time series data

CSV CREATION (createCSV):
- After creating, reference as: ![csv](csv:csvId)

MATH: Use <math>...</math> tags for all mathematical expressions. Never use raw LaTeX or $ delimiters.

RESPONSE FORMAT:
- Use markdown tables for financial data with proper formatting ($1,234,567)
- Use headers (##, ###) to organize sections
- Start with executive summary, then detailed sections, then key takeaways
- Do NOT repeat executed Python code in your final response

WORKFLOW:
1. Complete ALL data gathering (searches, calculations)
2. Create ALL charts/visualizations
3. Present final formatted analysis

AGENT BEHAVIOR:
- After reasoning, always call a tool or provide a final answer
- If a tool call fails, immediately retry with corrections or use an alternative tool
- Process all items the user requests before finishing
- Never suggest using Python to fetch data from APIs - use search tools instead
- Be thorough and detailed like an elite professional financial analyst
`,
    });

    const streamResponse = result.toUIMessageStreamResponse({
      sendReasoning: true,
      originalMessages: messages,
      generateMessageId: generateId,
      onFinish: async ({ messages: allMessages }) => {
        const processingTimeMs = Date.now() - processingStartTime;

        if (user && sessionId) {
          const { randomUUID } = await import('crypto');
          const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

          const messagesToSave = allMessages.map((message: any, index: number) => {
            // Extract content from parts (AI SDK v5+) or legacy content field
            let contentToSave: any[] = [];
            if (message.parts && Array.isArray(message.parts)) {
              contentToSave = message.parts;
            } else if (typeof message.content === 'string') {
              contentToSave = [{ type: 'text', text: message.content }];
            } else if (Array.isArray(message.content)) {
              contentToSave = message.content;
            }

            const isLastAssistant = message.role === 'assistant' && index === allMessages.length - 1;
            return {
              id: UUID_REGEX.test(message.id || '') ? message.id : randomUUID(),
              role: message.role,
              content: contentToSave,
              processing_time_ms: isLastAssistant ? processingTimeMs : undefined,
            };
          });

          const saveResult = await db.saveChatMessages(sessionId, messagesToSave);
          if (saveResult.error) {
            console.error('[Chat API] Save error:', saveResult.error);
          } else {
            await db.updateChatSession(sessionId, user.id, { last_message_at: new Date() });
          }
        }
      }
    });

    if (isSelfHosted) {
      streamResponse.headers.set("X-Self-Hosted-Mode", "true");
    }

    return streamResponse;
  } catch (error) {
    console.error("[Chat API] Error:", error);

    const errorMessage = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'An unexpected error occurred';

    const lowerMsg = errorMessage.toLowerCase();

    // Handle context length exceeded errors gracefully
    const isContextError = lowerMsg.includes('context_length') || lowerMsg.includes('context window') || lowerMsg.includes('too many tokens');
    if (isContextError) {
      return Response.json(
        { error: "CONTEXT_LENGTH_ERROR", message: "The conversation has grown too long. Please start a new chat session to continue." },
        { status: 400 }
      );
    }

    const isToolError = lowerMsg.includes('tool') || lowerMsg.includes('function');
    const isThinkingError = lowerMsg.includes('thinking');

    if (isToolError || isThinkingError) {
      return Response.json(
        { error: "MODEL_COMPATIBILITY_ERROR", message: errorMessage, compatibilityIssue: isToolError ? "tools" : "thinking" },
        { status: 400 }
      );
    }

    return Response.json(
      { error: "CHAT_ERROR", message: errorMessage, details: error instanceof Error ? error.stack : undefined },
      { status: 500 }
    );
  }
}
