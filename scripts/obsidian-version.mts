const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const USER_AGENT_PATTERN = /\bobsidian\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u;

export function requireSuccessfulObsidianCliOutput(output: string): string {
  const trimmed = output.trim();
  const failure = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^(?:Error|Evaluation error):/u.test(line));
  if (failure !== undefined) {
    throw new Error(`Obsidian CLI failed: ${failure}`);
  }
  return trimmed;
}

export function parseObsidianVersionEvidence(cliOutput: string, rendererUserAgent: string): string {
  const documentedVersion = cliOutput.trim();
  if (VERSION_PATTERN.test(documentedVersion)) return documentedVersion;
  const fallbackVersion = USER_AGENT_PATTERN.exec(rendererUserAgent)?.[1];
  if (fallbackVersion !== undefined && VERSION_PATTERN.test(fallbackVersion)) {
    return fallbackVersion;
  }
  throw new Error(
    `Obsidian version evidence is unavailable: CLI=${JSON.stringify(documentedVersion)}, renderer user agent=${JSON.stringify(rendererUserAgent)}.`,
  );
}
