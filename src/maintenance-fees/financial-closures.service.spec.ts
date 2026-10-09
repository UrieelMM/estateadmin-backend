import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { FinancialClosuresService } from './financial-closures.service';

const base = 'clients/client-1/condominiums/condo-1';

const fakeFirestore = (documents: Record<string, any>) => {
  let nextId = 0;
  const snapshot = (path: string): any => ({
    id: path.split('/').pop(), path, exists: Object.prototype.hasOwnProperty.call(documents, path),
    data: () => documents[path], ref: reference(path),
  });
  const reference = (path: string): any => ({
    id: path.split('/').pop(), path,
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => snapshot(path),
  });
  const collection = (path: string): any => ({
    doc: (id?: string) => reference(`${path}/${id || `auto-${++nextId}`}`),
    get: async () => ({ docs: Object.keys(documents)
      .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
      .map(snapshot) }),
    orderBy: () => ({ get: async () => ({ docs: Object.keys(documents)
      .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
      .map(snapshot) }) }),
  });
  return {
    collection,
    runTransaction: async (callback: (tx: any) => Promise<any>) => callback({
      get: async (ref: any) => snapshot(ref.path),
      set: (ref: any, value: any, options?: { merge: boolean }) => { documents[ref.path] = options?.merge ? { ...documents[ref.path], ...value } : value; },
      update: (ref: any, value: any) => { documents[ref.path] = { ...documents[ref.path], ...value }; },
      delete: (ref: any) => { delete documents[ref.path]; },
    }),
  };
};

const serviceWith = (documents: Record<string, any>) => {
  const service = Object.create(FinancialClosuresService.prototype) as FinancialClosuresService;
  (service as any).db = fakeFirestore(documents);
  return service;
};

describe('FinancialClosuresService', () => {
  it('lists dated income and expenses without counting applied unidentified payments twice', async () => {
    const documents: Record<string, any> = {
      [`${base}/users/user-1`]: { name: 'Ana', lastName: 'López', number: '101' },
      [`${base}/users/user-1/charges/charge-1`]: { concept: 'Mantenimiento' },
      [`${base}/users/user-1/charges/charge-1/payments/payment-1`]: {
        paymentDate: admin.firestore.Timestamp.fromDate(new Date('2026-02-10T12:00:00Z')),
        amountPaid: 12500, paymentReference: 'REF-1',
      },
      [`${base}/unidentifiedPayments/unidentified-1`]: {
        paymentDate: admin.firestore.Timestamp.fromDate(new Date('2026-02-11T12:00:00Z')),
        amountPaid: 3000, appliedToUser: false,
      },
      [`${base}/unidentifiedPayments/unidentified-2`]: {
        paymentDate: admin.firestore.Timestamp.fromDate(new Date('2026-02-11T12:00:00Z')),
        amountPaid: 12500, appliedToUser: true,
      },
      [`${base}/expenses/expense-1`]: { expenseDate: '2026-02-12 09:00', amount: 2500, concept: 'Limpieza' },
      [`${base}/expenses/expense-2`]: { expenseDate: '2026-03-01', amount: 1000, concept: 'Fuera del mes' },
    };
    const service = serviceWith(documents);
    const result = await service.movements({ clientId: 'client-1', condominiumId: 'condo-1', from: '2026-02-01', to: '2026-02-28', direction: 'all', page: 1, limit: 25 });
    expect(result.total).toBe(3);
    expect(result.summary.incomeCents).toBe(15500);
    expect(result.summary.expenseCents).toBe(2500);
    expect(result.items.find((row) => row.reference === 'REF-1')?.condominiumUnit).toBe('Ana López · 101');
  });

  it('blocks a payment operation while the month is closed', async () => {
    const documents = { [`${base}/financialClosures/2026-02`]: { status: 'closed', month: '2026-02' } };
    const service = serviceWith(documents);
    const action = jest.fn();
    await expect(service.withOpenMonth('client-1', 'condo-1', '2026-02-12T12:00:00Z', action))
      .rejects.toThrow('cerrado');
    expect(action).not.toHaveBeenCalled();
  });

  it('holds a mutation lease until a payment operation finishes', async () => {
    const documents: Record<string, any> = {};
    const service = serviceWith(documents);
    await service.withOpenMonth('client-1', 'condo-1', '2026-02-12', async () => {
      expect(documents[`${base}/financialClosures/2026-02`].activeMutations).toBe(1);
    });
    expect(documents[`${base}/financialClosures/2026-02`].activeMutations).toBe(0);
  });

  it('blocks new movements while closing and saves the month totals', async () => {
    const documents: Record<string, any> = {};
    const service = serviceWith(documents);
    const rows = [
      { id: 'income:1', type: 'income', date: '2026-02-10', amount: 10000, concept: 'Cuota', condominiumUnit: '101', reference: '', accountId: '', description: '' },
      { id: 'expense:1', type: 'expense', date: '2026-02-11', amount: 2500, concept: 'Limpieza', condominiumUnit: '', reference: '', accountId: '', description: '' },
    ];
    (service as any).readMovements = async () => {
      await expect(service.withOpenMonth('client-1', 'condo-1', '2026-02-12', async () => undefined)).rejects.toThrow('cerrado');
      return rows;
    };
    const digest = (service as any).summarize(rows).digest;
    const result = await service.close({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', openingBalanceCents: 50000, expectedDigest: digest, actorUid: 'admin-1' });
    expect(result.closingBalanceCents).toBe(57500);
    expect(documents[`${base}/financialClosures/2026-02`].status).toBe('closed');
  });

  it('requires later closed months to reopen before closing an earlier month', async () => {
    const documents: Record<string, any> = {
      [`${base}/financialClosures/2026-03`]: { month: '2026-03', status: 'closed' },
    };
    const service = serviceWith(documents);
    await expect(service.close({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', openingBalanceCents: 0, expectedDigest: '', actorUid: 'admin-1' }))
      .rejects.toThrow('meses posteriores');
  });

  it('reopens the month after a matching one-time code', async () => {
    const salt = 'test-salt';
    const code = '123456';
    const documents: Record<string, any> = {
      [`${base}/financialClosures/2026-02`]: { month: '2026-02', status: 'closed', closedAt: admin.firestore.Timestamp.now() },
      [`${base}/financialReopenChallenges/2026-02`]: {
        hash: createHash('sha256').update(`${salt}:${code}`).digest('hex'), salt,
        actorUid: 'admin-1', attempts: 0,
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 600000),
      },
    };
    const service = serviceWith(documents);
    await expect(service.reopen({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', code: '000000', actorUid: 'admin-1' })).rejects.toThrow('incorrecto');
    expect(documents[`${base}/financialReopenChallenges/2026-02`].attempts).toBe(1);
    await service.reopen({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', code, actorUid: 'admin-1' });
    expect(documents[`${base}/financialClosures/2026-02`].status).toBe('open');
    expect(documents[`${base}/financialReopenChallenges/2026-02`]).toBeUndefined();
  });
});
