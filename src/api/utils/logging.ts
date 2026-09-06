import type { UpstreamStage } from "../types/fact-check";

export type LogValue = string | number | boolean | null | string[] | (number | null)[];
export type Logger = (event: Record<string, LogValue>) => void;

export function createStageRunner(requestId: string, log: Logger) {
  return async function stage<T>(name: UpstreamStage, action: () => Promise<T>): Promise<T> {
    const start = Date.now();
    let success = false;
    try {
      const result = await action();
      success = true;
      return result;
    } finally {
      log({
        event: "stage",
        request_id: requestId,
        stage: name,
        success,
        latency_ms: Date.now() - start,
      });
    }
  };
}
