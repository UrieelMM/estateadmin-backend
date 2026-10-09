import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { FinancialClosuresService } from './financial-closures.service';
import { mailerSend } from '../utils/mailerSend';

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
    set: async (value: any) => { documents[path] = value; },
    delete: async () => { delete documents[path]; },
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
  afterEach(() => jest.restoreAllMocks());

  it('emails a one-time reopening code to the configured administrator', async () => {
    const documents: Record<string, any> = {
      [base]: { reconciliationAdminEmail: 'ADMIN@EXAMPLE.COM' },
      [`${base}/financialClosures/2026-02`]: { status: 'closed' },
    };
    const send = jest.spyOn(mailerSend.email, 'send').mockResolvedValue({} as any);

    const result = await serviceWith(documents).requestReopen({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', actorUid: 'admin-1' });

    expect(result).toEqual({ sent: true, emailMasked: 'a***@example.com', expiresInSeconds: 600 });
    expect(send).toHaveBeenCalledTimes(1);
    const email = send.mock.calls[0][0];
    expect(email.to[0].email).toBe('admin@example.com');
    expect(email.text).toMatch(/\b\d{6}\b/);
    expect(documents[`${base}/financialReopenChallenges/2026-02`]).toMatchObject({ actorUid: 'admin-1', attempts: 0 });
    expect(documents[`${base}/financialReopenChallenges/2026-02`].code).toBeUndefined();
  });

  it('requires a configured email and removes the challenge if sending fails', async () => {
    const documents: Record<string, any> = {
      [base]: { reconciliationAdminEmail: 'invalid' },
      [`${base}/financialClosures/2026-02`]: { status: 'closed' },
    };
    const send = jest.spyOn(mailerSend.email, 'send').mockRejectedValue(new Error('email rejected'));
    const service = serviceWith(documents);
    await expect(service.requestReopen({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', actorUid: 'admin-1' }))
      .rejects.toThrow('Configura un correo válido');
    expect(send).not.toHaveBeenCalled();

    documents[base].reconciliationAdminEmail = 'admin@example.com';
    await expect(service.requestReopen({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', actorUid: 'admin-1' }))
      .rejects.toThrow('No se pudo enviar el código');
    expect(documents[`${base}/financialReopenChallenges/2026-02`]).toBeUndefined();
  });

  it('does not remove a newer challenge when an earlier email send fails', async () => {
    const challengePath = `${base}/financialReopenChallenges/2026-02`;
    const documents: Record<string, any> = {
      [base]: { reconciliationAdminEmail: 'admin@example.com' },
      [`${base}/financialClosures/2026-02`]: { status: 'closed' },
    };
    jest.spyOn(mailerSend.email, 'send').mockImplementation(async () => {
      documents[challengePath] = { requestId: 'newer-request' };
      throw new Error('email rejected');
    });

    await expect(serviceWith(documents).requestReopen({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', actorUid: 'admin-1' }))
      .rejects.toThrow('No se pudo enviar el código');
    expect(documents[challengePath]).toEqual({ requestId: 'newer-request' });
  });

  it('lists dated income and expenses without counting applied unidentified payments twice', async () => {
    const documents: Record<string, any> = {
      [`${base}/users/user-1`]: { name: 'Ana', lastName: 'López', number: '101' },
      [`${base}/users/user-1/charges/charge-1`]: { concept: 'Mantenimiento' },
      [`${base}/users/user-1/charges/charge-1/payments/payment-1`]: {
        paymentDate: admin.firestore.Timestamp.fromDate(new Date('2026-02-10T12:00:00Z')),
        amountPaid: 12500, paymentReference: 'REF-1',
      },
      [`${base}/users/user-1/charges/charge-1/payments/payment-jan`]: {
        paymentDate: admin.firestore.Timestamp.fromDate(new Date('2026-01-10T12:00:00Z')),
        amountPaid: 10000,
      },
      [`${base}/financialAccounts/bank-1`]: { name: 'Banco principal', type: 'bank', initialBalance: 500 },
      [`${base}/financialAccounts/cash-1`]: { name: 'Caja chica', type: 'cash', initialBalance: 50 },
      [`${base}/financialClosures/2026-01`]: { status: 'closed', month: '2026-01', incomeCents: 10000, expenseCents: 0, closingBalanceCents: 60000 },
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
    expect(result.overview.configuredInitialBalanceCents).toBe(55000);
    expect(result.overview.bankInitialBalanceCents).toBe(50000);
    expect(result.overview.historicalIncomeCents).toBe(25500);
    expect(result.overview.balanceBeforePeriodCents).toBe(60000);
    expect(result.overview.balanceAtEndCents).toBe(73000);
    expect(result.overview.previousMonthIsClosed).toBe(true);
  });

  it('blocks a payment operation while the month is closed', async () => {
    const documents = { [`${base}/financialClosures/2026-02`]: { status: 'closed', month: '2026-02' } };
    const service = serviceWith(documents);
    const action = jest.fn();
    await expect(service.withOpenMonth('client-1', 'condo-1', '2026-02-12T12:00:00Z', action))
      .rejects.toThrow('cerrado');
    expect(action).not.toHaveBeenCalled();
  });

  it('carries the last closed balance through months without a closure', async () => {
    const documents: Record<string, any> = {
      [`${base}/financialAccounts/bank-1`]: { name: 'Banco', type: 'bank', initialBalance: 500 },
      [`${base}/financialClosures/2026-01`]: { month: '2026-01', status: 'closed', to: '2026-01-31', closingBalanceCents: 60000, incomeCents: 10000, expenseCents: 0 },
    };
    const service = serviceWith(documents);
    (service as any).readMovements = async () => [
      { id: 'expense:1', type: 'expense', date: '2026-02-14', amount: 1000 },
      { id: 'income:1', type: 'income', date: '2026-03-10', amount: 2000 },
    ];
    const result = await service.movements({ clientId: 'client-1', condominiumId: 'condo-1', from: '2026-03-01', to: '2026-03-31', page: 1, limit: 25 });
    expect(result.overview.previousMonth).toBe('2026-01');
    expect(result.overview.balanceBeforePeriodCents).toBe(59000);
    expect(result.overview.balanceAtEndCents).toBe(61000);
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
    const documents: Record<string, any> = {
      [`${base}/financialAccounts/account-1`]: { name: 'Banco', type: 'bank', initialBalance: 500 },
    };
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

  it('does not close with an opening balance different from the configured account balance', async () => {
    const documents: Record<string, any> = {
      [`${base}/financialAccounts/account-1`]: { name: 'Banco', type: 'bank', initialBalance: 500 },
    };
    const service = serviceWith(documents);
    (service as any).readMovements = async () => [];
    const digest = (service as any).summarize([]).digest;
    await expect(service.close({ clientId: 'client-1', condominiumId: 'condo-1', month: '2026-02', openingBalanceCents: 0, expectedDigest: digest, actorUid: 'admin-1' }))
      .rejects.toThrow('saldo inicial cambió');
    expect(documents[`${base}/financialClosures/2026-02`].status).toBe('open');
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
