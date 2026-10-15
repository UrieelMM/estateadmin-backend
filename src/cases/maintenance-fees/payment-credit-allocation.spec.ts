import {
  CREDIT_ALLOCATION_PER_PAYMENT,
  allocateCents,
  normalizeGroupCreditUsed,
  resolveOpeningCreditUsage,
} from './payment-credit-allocation';

describe('allocateCents', () => {
  it('reparte en orden hasta el tope de cada pago', () => {
    expect(allocateCents(70000, [50000, 50000, 50000])).toEqual([50000, 20000, 0]);
  });

  it('manda el sobrante al último pago y conserva la suma exacta', () => {
    const allocation = allocateCents(60000, [30000, 20000]);
    expect(allocation).toEqual([30000, 30000]);
    expect(allocation.reduce((sum, value) => sum + value, 0)).toBe(60000);
  });

  it('regresa ceros cuando no hay crédito', () => {
    expect(allocateCents(0, [100, 200])).toEqual([0, 0]);
    expect(allocateCents(500, [])).toEqual([]);
  });
});

describe('resolveOpeningCreditUsage', () => {
  it('consume primero el saldo a favor inicial', () => {
    expect(
      resolveOpeningCreditUsage({ remainingCents: 100000, availableCreditCents: 150000, creditUsedCents: 60000 }),
    ).toBe(60000);
    expect(
      resolveOpeningCreditUsage({ remainingCents: 40000, availableCreditCents: 150000, creditUsedCents: 60000 }),
    ).toBe(40000);
  });

  it('no supera el saldo a favor disponible ni regresa negativos', () => {
    expect(
      resolveOpeningCreditUsage({ remainingCents: 100000, availableCreditCents: 30000, creditUsedCents: 60000 }),
    ).toBe(30000);
    expect(
      resolveOpeningCreditUsage({ remainingCents: 100000, availableCreditCents: 150000, creditUsedCents: 0 }),
    ).toBe(0);
  });
});

describe('normalizeGroupCreditUsed', () => {
  const legacyGroup = [
    { key: 'c', groupKey: 'g1', order: '2025-03-01', amountPaid: 50000, creditUsed: 80000 },
    { key: 'a', groupKey: 'g1', order: '2025-01-01', amountPaid: 50000, creditUsed: 80000 },
    { key: 'b', groupKey: 'g1', order: '2025-02-01', amountPaid: 50000, creditUsed: 80000 },
  ];

  it('cuenta una sola vez el crédito repetido de grupos heredados', () => {
    const result = normalizeGroupCreditUsed(legacyGroup);
    expect(result.get('a')).toBe(50000);
    expect(result.get('b')).toBe(30000);
    expect(result.get('c')).toBe(0);
    expect([...result.values()].reduce((sum, value) => sum + value, 0)).toBe(80000);
  });

  it('respeta pagos ya repartidos al escribir', () => {
    const result = normalizeGroupCreditUsed([
      { key: 'a', groupKey: 'g2', order: '1', amountPaid: 50000, creditUsed: 30000, creditAllocation: CREDIT_ALLOCATION_PER_PAYMENT },
      { key: 'b', groupKey: 'g2', order: '2', amountPaid: 50000, creditUsed: 30000, creditAllocation: CREDIT_ALLOCATION_PER_PAYMENT },
    ]);
    expect(result.get('a')).toBe(30000);
    expect(result.get('b')).toBe(30000);
  });

  it('no toca pagos únicos, sin grupo o con valores distintos', () => {
    const result = normalizeGroupCreditUsed([
      { key: 'solo', groupKey: 'g3', order: '1', amountPaid: 50000, creditUsed: 20000 },
      { key: 'nogroup1', groupKey: '', order: '1', amountPaid: 50000, creditUsed: 20000 },
      { key: 'nogroup2', groupKey: '', order: '2', amountPaid: 50000, creditUsed: 20000 },
      { key: 'd1', groupKey: 'g4', order: '1', amountPaid: 50000, creditUsed: 10000 },
      { key: 'd2', groupKey: 'g4', order: '2', amountPaid: 50000, creditUsed: 5000 },
    ]);
    expect(result.get('solo')).toBe(20000);
    expect(result.get('nogroup1')).toBe(20000);
    expect(result.get('nogroup2')).toBe(20000);
    expect(result.get('d1')).toBe(10000);
    expect(result.get('d2')).toBe(5000);
  });
});
