/**
 * Marca en pagos individuales cuyo `creditUsed` ya es la parte de ese pago (y no el total del grupo).
 * Los pagos multicargo anteriores repetían el total del grupo en cada documento.
 */
export const CREDIT_ALLOCATION_PER_PAYMENT = 'per_payment';

const toCents = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

/**
 * Reparte `totalCents` en orden, hasta el tope de cada posición; el sobrante va a la última.
 * La suma del resultado es exactamente `totalCents`.
 */
export function allocateCents(totalCents: number, capsCents: number[]): number[] {
  const total = Math.max(0, toCents(totalCents));
  if (!capsCents.length) return [];
  let remaining = total;
  const allocation = capsCents.map((cap) => {
    const portion = Math.min(remaining, Math.max(0, toCents(cap)));
    remaining -= portion;
    return portion;
  });
  allocation[allocation.length - 1] += remaining;
  return allocation;
}

/**
 * Parte del crédito usado que sale del saldo a favor inicial. Se consume primero (es el crédito más
 * antiguo) y nunca puede superar el saldo a favor disponible del condómino.
 */
export function resolveOpeningCreditUsage(params: {
  remainingCents: number;
  availableCreditCents: number;
  creditUsedCents: number;
}): number {
  return Math.max(
    0,
    Math.min(
      toCents(params.remainingCents),
      toCents(params.availableCreditCents),
      toCents(params.creditUsedCents),
    ),
  );
}

export interface CreditNormalizationEntry {
  key: string;
  groupKey: string;
  order: string;
  amountPaid: unknown;
  creditUsed: unknown;
  creditAllocation?: unknown;
}

/**
 * Devuelve el `creditUsed` (centavos) que corresponde a cada pago, contando el crédito una sola vez
 * por grupo. Los grupos heredados (sin marca y con el mismo valor repetido) se reparten igual que al
 * escribir; los nuevos se respetan tal cual.
 */
export function normalizeGroupCreditUsed(
  entries: CreditNormalizationEntry[],
): Map<string, number> {
  const result = new Map<string, number>();
  const groups = new Map<string, CreditNormalizationEntry[]>();
  for (const entry of entries) {
    result.set(entry.key, Math.max(0, toCents(entry.creditUsed)));
    if (!entry.groupKey) continue;
    const members = groups.get(entry.groupKey) || [];
    members.push(entry);
    groups.set(entry.groupKey, members);
  }

  groups.forEach((members) => {
    if (members.length < 2) return;
    if (members.some((member) => member.creditAllocation === CREDIT_ALLOCATION_PER_PAYMENT)) return;
    const groupTotal = toCents(members[0].creditUsed);
    if (groupTotal <= 0) return;
    if (members.some((member) => toCents(member.creditUsed) !== groupTotal)) return;

    const ordered = [...members].sort(
      (a, b) => a.order.localeCompare(b.order) || a.key.localeCompare(b.key),
    );
    const allocation = allocateCents(
      groupTotal,
      ordered.map((member) => toCents(member.amountPaid)),
    );
    ordered.forEach((member, index) => result.set(member.key, allocation[index]));
  });

  return result;
}
