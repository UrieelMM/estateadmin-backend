import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ExpenseEditsService } from './expense-edits.service';

const condominiumPath = 'clients/client-1/condominiums/condo-1';
const expensePath = `${condominiumPath}/expenses/expense-1`;
const markPath = `${condominiumPath}/financialReconciliationMarks/2026-10_expense/items/${createHash('sha256')
  .update(`expense:${expensePath}`)
  .digest('hex')}`;
const invoiceUrl = (objectPath: string) =>
  `https://firebasestorage.googleapis.com/v0/b/test-bucket/o/${encodeURIComponent(objectPath)}?alt=media&token=t`;

type Documents = Record<string, Record<string, any>>;

const createFirestore = (documents: Documents) => {
  let autoId = 0;
  const makeSnapshot = (path: string): any => ({
    id: path.split('/').pop(),
    exists: Object.prototype.hasOwnProperty.call(documents, path),
    data: () => documents[path],
  });
  const makeRef = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    collection: (name: string) => makeCollection(`${path}/${name}`),
    get: async () => makeSnapshot(path),
  });
  const makeQuery = (path: string, field: string, value: unknown, count = Infinity): any => {
    const run = () => {
      const docs = Object.keys(documents)
        .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
        .filter((key) => documents[key][field] === value)
        .slice(0, count)
        .map(makeSnapshot);
      return { docs, empty: docs.length === 0 };
    };
    return {
      isQuery: true,
      run,
      limit: (limit: number) => makeQuery(path, field, value, limit),
      get: async () => run(),
    };
  };
  const makeCollection = (path: string): any => ({
    doc: (id?: string) => makeRef(`${path}/${id ?? `auto-${++autoId}`}`),
    where: (field: string, _operator: string, value: unknown) => makeQuery(path, field, value),
  });
  const runTransaction = async (callback: (tx: any) => Promise<unknown>) => {
    const writes: Array<() => void> = [];
    const tx = {
      get: async (target: any) => (target.isQuery ? target.run() : makeSnapshot(target.path)),
      set: (ref: any, data: Record<string, any>) => writes.push(() => { documents[ref.path] = data; }),
      update: (ref: any, data: Record<string, any>) =>
        writes.push(() => {
          const next = { ...documents[ref.path] };
          Object.entries(data).forEach(([key, value]) => {
            next[key] = value && typeof value === 'object' && 'operand' in value
              ? Number(next[key] || 0) + Number((value as { operand: number }).operand)
              : value;
          });
          documents[ref.path] = next;
        }),
      delete: (ref: any) => writes.push(() => { delete documents[ref.path]; }),
    };
    const result = await callback(tx);
    writes.forEach((write) => write());
    return result;
  };
  return { collection: (name: string) => makeCollection(name), runTransaction };
};

const createService = (documents: Documents) => {
  const service = Object.create(ExpenseEditsService.prototype) as ExpenseEditsService;
  (service as any).firestore = createFirestore(documents);
  (service as any).logger = new Logger('test');
  (service as any).historyHardLimit = 200;
  (service as any).closures = {
    assertOpen: jest.fn().mockResolvedValue(undefined),
    isClosed: jest.fn().mockResolvedValue(false),
    monthForDate: (value: string) => value.slice(0, 7),
  };
  return service;
};

const actor = { uid: 'admin-1', email: 'admin@example.com', name: 'Admin' };
const baseDto = {
  clientId: 'client-1',
  condominiumId: 'condo-1',
  expenseId: 'expense-1',
  expectedAmount: 1500,
  reason: 'Monto capturado incorrectamente',
};
const baseDocuments = (): Documents => ({
  [expensePath]: {
    folio: 'EA-1',
    amount: 150000,
    concept: 'Jardinería',
    expenseDate: '2026-10-05 10:00',
    financialAccountId: 'account-1',
    description: 'Poda',
  },
});

describe('ExpenseEditsService.commitEdit', () => {
  it('updates the amount in cents, removes the reconciliation mark and writes audit records', async () => {
    const documents = { ...baseDocuments(), [markPath]: { reconciled: true } };
    const service = createService(documents);

    const result = await service.commitEdit({
      dto: { ...baseDto, amount: 1450.5 },
      actor,
      idempotencyKey: 'key-1',
      sourceIp: '1.1.1.1',
    });

    expect(result.data).toMatchObject({
      changedFields: ['amount'],
      reconciliationMarkRemoved: true,
      expense: { amount: 1450.5, editCount: 1 },
    });
    expect(documents[expensePath]).toMatchObject({
      amount: 145050,
      description: 'Poda',
      editCount: 1,
      lastEditedBy: { uid: 'admin-1' },
      expenseDate: '2026-10-05 10:00',
      financialAccountId: 'account-1',
    });
    expect(documents[markPath]).toBeUndefined();
    const edit = Object.entries(documents).find(([path]) => path.includes('/expenseEdits/'))?.[1];
    expect(edit).toMatchObject({
      changes: { amount: { before: 150000, after: 145050 } },
      reason: baseDto.reason,
      sourceIp: '1.1.1.1',
    });
    const audit = Object.entries(documents).find(([path]) => path.includes('/auditLogs/'))?.[1];
    expect(audit).toMatchObject({ type: 'finance.expense_edited', after: { amount: 145050 } });
  });

  it('keeps the reconciliation mark when only the description changes', async () => {
    const documents = { ...baseDocuments(), [markPath]: { reconciled: true } };
    const service = createService(documents);

    await service.commitEdit({
      dto: { ...baseDto, description: 'Poda y riego' },
      actor,
      idempotencyKey: 'key-1',
    });

    expect(documents[expensePath]).toMatchObject({ amount: 150000, description: 'Poda y riego' });
    expect(documents[markPath]).toBeDefined();
  });

  it('rejects the edit when the amount changed since the admin opened it', async () => {
    const service = createService(baseDocuments());
    await expect(
      service.commitEdit({
        dto: { ...baseDto, expectedAmount: 1400, amount: 1450 },
        actor,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ response: { code: 'EXPENSE_CHANGED' }, status: 409 });
  });

  it('rejects edits that do not change anything', async () => {
    const service = createService(baseDocuments());
    await expect(
      service.commitEdit({
        dto: { ...baseDto, amount: 1500, description: 'Poda' },
        actor,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ response: { code: 'NO_CHANGES' } });
  });

  it('blocks the edit when the expense month is closing inside the transaction', async () => {
    const documents = {
      ...baseDocuments(),
      [`${condominiumPath}/financialClosures/2026-10_expense`]: { status: 'closing' },
    };
    const service = createService(documents);
    await expect(
      service.commitEdit({ dto: { ...baseDto, amount: 1450 }, actor, idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ response: { code: 'PERIOD_CLOSED' } });
    expect(documents[expensePath].amount).toBe(150000);
  });

  it('blocks amount changes for expenses generated from petty cash', async () => {
    const documents = {
      ...baseDocuments(),
      [`${condominiumPath}/pettyCashTransactions/tx-1`]: { expenseId: 'expense-1', amount: 150000 },
    };
    const service = createService(documents);
    await expect(
      service.commitEdit({ dto: { ...baseDto, amount: 1450 }, actor, idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ response: { code: 'EXPENSE_AMOUNT_LINKED' } });
  });

  it('replays the stored response for the same idempotency key and payload', async () => {
    const documents = baseDocuments();
    const service = createService(documents);
    const params = { dto: { ...baseDto, amount: 1450 }, actor, idempotencyKey: 'key-1' };

    const first = await service.commitEdit(params);
    const replay = await service.commitEdit(params);

    expect(replay.data.editId).toBe(first.data.editId);
    expect(documents[expensePath].editCount).toBe(1);
    await expect(
      service.commitEdit({ ...params, dto: { ...params.dto, amount: 1400 } }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('only accepts receipts stored under the tenant expenses folder', async () => {
    const service = createService(baseDocuments());
    await expect(
      service.commitEdit({
        dto: {
          ...baseDto,
          invoiceUrl: invoiceUrl('clients/other-client/condominiums/condo-1/expenses/EA-1/a.pdf'),
        },
        actor,
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_INVOICE_URL' } });
    await expect(
      service.commitEdit({
        dto: { ...baseDto, invoiceUrl: 'https://evil.example.com/v0/b/test-bucket/o/x' },
        actor,
        idempotencyKey: 'key-2',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_INVOICE_URL' } });

    const documents = baseDocuments();
    const okService = createService(documents);
    const url = invoiceUrl(`${condominiumPath}/expenses/EA-1/factura.pdf`);
    await okService.commitEdit({ dto: { ...baseDto, invoiceUrl: url }, actor, idempotencyKey: 'key-3' });
    expect(documents[expensePath].invoiceUrl).toBe(url);
  });
});
