import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-5";

/** Voice turns are latency-sensitive; full effort buys depth this task doesn't need. */
export const EFFORT = "medium" as const;

export function makeClient(): Anthropic {
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and paste your key from https://console.anthropic.com/settings/keys",
    );
  }
  return new Anthropic();
}
