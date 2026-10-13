import { type ConfigProblems } from "../config";

const ORDER = ["proxyBase", "secret", "sasUrl"] as const;

export function firstProblem(problems: ConfigProblems): string | undefined {
  for (const key of ORDER) {
    const problem = problems[key];
    if (problem) {
      return problem;
    }
  }
  return undefined;
}
