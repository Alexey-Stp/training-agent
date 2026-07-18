export class IcuRateLimitError extends Error {
  readonly status = 429;

  constructor(message = 'Rate limit exceeded after max retries') {
    super(message);
    this.name = 'IcuRateLimitError';
  }
}

export class IcuAuthError extends Error {
  readonly status = 401;

  constructor(message = 'Authentication failed: invalid API key') {
    super(message);
    this.name = 'IcuAuthError';
  }
}

export class IcuContractError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly zodError: unknown,
  ) {
    super(`Response contract violation for endpoint "${endpoint}"`);
    this.name = 'IcuContractError';
  }
}
