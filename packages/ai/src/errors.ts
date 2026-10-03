const MAX_BODY_CHARS = 500;

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export class LlmTimeoutError extends LlmError {
  constructor(public readonly timeoutMs: number) {
    super(`LLM call timed out after ${timeoutMs.toString()} ms`);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmAuthError extends LlmError {
  constructor(public readonly status: number) {
    super(`LLM authentication failed (${status.toString()})`);
    this.name = 'LlmAuthError';
  }
}

export class LlmRateLimitError extends LlmError {
  readonly status = 429;

  constructor() {
    super('LLM rate limit exceeded after retry');
    this.name = 'LlmRateLimitError';
  }
}

export class LlmServerError extends LlmError {
  constructor(public readonly status: number) {
    super(`LLM server error ${status.toString()} after retry`);
    this.name = 'LlmServerError';
  }
}

export class LlmNetworkError extends LlmError {
  constructor(public readonly cause: unknown) {
    super('LLM request failed: network error after retry');
    this.name = 'LlmNetworkError';
  }
}

export class LlmHttpError extends LlmError {
  public readonly body: string;

  constructor(
    public readonly status: number,
    body: string
  ) {
    super(`LLM API error ${status.toString()}`);
    this.name = 'LlmHttpError';
    this.body = body.slice(0, MAX_BODY_CHARS);
  }
}

export class LlmContractError extends LlmError {
  constructor(
    message: string,
    public readonly detail: unknown
  ) {
    super(message);
    this.name = 'LlmContractError';
  }
}

export class LlmRefusalError extends LlmError {
  constructor(public readonly category: string | null) {
    super(`LLM declined the request (category: ${category ?? 'unknown'})`);
    this.name = 'LlmRefusalError';
  }
}
