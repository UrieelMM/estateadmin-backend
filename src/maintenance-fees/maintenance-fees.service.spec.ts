import * as admin from 'firebase-admin';
jest.mock('src/firebasesdk/firebasesdk-service', () => ({ FirebaseAuthService: class {} }), { virtual: true });
import { MaintenanceFeesService } from './maintenance-fees.service';

describe('MaintenanceFeesService linked unidentified payment', () => {
  afterEach(() => jest.restoreAllMocks());

  const setup = (status: 'open' | 'closed') => {
    const source = { paymentDate: new Date('2026-02-10T12:00:00Z'), amountPaid: 12500, financialAccountId: 'bank-1', appliedToUser: false };
    const sourceRef = { get: jest.fn(async () => ({ exists: true, data: () => source })) };
    const db = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ doc: () => sourceRef }) }) }) }) }) };
    jest.spyOn(admin, 'firestore').mockReturnValue(db as any);
    const firebase = {
      createMaintenanceFee: jest.fn(async () => ({ paymentId: 'identified-1' })),
      editUnidentifiedPayment: jest.fn(async () => ({ updated: true })),
    };
    const closures = {
      monthForDate: (date: string) => date.slice(0, 7),
      withOpenMonth: jest.fn(async (_clientId: string, _condominiumId: string, _date: string, action: () => Promise<any>) => {
        if (status === 'closed') throw new Error('El mes está cerrado.');
        return action();
      }),
    };
    const service = new MaintenanceFeesService(firebase as any, closures as any);
    const dto: any = { clientId: 'client-1', condominiumId: 'condo-1', paymentDate: '2026-02-10', amountPaid: '12500', financialAccountId: 'bank-1', userId: 'user-1', sourceUnidentifiedPaymentId: 'source-1' };
    return { service, firebase, closures, dto };
  };

  it('keeps application and source update inside the same open-month guard', async () => {
    const { service, firebase, closures, dto } = setup('open');
    await service.createMaintenanceFee(dto, []);
    expect(closures.withOpenMonth).toHaveBeenCalledTimes(1);
    expect(firebase.createMaintenanceFee).toHaveBeenCalledTimes(1);
    expect(firebase.editUnidentifiedPayment).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'source-1', userId: 'user-1' }));
    expect(firebase.createMaintenanceFee.mock.invocationCallOrder[0]).toBeLessThan(firebase.editUnidentifiedPayment.mock.invocationCallOrder[0]);
  });

  it('does not apply or change the source payment after the month closes', async () => {
    const { service, firebase, dto } = setup('closed');
    await expect(service.createMaintenanceFee(dto, [])).rejects.toThrow('cerrado');
    expect(firebase.createMaintenanceFee).not.toHaveBeenCalled();
    expect(firebase.editUnidentifiedPayment).not.toHaveBeenCalled();
  });
});
