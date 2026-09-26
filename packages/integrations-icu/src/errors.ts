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
    public readonly zodError: unknown
  ) {
    super(`Response contract violation for endpoint "${endpoint}"`);
    this.name = 'IcuContractError';
  }
}

export class IcuServerError extends Error {
  constructor(
    public readonly status: number,
    retries: number
  ) {
    super(`Server error ${status.toString()} after ${retries.toString()} retries`);
    this.name = 'IcuServerError';
  }
}

export class IcuHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body: string
  ) {
    super(`ICU API error ${status.toString()} for endpoint "${endpoint}": ${body}`);
    this.name = 'IcuHttpError';
  }
}
