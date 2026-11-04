// Cohen's kappa between two raters over the same hypotheses (owner vs second model), per set.
import { LABELS, type Label } from "./schema.ts";

export interface Kappa {
  readonly n: number;
  /** observed agreement */
  readonly po: number;
  readonly kappa: number;
}

export function cohensKappa(pairs: readonly (readonly [Label, Label])[]): Kappa {
  const n = pairs.length;
  if (n === 0) return { n, po: 0, kappa: 0 };
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const share = (k: 0 | 1, l: Label): number => pairs.filter((p) => p[k] === l).length / n;
  const pe = LABELS.reduce((sum, l) => sum + share(0, l) * share(1, l), 0);
  const kappa = pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { n, po, kappa };
}
