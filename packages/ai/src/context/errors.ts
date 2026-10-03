export class MissingProfileError extends Error {
  constructor(public readonly userId: string) {
    super(`No profile for user ${userId}`);
    this.name = 'MissingProfileError';
  }
}

export class PromptTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTemplateError';
  }
}
