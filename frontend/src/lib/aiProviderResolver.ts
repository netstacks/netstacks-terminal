/**
 * AI Provider Resolver
 *
 * Resolves which AI provider and model to use based on localStorage settings.
 * Always returns both provider and model so the backend never uses a stale
 * ai.provider_config. Resolution order:
 *   per-feature override → default provider → 'anthropic' fallback
 *   per-feature model → user model list → hardcoded default
 */

import { getSettings } from '../hooks/useSettings';
import type { AiProviderType } from '../hooks/useSettings';

export type AiFeature = 'suggestions' | 'nextStep' | 'highlighting' | 'agent' | 'default';

export interface ResolvedProvider {
  provider: string;
  model: string;
}

/** Sensible default model per provider when the user hasn't configured a model list */
const DEFAULT_MODELS: Record<AiProviderType, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  ollama: 'llama3.2',
  openrouter: 'anthropic/claude-3.5-sonnet',
  litellm: 'gpt-4o',
  custom: 'custom',
};

/**
 * Get the first model from the user's configured model list for a provider,
 * falling back to a hardcoded default.
 */
function getModelForProvider(provider: AiProviderType): string {
  const settings = getSettings();
  const key = `ai.models.${provider}` as keyof typeof settings;
  const models = settings[key] as string[] | undefined;
  if (models && models.length > 0) return models[0];
  return DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
}

/**
 * Resolve which provider and model to use for a given AI feature.
 *
 * Always returns both provider and model. Uses per-feature overrides when
 * configured, otherwise uses the global default provider from settings.
 */
export function resolveProvider(feature?: AiFeature): ResolvedProvider {
  const settings = getSettings();
  const enabledProviders: AiProviderType[] = settings['ai.enabledProviders'] || ['anthropic'];
  const defaultProvider: AiProviderType = settings['ai.defaultProvider'] || 'anthropic';

  // Ensure resolved provider is enabled, fall back to first enabled
  const ensureEnabled = (provider: AiProviderType): AiProviderType => {
    if (enabledProviders.includes(provider)) return provider;
    return enabledProviders[0] || 'anthropic';
  };

  if (!feature || feature === 'default') {
    const provider = ensureEnabled(defaultProvider);
    return {
      provider,
      model: getModelForProvider(provider),
    };
  }

  // Check for per-feature overrides
  let featureProvider: AiProviderType | null = null;
  let featureModel: string | null = null;

  switch (feature) {
    case 'suggestions':
    case 'nextStep':
    case 'highlighting':
      // These features use the default provider (no per-feature override)
      break;
    case 'agent':
      featureProvider = settings['ai.agent.provider'];
      featureModel = settings['ai.agent.model'];
      break;
  }

  const provider = ensureEnabled(featureProvider || defaultProvider);
  // If provider changed due to fallback, ignore the feature model
  const resolvedModel = (provider === featureProvider && featureModel)
    ? featureModel
    : getModelForProvider(provider);
  return {
    provider,
    model: resolvedModel,
  };
}
