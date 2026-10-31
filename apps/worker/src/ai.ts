// The worker's AI dependencies (M2-03): one OpenAI provider per process (the shared HTTP client inside it)
// and the agent config (models, limits, caps) from the environment. Without OPENAI_API_KEY the worker still
// boots; every run then ends `degraded` with a clear reason (the seller sees facts are unavailable), so a
// misconfigured deploy shows up in agent_runs and the logs instead of a crash loop. No mock answers.
import { createOpenAiCompletionProvider } from "@cleared/adapters";
import { parseAgentConfig, type AgentConfig, type AiProvider } from "@cleared/core";

export interface AiRuntime {
  readonly provider: AiProvider;
  readonly config: AgentConfig;
}

const missingKey: AiProvider = {
  complete: (req) =>
    Promise.resolve({
      ok: false,
      error: { kind: "unavailable", detail: "OPENAI_API_KEY is not set" },
      model: req.model,
      usage: null,
      costUsd: 0,
      latencyMs: 0,
    }),
};

export function aiFromEnv(env: NodeJS.ProcessEnv): AiRuntime {
  const apiKey = env["OPENAI_API_KEY"] ?? "";
  return {
    provider: apiKey === "" ? missingKey : createOpenAiCompletionProvider({ apiKey }),
    config: parseAgentConfig(env),
  };
}
