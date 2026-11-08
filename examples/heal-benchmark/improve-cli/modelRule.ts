export const DEFAULT_MODEL = 'qwen/qwen3.7-flash';

const UNSHARED = /(^|\/)stealth\/|crouton-alpha/i;

export function refuseUnsharedModel(flag: string, model: string | undefined): void {
  if (model === undefined || !UNSHARED.test(model)) return;
  throw new Error(`${flag} ${model}: this model must never see captured traces. Use ${DEFAULT_MODEL} or another paid model that may read them.`);
}

function flagValues(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((arg, index) => {
    if (arg === flag) return argv[index + 1] === undefined ? [] : [argv[index + 1]];
    return arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : [];
  });
}

export function refuseUnsharedModels(argv: readonly string[]): void {
  for (const flag of ['--model', '--editor']) for (const model of flagValues(argv, flag)) refuseUnsharedModel(flag, model);
}
