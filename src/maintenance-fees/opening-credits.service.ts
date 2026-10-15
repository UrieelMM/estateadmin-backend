import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { FinancialAdminActor } from './financial-admin-auth';
import { OpeningCreditCancelDto, OpeningCreditCreateDto } from 'src/dtos/opening-credits.dto';

const NON_UNIT_ROLES = [
  'admin',
  'admin-assistant',
  'super-admin',
  'super-provider-admin',
  'security',
  'maintenance',
];

/**
 * Saldo a favor inicial de un departamento al migrar al sistema.
 * Solo incrementa `users/{id}.totalCreditBalance` (centavos): no genera un ingreso ni
 * modifica cuentas financieras, porque ese dinero ya forma parte del saldo inicial en bancos.
 */
@Injectable()
export class OpeningCreditsService {
  private readonly logger = new Logger(OpeningCreditsService.name);
  private readonly firestore = admin.firestore();
  private readonly listHardLimit = 2000;

  async list(clientId: string, condominiumId: string) {
    const snapshot = await this.getCondominiumRef(clientId, condominiumId)
      .collection('openingCredits')
      .orderBy('createdAt', 'desc')
      .limit(this.listHardLimit)
      .get();
    return { ok: true, data: { items: snapshot.docs.map((doc) => this.toPublic(doc)) } };
  }

  async create(dto: OpeningCreditCreateDto, actor: FinancialAdminActor) {
    const amountCents = Math.round(dto.amount * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      this.throwApiError(HttpStatus.BAD_REQUEST, 'INVALID_AMOUNT', 'Captura un monto mayor a cero.');
    }

    const condominiumRef = this.getCondominiumRef(dto.clientId, dto.condominiumId);
    const userRef = condominiumRef.collection('users').doc(dto.userId);
    const creditsRef = condominiumRef.collection('openingCredits');
    const creditRef = creditsRef.doc();
    const auditRef = condominiumRef.collection('auditLogs').doc();

    const created = await this.firestore.runTransaction(async (transaction) => {
      const [userSnap, activeSnap] = await Promise.all([
        transaction.get(userRef),
        transaction.get(
          creditsRef.where('userId', '==', dto.userId).where('status', '==', 'active').limit(1),
        ),
      ]);
      const user = userSnap.data() || {};
      if (!userSnap.exists || NON_UNIT_ROLES.includes(String(user.role || ''))) {
        this.throwApiError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'No se encontró el condómino seleccionado.');
      }
      if (!activeSnap.empty) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'OPENING_CREDIT_EXISTS',
          'Este departamento ya tiene un saldo a favor inicial registrado. Cancélalo primero si necesitas corregirlo.',
        );
      }

      const balanceBeforeCents = this.toCents(user.totalCreditBalance);
      const balanceAfterCents = balanceBeforeCents + amountCents;
      const nowTs = admin.firestore.Timestamp.now();
      const record = {
        userId: dto.userId,
        userName: [user.name, user.lastName].filter(Boolean).join(' ').trim(),
        numberCondominium: String(user.number || ''),
        tower: String(user.tower || ''),
        amountCents,
        remainingCents: amountCents,
        cutoffDate: dto.cutoffDate || null,
        notes: dto.notes || '',
        status: 'active',
        countsAsIncome: false,
        creditBalanceBeforeCents: balanceBeforeCents,
        creditBalanceAfterCents: balanceAfterCents,
        createdAt: nowTs,
        createdBy: { uid: actor.uid, email: actor.email, name: actor.name },
      };

      transaction.update(userRef, {
        totalCreditBalance: balanceAfterCents,
        updatedAt: nowTs,
        updatedBy: actor.uid,
      });
      transaction.set(creditRef, record);
      transaction.set(auditRef, {
        type: 'finance.opening_credit_created',
        module: 'Ingresos',
        entityType: 'opening_credit',
        entityId: creditRef.id,
        action: 'create',
        summary: `Saldo a favor inicial de ${record.numberCondominium || dto.userId}`,
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorName: actor.name,
        clientId: dto.clientId,
        condominiumId: dto.condominiumId,
        before: { totalCreditBalance: balanceBeforeCents },
        after: { totalCreditBalance: balanceAfterCents, amountCents },
        createdAt: nowTs,
      });
      return record;
    });

    this.logger.log(
      `[opening-credit-create] actor=${actor.uid} userId=${dto.userId} amount=${amountCents} id=${creditRef.id}`,
    );
    return {
      ok: true,
      data: {
        id: creditRef.id,
        ...this.serialize(created),
        totalCreditBalanceCents: created.creditBalanceAfterCents,
      },
    };
  }

  async cancel(id: string, dto: OpeningCreditCancelDto, actor: FinancialAdminActor) {
    const condominiumRef = this.getCondominiumRef(dto.clientId, dto.condominiumId);
    const creditRef = condominiumRef.collection('openingCredits').doc(id);
    const auditRef = condominiumRef.collection('auditLogs').doc();

    const result = await this.firestore.runTransaction(async (transaction) => {
      const creditSnap = await transaction.get(creditRef);
      const credit = creditSnap.data() || {};
      if (!creditSnap.exists) {
        this.throwApiError(HttpStatus.NOT_FOUND, 'OPENING_CREDIT_NOT_FOUND', 'No se encontró el saldo a favor inicial.');
      }
      if (credit.status !== 'active') {
        this.throwApiError(HttpStatus.CONFLICT, 'OPENING_CREDIT_NOT_ACTIVE', 'Este saldo a favor inicial ya fue cancelado.');
      }

      const userRef = condominiumRef.collection('users').doc(String(credit.userId));
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) {
        this.throwApiError(HttpStatus.NOT_FOUND, 'USER_NOT_FOUND', 'El condómino ya no existe en el condominio.');
      }
      const amountCents = this.toCents(credit.amountCents);
      const remainingCents =
        credit.remainingCents === undefined ? amountCents : this.toCents(credit.remainingCents);
      const balanceBeforeCents = this.toCents(userSnap.data()?.totalCreditBalance);
      if (remainingCents < amountCents) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'OPENING_CREDIT_USED',
          `Este saldo a favor inicial ya se aplicó a cargos (sin usar: $${(remainingCents / 100).toFixed(2)}). Revierte primero los pagos que lo usaron.`,
        );
      }
      if (balanceBeforeCents < amountCents) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'OPENING_CREDIT_USED',
          `El saldo a favor ya se aplicó a cargos (disponible: $${(balanceBeforeCents / 100).toFixed(2)}). Revierte primero los pagos que lo usaron.`,
        );
      }

      const balanceAfterCents = balanceBeforeCents - amountCents;
      const nowTs = admin.firestore.Timestamp.now();
      transaction.update(userRef, {
        totalCreditBalance: balanceAfterCents,
        updatedAt: nowTs,
        updatedBy: actor.uid,
      });
      transaction.update(creditRef, {
        status: 'cancelled',
        cancelReason: dto.reason,
        cancelledAt: nowTs,
        cancelledBy: { uid: actor.uid, email: actor.email, name: actor.name },
      });
      transaction.set(auditRef, {
        type: 'finance.opening_credit_cancelled',
        module: 'Ingresos',
        entityType: 'opening_credit',
        entityId: id,
        action: 'other',
        summary: `Cancelación de saldo a favor inicial de ${credit.numberCondominium || credit.userId}`,
        reason: dto.reason,
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorName: actor.name,
        clientId: dto.clientId,
        condominiumId: dto.condominiumId,
        before: { totalCreditBalance: balanceBeforeCents },
        after: { totalCreditBalance: balanceAfterCents },
        createdAt: nowTs,
      });
      return { userId: String(credit.userId), totalCreditBalanceCents: balanceAfterCents };
    });

    this.logger.log(`[opening-credit-cancel] actor=${actor.uid} id=${id}`);
    return { ok: true, data: { id, status: 'cancelled', ...result } };
  }

  private toPublic(doc: FirebaseFirestore.QueryDocumentSnapshot) {
    return { id: doc.id, ...this.serialize(doc.data()) };
  }

  private serialize(data: FirebaseFirestore.DocumentData) {
    return {
      userId: data.userId || '',
      userName: data.userName || '',
      numberCondominium: data.numberCondominium || '',
      tower: data.tower || '',
      amount: this.toCents(data.amountCents) / 100,
      remaining:
        (data.remainingCents === undefined
          ? this.toCents(data.amountCents)
          : this.toCents(data.remainingCents)) / 100,
      cutoffDate: data.cutoffDate || null,
      notes: data.notes || '',
      status: data.status || 'active',
      cancelReason: data.cancelReason || '',
      createdByName: data.createdBy?.name || data.createdBy?.email || '',
      createdAt: data.createdAt?.toDate?.().toISOString() || null,
      cancelledAt: data.cancelledAt?.toDate?.().toISOString() || null,
    };
  }

  private toCents(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }

  private getCondominiumRef(clientId: string, condominiumId: string) {
    return this.firestore
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId);
  }

  private throwApiError(status: number, code: string, message: string): never {
    throw new HttpException({ ok: false, message, code, details: {} }, status);
  }
}
