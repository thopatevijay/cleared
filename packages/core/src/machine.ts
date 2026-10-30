// Finite state machines as data: a transition table (state -> event -> next state). A pair that is not
// in the table is forbidden. Tests enumerate every state x event pair against the table.
import { domainError, type DomainError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";

export type TransitionTable<S extends string, E extends string> = {
  readonly [K in S]: Readonly<Partial<Record<E, S>>>;
};

export interface Machine<S extends string, E extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly table: TransitionTable<S, E>;
}

export function transition<S extends string, E extends string>(
  machine: Machine<S, E>,
  state: S,
  event: E,
): Result<S, DomainError> {
  const next = machine.table[state][event];
  if (next === undefined) {
    return err(
      domainError("invalid_transition", `${machine.name}: '${event}' is not allowed in '${state}'`, {
        machine: machine.name,
        state,
        event,
      }),
    );
  }
  return ok(next);
}

/** States with no outgoing transition. */
export function terminalStates<S extends string, E extends string>(machine: Machine<S, E>): S[] {
  return machine.states.filter((s) => Object.keys(machine.table[s]).length === 0);
}
