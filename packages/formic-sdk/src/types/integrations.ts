// Integration types — verbatim copies from src/types/index.ts

export type WebhookResponse = { status: number; body?: unknown };
export type WebhookHandler = (body: unknown, headers: Record<string, string>) => Promise<WebhookResponse>;

export interface BotCommandDefinition {
  name: string;
  description: string;
  handler: (args: string, chatId: string) => Promise<string>;
}
