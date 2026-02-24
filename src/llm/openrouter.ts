/**
 * OpenRouter LLM client
 */
import fetch from 'node-fetch';
import { ToolSchema } from '../core/interfaces';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  toolCalls?: LLMToolCall[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model?: string;
  finishReason?: string;
}

export interface OpenRouterConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
}

export class OpenRouterClient {
  private config: OpenRouterConfig;

  constructor(config: OpenRouterConfig) {
    this.config = {
      model: 'openai/gpt-4o-mini',
      maxTokens: 4096,
      temperature: 0.7,
      baseUrl: 'https://openrouter.ai/api/v1',
      ...config,
    };
  }

  async chat(
    messages: LLMMessage[],
    tools?: ToolSchema[],
    options?: Partial<OpenRouterConfig>
  ): Promise<LLMResponse> {
    const model = options?.model || this.config.model;
    const maxTokens = options?.maxTokens || this.config.maxTokens;
    const temperature = options?.temperature ?? this.config.temperature;

    const body: any = {
      model,
      messages: messages.map(m => {
        const msg: any = { role: m.role, content: m.content };
        if (m.name) msg.name = m.name;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        return msg;
      }),
      max_tokens: maxTokens,
      temperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            type: 'object',
            properties: t.parameters.reduce((acc: any, p) => {
              acc[p.name] = { type: p.type, description: p.description };
              if (p.default !== undefined) acc[p.name].default = p.default;
              return acc;
            }, {}),
            required: t.parameters.filter(p => p.required).map(p => p.name),
          },
        },
      }));
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': 'https://github.com/aiassistant',
        'X-Title': 'AIAssistant',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error('No response from OpenRouter');
    }

    return {
      content: choice.message?.content || '',
      toolCalls: choice.message?.tool_calls,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      model: data.model,
      finishReason: choice.finish_reason,
    };
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.chat([
        { role: 'user', content: 'Say "ok" and nothing else.' },
      ]);
      return !!response.content;
    } catch {
      return false;
    }
  }
}
