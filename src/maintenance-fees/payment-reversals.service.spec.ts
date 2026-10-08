import { PaymentReversalsService } from './payment-reversals.service';

const condominiumPath = 'clients/client-1/condominiums/condo-1';
const paymentPath = (chargeId: string, paymentId: string) =>
  `${condominiumPath}/users/user-1/charges/${chargeId}/payments/${paymentId}`;

const createFirestore = (documents: Record<string, Record<string, unknown>>) => {
  const makeRef = (path: string): any => ({
    path,
    id: path.split('/').pop(),
    collection: (name: string) => makeCollection(`${path}/${name}`),
    get: async () => makeSnapshot(path),
  });
  const makeSnapshot = (path: string): any => ({
    id: path.split('/').pop(),
    ref: makeRef(path),
    exists: Object.prototype.hasOwnProperty.call(documents, path),
    data: () => documents[path],
  });
  const makeCollection = (path: string): any => ({
    doc: (id: string) => makeRef(`${path}/${id}`),
    where: (field: string, _operator: string, value: unknown) => ({
      limit: (count: number) => ({
        get: async () => ({
          docs: Object.keys(documents)
            .filter((key) => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1)
            .filter((key) => documents[key][field] === value)
            .slice(0, count)
            .map(makeSnapshot),
        }),
      }),
    }),
  });
  return {
    collection: (name: string) => makeCollection(name),
    doc: makeRef,
  };
};

const resolve = async (documents: Record<string, Record<string, unknown>>, paymentId: string, chargeId = 'charge-1') => {
  const service = Object.create(PaymentReversalsService.prototype) as PaymentReversalsService;
  (service as any).firestore = createFirestore(documents);
  (service as any).maxComponentsPerOperation = 250;
  return (service as any).tryResolveIdentifiedPayment({
    clientId: 'client-1',
    condominiumId: 'condo-1',
    paymentId,
    userId: 'user-1',
    chargeId,
  });
};

describe('PaymentReversalsService payment resolution', () => {
  const baseDocuments = {
    [`${condominiumPath}/users/user-1`]: {},
    [`${condominiumPath}/users/user-1/charges/charge-1`]: { amount: 0 },
    [`${condominiumPath}/users/user-1/charges/charge-2`]: { amount: 0 },
  };

  it('resolves a single payment even when the consolidated chargeUID is empty', async () => {
    const payment = {
      paymentId: 'payment-1',
      paymentGroupId: 'payment-1',
      userId: 'user-1',
      chargeUID: '',
      clientId: 'client-1',
      condominiumId: 'condo-1',
      amountPaid: 100,
    };
    const target = await resolve({
      ...baseDocuments,
      [paymentPath('charge-1', 'payment-1')]: payment,
      [`${condominiumPath}/paymentsToSendEmail/payment-1`]: payment,
    }, 'payment-1');

    expect(target.amountPaid).toBe(100);
    expect(target.components).toHaveLength(1);
    expect(target.components[0].paymentDocPath).toBe(paymentPath('charge-1', 'payment-1'));
  });

  it('resolves the complete group from either component of a multi-charge payment', async () => {
    const first = {
      paymentId: 'payment-1', paymentGroupId: 'group-1', userId: 'user-1',
      chargeUID: 'charge-1', clientId: 'client-1', condominiumId: 'condo-1', amountPaid: 100,
    };
    const second = {
      ...first, paymentId: 'payment-2', chargeUID: 'charge-2', amountPaid: 50,
    };
    const target = await resolve({
      ...baseDocuments,
      [paymentPath('charge-1', 'payment-1')]: first,
      [paymentPath('charge-2', 'payment-2')]: second,
      [`${condominiumPath}/paymentsToSendEmail/consolidated-1`]: {
        paymentId: 'consolidated-1', paymentGroupId: 'group-1',
        userId: 'user-1', payments: [first, second], amountPaid: 150,
      },
    }, 'payment-2', 'charge-2');

    expect(target.paymentId).toBe('consolidated-1');
    expect(target.amountPaid).toBe(150);
    expect(target.components.map((component: any) => component.paymentId)).toEqual(['payment-1', 'payment-2']);
  });

  it('rejects an orphaned component of a multi-charge payment', async () => {
    await expect(resolve({
      ...baseDocuments,
      [paymentPath('charge-1', 'payment-1')]: {
        paymentId: 'payment-1', paymentGroupId: 'group-1', userId: 'user-1',
        chargeUID: 'charge-1', clientId: 'client-1', condominiumId: 'condo-1', amountPaid: 100,
      },
    }, 'payment-1')).rejects.toMatchObject({
      response: { code: 'PAYMENT_GROUP_NOT_FOUND' },
    });
  });

  it('rejects a consolidated group that does not contain the selected payment', async () => {
    await expect(resolve({
      ...baseDocuments,
      [paymentPath('charge-1', 'payment-1')]: {
        paymentId: 'payment-1', paymentGroupId: 'group-1', userId: 'user-1',
        chargeUID: 'charge-1', clientId: 'client-1', condominiumId: 'condo-1', amountPaid: 100,
      },
      [`${condominiumPath}/paymentsToSendEmail/consolidated-1`]: {
        paymentId: 'consolidated-1', paymentGroupId: 'group-1', userId: 'user-1',
        payments: [{ paymentId: 'another-payment', userId: 'user-1', chargeUID: 'charge-1', amountPaid: 100 }],
      },
    }, 'payment-1')).rejects.toMatchObject({
      response: { code: 'PAYMENT_GROUP_MISMATCH' },
    });
  });

  it('selects the consolidated document containing the payment when group IDs repeat', async () => {
    const payment = {
      paymentId: 'payment-1', paymentGroupId: 'group-1', userId: 'user-1',
      chargeUID: 'charge-1', clientId: 'client-1', condominiumId: 'condo-1', amountPaid: 100,
    };
    const target = await resolve({
      ...baseDocuments,
      [paymentPath('charge-1', 'payment-1')]: payment,
      [`${condominiumPath}/paymentsToSendEmail/other-consolidated`]: {
        paymentId: 'other-consolidated', paymentGroupId: 'group-1', userId: 'user-1',
        payments: [{ ...payment, paymentId: 'other-payment' }],
      },
      [`${condominiumPath}/paymentsToSendEmail/consolidated-1`]: {
        paymentId: 'consolidated-1', paymentGroupId: 'group-1', userId: 'user-1',
        payments: [payment],
      },
    }, 'payment-1');

    expect(target.paymentId).toBe('consolidated-1');
  });

  it('resolves an older payment without a consolidated document', async () => {
    const target = await resolve({
      ...baseDocuments,
      [paymentPath('charge-1', 'legacy-1')]: {
        userId: 'user-1', clientId: 'client-1', condominiumId: 'condo-1', amountPaid: 75,
      },
    }, 'legacy-1');

    expect(target.source).toBe('payment_document');
    expect(target.amountPaid).toBe(75);
  });

  it('rejects a payment whose stored tenant does not match the requested tenant', async () => {
    await expect(resolve({
      ...baseDocuments,
      [paymentPath('charge-1', 'payment-1')]: {
        clientId: 'another-client', condominiumId: 'condo-1', amountPaid: 100,
      },
    }, 'payment-1')).rejects.toMatchObject({
      response: { code: 'FORBIDDEN_TENANT' },
    });
  });

  it('uses condominium membership when an admin token names another selected condominium', async () => {
    const service = Object.create(PaymentReversalsService.prototype) as PaymentReversalsService;
    (service as any).firestore = createFirestore({
      [condominiumPath]: {},
      [`${condominiumPath}/users/admin-1`]: { role: 'admin', active: true, name: 'Admin' },
    });

    await expect(service.assertTenantAdminAccess({
      clientId: 'client-1',
      condominiumId: 'condo-1',
      actor: {
        uid: 'admin-1', email: 'admin@example.com', role: 'admin',
        clientId: 'client-1', condominiumId: 'previous-condo',
      },
    })).resolves.toMatchObject({ name: 'Admin' });
  });

  it('denies an admin without membership in the selected condominium', async () => {
    const service = Object.create(PaymentReversalsService.prototype) as PaymentReversalsService;
    (service as any).firestore = createFirestore({ [condominiumPath]: {} });

    await expect(service.assertTenantAdminAccess({
      clientId: 'client-1',
      condominiumId: 'condo-1',
      actor: {
        uid: 'admin-1', email: 'admin@example.com', role: 'admin',
        clientId: 'client-1', condominiumId: 'previous-condo',
      },
    })).rejects.toMatchObject({ response: { code: 'FORBIDDEN_TENANT' } });
  });
});
