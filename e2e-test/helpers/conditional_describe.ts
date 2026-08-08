import { describe, it } from 'node:test'

/**
 * Like `describe`, but when `skipReason` is truthy the suite body is not run
 * (so its hooks never execute) and a single skipped placeholder test is
 * registered instead. This keeps skipped suites visible in the summary counts,
 * which `describe(name, { skip }, ...)` does not: a skipped suite's children
 * are never instantiated, so `tests`/`skipped` both stay 0.
 */
export function conditionalDescribe(
  name: string,
  skipReason: string | false,
  body: () => void,
): void {
  describe(name, () => {
    if (skipReason) {
      it(`[skipped] ${skipReason}`, { skip: skipReason }, () => {})
    } else {
      body()
    }
  })
}
