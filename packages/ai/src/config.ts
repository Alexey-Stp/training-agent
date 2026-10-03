import { z } from 'zod';

export const aiEnvSchema = z
  .object({
    AI_PROVIDER: z.enum(['anthropic', 'mock']).default('mock'),
    AI_MODEL: z.string().min(1).default('claude-opus-5-5'),
    AI_API_KEY: z.string().min(1).optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'anthropic' && !env.AI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_API_KEY'],
        message: 'AI_API_KEY is required when AI_PROVIDER=anthropic',
      });
    }
  });

export type AiConfig = z.infer<typeof aiEnvSchema>;

/** Parses AI_* settings from the environment. Throws a ZodError when they are invalid. */
export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  return aiEnvSchema.parse(env);
}
