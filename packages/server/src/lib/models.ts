import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
  findSupportedChatModel,
  type SupportedChatModel,
  type SupportedChatModelId,
  type SupportedProvider,
} from "@nightcode/shared";
import type { LanguageModel } from "ai";

type AnthropicModelId = Extract<
  SupportedChatModel,
  { provider: "anthropic" }
>["id"];
type OpenAIModelId = Extract<SupportedChatModel, { provider: "openai" }>["id"];
type GoogleModelId = Extract<SupportedChatModel, { provider: "google" }>["id"];

export type ResolvedModel = {
  model: LanguageModel;
  modelId: SupportedChatModelId;
  provider: SupportedProvider;
  providerOptions?: ProviderOptions;
};

const ANTHROPIC_PROVIDER_OPTIONS: Partial<
  Record<AnthropicModelId, ProviderOptions>
> = {
  "claude-opus-4-6": {
    anthropic: {
      thinking: {
        type: "enabled",
        budgetTokens: 10000,
      },
    },
  },
  "claude-sonnet-4-6": {
    anthropic: {
      thinking: {
        type: "enabled",
        budgetTokens: 10000,
      },
    },
  },
};

const OPENAI_PROVIDER_OPTIONS: Partial<Record<OpenAIModelId, ProviderOptions>> =
  {
    "gpt-5.4": {
      openai: {
        thinking: {
          reasoningSummary: "detailed",
        },
      },
    },
  };

const GOOGLE_PROVIDER_OPTIONS: Partial<Record<GoogleModelId, ProviderOptions>> =
  {
    "gemini-2.5-pro": {
      google: {
        thinkingConfig: {
          thinkingBudget: 10000,
          includeThoughts: true,
        },
      },
    },
    "gemini-2.5-flash": {
      google: {
        thinkingConfig: {
          thinkingBudget: 10000,
          includeThoughts: true,
        },
      },
    },
  };

function assertUnsupportedProvider(provider: never): never {
  throw new Error(`Unsupported provider: ${provider}`);
}

function resolveAnthropicModel(modelId: AnthropicModelId): ResolvedModel {
  return {
    model: anthropic(modelId),
    provider: "anthropic",
    modelId,
    providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
  };
}

function resolveOpenAIModel(modelId: OpenAIModelId): ResolvedModel {
  return {
    model: openai(modelId),
    provider: "openai",
    modelId,
    providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
  };
}

function resolveGoogleModel(modelId: GoogleModelId): ResolvedModel {
  return {
    model: google(modelId),
    provider: "google",
    modelId,
    providerOptions: GOOGLE_PROVIDER_OPTIONS[modelId],
  };
}

function resolveSupportedChatModel(model: SupportedChatModel): ResolvedModel {
  const provider = model.provider;

  switch (provider) {
    case "anthropic": {
      return resolveAnthropicModel(model.id);
    }
    case "openai": {
      return resolveOpenAIModel(model.id);
    }
    case "google": {
      return resolveGoogleModel(model.id);
    }
    default: {
      assertUnsupportedProvider(provider);
    }
  }
}

export function isSupportedChatModel(
  modelId: string,
): modelId is SupportedChatModelId {
  return findSupportedChatModel(modelId) !== null;
}

export function resolveChatModel(modelId: string): ResolvedModel {
  const model = findSupportedChatModel(modelId);
  if (!model) {
    throw new Error(`Unsupported chat model: ${modelId}`);
  }

  return resolveSupportedChatModel(model);
}
