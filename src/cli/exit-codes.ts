export const ExitCode = {
  success: 0,
  failure: 1,
  usage: 2,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

