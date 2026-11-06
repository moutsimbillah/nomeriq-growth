export interface SuggestionFailure {
  code: string;
  message: string;
  retryable: boolean;
}

/** Only stable categories cross the UI boundary, never private provider error text. */
export function suggestionFailure(code: string, provider?: string | null): SuggestionFailure {
  const name = provider === "deepseek" ? "DeepSeek" : "The AI provider";
  if (/rate_limit|busy|overload/.test(code)) return { code: "rate_limit", message: `${name} is busy — try again in a moment.`, retryable: true };
  if (/timeout|timed_out/.test(code)) return { code: "request_timeout", message: `${name} took too long. Please try again.`, retryable: true };
  if (/context|too_large|token_limit/.test(code)) return { code: "context_size", message: "The conversation context is too large for this model. Choose a larger-context model in Settings.", retryable: false };
  if (/missing_api_key|key_unreadable|auth|http_401|http_403/.test(code)) return { code: "authentication", message: "The AI credential was refused or could not be read. Check the provider in Settings.", retryable: false };
  if (/quota|billing|balance/.test(code)) return { code: "quota_exceeded", message: "The AI provider's quota or balance is exhausted. Check the provider account in Settings.", retryable: false };
  if (/unavailable/.test(code)) return { code: "provider_unavailable", message: "No AI provider is available for replies. Check the assignment in Settings.", retryable: false };
  if (/invalid.*json|invalid_reply|empty_response/.test(code)) return { code: "invalid_response", message: `${name} returned an incomplete or unreadable reply. Please try again.`, retryable: true };
  return { code: "provider_error", message: `${name} could not complete the request. Please try again.`, retryable: true };
}
