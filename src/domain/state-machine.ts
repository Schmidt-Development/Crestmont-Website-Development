export class TransitionError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string, reason?: string) {
    super(`Invalid transition ${from} → ${to}${reason ? `: ${reason}` : ""}`);
    this.from = from;
    this.to = to;
  }
}

export function assertTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): void {
  const allowed = table[from];
  if (!allowed || !allowed.includes(to)) throw new TransitionError(from, to);
}
