import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  PaymentReversalCommitDto,
  PaymentReversalHistoryQueryDto,
  PaymentReversalPreviewDto,
} from 'src/dtos/payment-reversals.dto';

type ReversalActor = {
  uid: string;
  email: string;
  role: string;
  clientId: string;
  condominiumId?: string;
  name?: string;
};

type ReversalTargetType = 'identified' | 'unidentified';

type ReversalEffects = {
  chargeRestored: boolean;
  creditAdjusted: boolean;
  financialAccountAdjusted: boolean;
  receiptInvalidated: boolean;
};

type PaymentComponentSnapshot = {
  paymentId: string;
  userId: string;
  chargeId: string;
  paymentDocPath: string;
  amountPaid: number;
  concept?: string;
  numberCondominium?: string;
  towerSnapshot?: string;
};

type ReversalImpactSummary = {
  chargeRestoreAmount: number;
  creditDelta: number;
  accountBalanceDelta: number;
  willInvalidateReceipt: boolean;
};

type StoredReversalOperation = {
  operationId: string;
  status: 'previewed' | 'committed' | 'expired' | 'cancelled';
  clientId: string;
  condominiumId: string;
  paymentId: string;
  reason: string;
  notes?: string;
  payment: {
    paymentId: string;
    folio: string;
    amountPaid: number;
    numberCondominium?: string;
    towerSnapshot?: string;
    paymentGroupId?: string;
    financialAccountId?: string;
  };
  impactSummary: ReversalImpactSummary;
  target: {
    type: ReversalTargetType;
    source: string;
    paymentGroupId?: string;
    userId?: string;
    financialAccountId?: string;
    creditUsed: number;
    creditBalance: number;
    receiptUrl?: string;
    consolidatedDocPath?: string;
    unidentifiedDocPath?: string;
    components: PaymentComponentSnapshot[];
  };
  createdBy: {
    uid: string;
    email: string;
    role: string;
    name?: string;
  };
  createdAt: admin.firestore.Timestamp;
  expiresAt: admin.firestore.Timestamp;
  committedAt?: admin.firestore.Timestamp;
  reversalId?: string;
  commitSummary?: Record<string, unknown>;
};

type ResolvedPaymentTarget = {
  type: ReversalTargetType;
  source: string;
  paymentId: string;
  folio: string;
  paymentGroupId?: string;
  numberCondominium?: string;
  towerSnapshot?: string;
  amountPaid: number;
  userId?: string;
  financialAccountId?: string;
  creditUsed: number;
  creditBalance: number;
  receiptUrl?: string;
  consolidatedDocPath?: string;
  unidentifiedDocPath?: string;
  components: PaymentComponentSnapshot[];
};

@Injectable()
export class PaymentReversalsService {
  private readonly logger = new Logger(PaymentReversalsService.name);
  private readonly firestore = admin.firestore();
  private readonly previewTtlMs = 15 * 60 * 1000;
  private readonly maxComponentsPerOperation = 250;
  private readonly historyHardLimit = 5000;

  async assertTenantAdminAccess(params: {
    clientId: string;
    condominiumId: string;
    actor: ReversalActor;
  }): Promise<ReversalActor> {
    const clientId = this.normalizeString(params.clientId);
    const condominiumId = this.normalizeString(params.condominiumId);
    const role = this.normalizeString(params.actor.role);
    const actorClientId = this.normalizeString(params.actor.clientId);
    const actorCondominiumId = this.normalizeString(params.actor.condominiumId);

    if (role !== 'admin') {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_ROLE',
        'Solo admin puede revertir pagos',
      );
    }

    if (!actorClientId || actorClientId !== clientId) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_TENANT',
        'El clientId del token no coincide con el solicitado.',
      );
    }

    if (actorCondominiumId && actorCondominiumId !== condominiumId) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_TENANT',
        'El condominio solicitado no pertenece al contexto del admin.',
      );
    }

    const condominiumRef = this.getCondominiumRef(clientId, condominiumId);
    const condominiumDoc = await condominiumRef.get();

    if (!condominiumDoc.exists) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'CONDOMINIUM_NOT_FOUND',
        'No se encontró el condominio solicitado para el clientId enviado.',
      );
    }

    const adminDoc = await condominiumRef
      .collection('users')
      .doc(params.actor.uid)
      .get();

    if (!adminDoc.exists) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_TENANT',
        'El admin autenticado no pertenece al condominio solicitado.',
      );
    }

    const adminData = adminDoc.data() || {};
    const adminRole = this.normalizeString(adminData.role);
    if (adminRole !== 'admin') {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_ROLE',
        'Solo admin puede revertir pagos',
      );
    }

    if (adminData.active === false) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_ROLE',
        'El usuario administrador está desactivado.',
      );
    }

    const resolvedName = this.normalizeString(adminData.name);
    const resolvedLastName = this.normalizeString(adminData.lastName);

    return {
      ...params.actor,
      role: 'admin',
      name: [resolvedName, resolvedLastName].filter(Boolean).join(' ').trim(),
    };
  }

  async previewReversal(dto: PaymentReversalPreviewDto, actor: ReversalActor) {
    const clientId = this.normalizeString(dto.clientId);
    const condominiumId = this.normalizeString(dto.condominiumId);
    const paymentId = this.normalizeString(dto.paymentId);
    const reason = this.resolveReason(dto.reason, dto.notes);
    const notes = this.normalizeOptionalString(dto.notes);

    this.logger.log(
      `[reversal-preview] actor=${actor.uid} clientId=${clientId} condominiumId=${condominiumId} paymentId=${paymentId}`,
    );

    const resolvedPayment = await this.resolvePaymentTarget({
      clientId,
      condominiumId,
      paymentId,
    });

    const impactSummary: ReversalImpactSummary = {
      chargeRestoreAmount: this.roundAmount(resolvedPayment.amountPaid),
      creditDelta: this.roundAmount(
        resolvedPayment.creditUsed - resolvedPayment.creditBalance,
      ),
      accountBalanceDelta: this.roundAmount(-resolvedPayment.amountPaid),
      willInvalidateReceipt: !!resolvedPayment.receiptUrl,
    };

    const now = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(
      now.toMillis() + this.previewTtlMs,
    );
    const operationId = this.resolveOperationId(dto.operationId);
    const operationRef = this.getCondominiumRef(clientId, condominiumId)
      .collection('paymentReversalOperations')
      .doc(operationId);

    await this.firestore.runTransaction(async (transaction) => {
      const existingOperation = await transaction.get(operationRef);
      if (existingOperation.exists) {
        const existingData = existingOperation.data() || {};
        const existingExpiresAt = existingData.expiresAt as
          | admin.firestore.Timestamp
          | undefined;
        if (existingExpiresAt && existingExpiresAt.toMillis() > Date.now()) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'OPERATION_ID_IN_USE',
            'El operationId enviado ya existe y sigue vigente.',
          );
        }
      }

      const operationPayload: StoredReversalOperation = {
        operationId,
        status: 'previewed',
        clientId,
        condominiumId,
        paymentId: resolvedPayment.paymentId,
        reason,
        notes,
        payment: {
          paymentId: resolvedPayment.paymentId,
          folio: resolvedPayment.folio,
          amountPaid: resolvedPayment.amountPaid,
          numberCondominium: resolvedPayment.numberCondominium,
          towerSnapshot: resolvedPayment.towerSnapshot,
          paymentGroupId: resolvedPayment.paymentGroupId,
          financialAccountId: resolvedPayment.financialAccountId,
        },
        impactSummary,
        target: {
          type: resolvedPayment.type,
          source: resolvedPayment.source,
          paymentGroupId: resolvedPayment.paymentGroupId,
          userId: resolvedPayment.userId,
          financialAccountId: resolvedPayment.financialAccountId,
          creditUsed: resolvedPayment.creditUsed,
          creditBalance: resolvedPayment.creditBalance,
          receiptUrl: resolvedPayment.receiptUrl,
          consolidatedDocPath: resolvedPayment.consolidatedDocPath,
          unidentifiedDocPath: resolvedPayment.unidentifiedDocPath,
          components: resolvedPayment.components,
        },
        createdBy: {
          uid: actor.uid,
          email: actor.email || '',
          role: actor.role,
          name: actor.name,
        },
        createdAt: now,
        expiresAt,
      };

      transaction.set(operationRef, operationPayload, { merge: true });
    });

    this.logger.log(
      `[reversal-preview] operationId=${operationId} paymentId=${resolvedPayment.paymentId} type=${resolvedPayment.type} amount=${resolvedPayment.amountPaid}`,
    );

    return {
      ok: true,
      data: {
        operationId,
        reversible: true,
        message: 'Pago elegible para eliminar',
        expiresAt: expiresAt.toDate().toISOString(),
        payment: {
          paymentId: resolvedPayment.paymentId,
          folio: resolvedPayment.folio,
          amountPaid: resolvedPayment.amountPaid,
          numberCondominium: resolvedPayment.numberCondominium || '',
          towerSnapshot: resolvedPayment.towerSnapshot || '',
        },
        impactSummary,
      },
    };
  }

  async commitReversal(params: {
    dto: PaymentReversalCommitDto;
    actor: ReversalActor;
    idempotencyKey: string;
    sourceIp?: string;
  }) {
    const clientId = this.normalizeString(params.dto.clientId);
    const condominiumId = this.normalizeString(params.dto.condominiumId);
    const paymentId = this.normalizeString(params.dto.paymentId);
    const operationId = this.normalizeString(params.dto.operationId);
    const requestedReason = this.normalizeOptionalString(params.dto.reason);
    const notes = this.normalizeOptionalString(params.dto.notes);
    const idempotencyKey = this.normalizeString(params.idempotencyKey);

    if (!idempotencyKey) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Header X-Idempotency-Key es obligatorio.',
      );
    }

    const keyHash = this.hashIdempotencyKey(idempotencyKey);
    const condominiumRef = this.getCondominiumRef(clientId, condominiumId);
    const operationRef = condominiumRef
      .collection('paymentReversalOperations')
      .doc(operationId);
    const idempotencyRef = condominiumRef
      .collection('paymentReversalIdempotency')
      .doc(keyHash);
    const reversalsRef = condominiumRef.collection('paymentReversals');
    const auditLogsRef = condominiumRef.collection('auditLogs');

    this.logger.log(
      `[reversal-commit] actor=${params.actor.uid} operationId=${operationId} paymentId=${paymentId} tenant=${clientId}/${condominiumId}`,
    );

    const transactionResult = await this.firestore.runTransaction(
      async (transaction) => {
        const [operationSnap, idempotencySnap] = await Promise.all([
          transaction.get(operationRef),
          transaction.get(idempotencyRef),
        ]);

        if (idempotencySnap.exists) {
          const idempotencyData = idempotencySnap.data() || {};
          if (idempotencyData.status === 'applied' && idempotencyData.response) {
            return {
              reused: true,
              response: idempotencyData.response,
            };
          }

          this.throwApiError(
            HttpStatus.CONFLICT,
            'IDEMPOTENCY_CONFLICT',
            'La operación ya fue ejecutada o está en proceso para esta llave de idempotencia.',
          );
        }

        if (!operationSnap.exists) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'OPERATION_NOT_FOUND',
            'No existe un preview vigente para el operationId enviado.',
          );
        }

        const operation = operationSnap.data() as StoredReversalOperation;

        if (
          this.normalizeString(operation.clientId) !== clientId ||
          this.normalizeString(operation.condominiumId) !== condominiumId
        ) {
          this.throwApiError(
            HttpStatus.FORBIDDEN,
            'FORBIDDEN_TENANT',
            'La operación no pertenece al tenant solicitado.',
          );
        }

        const allowedPaymentIds = this.getAllowedPaymentIdsFromOperation(operation);
        const normalizedRequestPaymentId = this.normalizeString(paymentId);
        if (!allowedPaymentIds.has(normalizedRequestPaymentId)) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'PAYMENT_MISMATCH',
            'El paymentId no coincide con el snapshot validado en preview.',
            {
              operationPaymentId:
                this.normalizeString(operation.paymentId) ||
                this.normalizeString(operation.payment?.paymentId) ||
                '',
              allowedPaymentIds: Array.from(allowedPaymentIds).slice(0, 20),
            },
          );
        }

        const canonicalPaymentId = this.resolveCanonicalPaymentId(
          operation,
          normalizedRequestPaymentId,
        );

        if (
          operation.createdBy?.uid &&
          this.normalizeString(operation.createdBy.uid) !==
            this.normalizeString(params.actor.uid)
        ) {
          this.throwApiError(
            HttpStatus.FORBIDDEN,
            'FORBIDDEN_OPERATION_OWNER',
            'Solo el admin que generó el preview puede confirmar esta reversa.',
          );
        }

        if (operation.status === 'committed' && operation.commitSummary) {
          transaction.set(
            idempotencyRef,
            {
              operationId,
              paymentId: canonicalPaymentId,
              requestedPaymentId: normalizedRequestPaymentId,
              status: 'applied',
              keyHash,
              response: operation.commitSummary,
              updatedAt: admin.firestore.Timestamp.now(),
            },
            { merge: true },
          );

          return {
            reused: true,
            response: operation.commitSummary,
          };
        }

        if (operation.status !== 'previewed') {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'OPERATION_INVALID_STATE',
            'La operación no está en estado previewed.',
          );
        }

        const nowDate = Date.now();
        if (!operation.expiresAt || operation.expiresAt.toMillis() < nowDate) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'OPERATION_EXPIRED',
            'El preview de reversa expiró; genera uno nuevo.',
          );
        }

        const reason = this.resolveReason(
          requestedReason,
          notes,
          this.normalizeString(operation.reason),
        );

        const reversalDocRef = reversalsRef.doc();
        const auditDocRef = auditLogsRef.doc();
        const reversalId = reversalDocRef.id;
        const nowTs = admin.firestore.Timestamp.now();

        const effects: ReversalEffects = {
          chargeRestored: false,
          creditAdjusted: false,
          financialAccountAdjusted: false,
          receiptInvalidated: false,
        };

        let paymentFolio = this.normalizeString(operation.payment?.folio);

        if (operation.target?.type === 'identified') {
          const identifiedResult = await this.applyIdentifiedReversal({
            transaction,
            condominiumRef,
            operation,
            reversalId,
            reason,
            notes,
            actorUid: params.actor.uid,
            nowTs,
            effects,
          });

          if (!paymentFolio) {
            paymentFolio = identifiedResult.paymentFolio;
          }
        } else if (operation.target?.type === 'unidentified') {
          const unidentifiedResult = await this.applyUnidentifiedReversal({
            transaction,
            condominiumRef,
            operation,
            reversalId,
            reason,
            notes,
            actorUid: params.actor.uid,
            nowTs,
            effects,
          });

          if (!paymentFolio) {
            paymentFolio = unidentifiedResult.paymentFolio;
          }
        } else {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'UNSUPPORTED_TARGET',
            'El tipo de pago del snapshot no es soportado para reversa.',
          );
        }

        const performedByName =
          params.actor.name ||
          this.normalizeString(operation.createdBy?.name) ||
          this.normalizeString(params.actor.email);

        const commitSummary = {
          operationId,
          reversalId,
          status: 'applied',
          message: 'Reversa aplicada correctamente',
          paymentId: canonicalPaymentId,
          requestedPaymentId: normalizedRequestPaymentId,
          paymentFolio: paymentFolio || '',
          performedAt: nowTs.toDate().toISOString(),
          auditLogId: auditDocRef.id,
          effects,
        };

        transaction.set(reversalDocRef, {
          operationId,
          paymentId: canonicalPaymentId,
          requestedPaymentId: normalizedRequestPaymentId,
          paymentFolio: paymentFolio || '',
          reason,
          notes: notes || null,
          status: 'applied',
          clientId,
          condominiumId,
          performedAt: nowTs,
          performedByName: performedByName || '',
          performedBy: {
            uid: params.actor.uid,
            email: params.actor.email || '',
            role: params.actor.role,
          },
          sourceIp: params.sourceIp || '',
          effects,
          impactSummary: operation.impactSummary || {},
          payment: operation.payment || {},
          operationSnapshotRef: operationRef.path,
          idempotencyKeyHash: keyHash,
          createdAt: nowTs,
        });

        transaction.set(auditDocRef, {
          type: 'finance.payment_reversed',
          operationId,
          reversalId,
          paymentId: canonicalPaymentId,
          requestedPaymentId: normalizedRequestPaymentId,
          paymentFolio: paymentFolio || '',
          reason,
          notes: notes || null,
          actorUid: params.actor.uid,
          actorEmail: params.actor.email || '',
          actorRole: params.actor.role,
          actorName: performedByName || '',
          clientId,
          condominiumId,
          sourceIp: params.sourceIp || '',
          createdAt: nowTs,
          meta: {
            effects,
            idempotencyKeyHash: keyHash,
          },
        });

        transaction.update(operationRef, {
          status: 'committed',
          committedAt: nowTs,
          reversalId,
          reason,
          notes: notes || null,
          commitSummary,
          updatedAt: nowTs,
        });

        transaction.set(
          idempotencyRef,
          {
            operationId,
            paymentId: canonicalPaymentId,
            requestedPaymentId: normalizedRequestPaymentId,
            status: 'applied',
            keyHash,
            reversalId,
            response: commitSummary,
            updatedAt: nowTs,
          },
          { merge: true },
        );

        return {
          reused: false,
          response: commitSummary,
        };
      },
    );

    this.logger.log(
      `[reversal-commit] operationId=${operationId} paymentId=${paymentId} reused=${transactionResult.reused}`,
    );

    return {
      ok: true,
      data: transactionResult.response,
    };
  }

  async getReversalHistory(
    query: PaymentReversalHistoryQueryDto,
    _actor: ReversalActor,
  ) {
    const clientId = this.normalizeString(query.clientId);
    const condominiumId = this.normalizeString(query.condominiumId);
    const page = query.page || 1;
    const limit = query.limit || 10;
    const paymentIdFilter = this.normalizeOptionalString(query.paymentId);
    const fromDate = this.parseDateBoundary(query.from, false);
    const toDate = this.parseDateBoundary(query.to, true);

    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_DATE_RANGE',
        'El parámetro from no puede ser mayor que to.',
      );
    }

    const reversalsSnapshot = await this.getCondominiumRef(
      clientId,
      condominiumId,
    )
      .collection('paymentReversals')
      .orderBy('performedAt', 'desc')
      .limit(this.historyHardLimit)
      .get();

    const filteredDocs = reversalsSnapshot.docs.filter((doc) => {
      const data = doc.data() || {};
      const performedAt = data.performedAt as admin.firestore.Timestamp | undefined;
      if (!performedAt) {
        return false;
      }

      const performedAtMs = performedAt.toMillis();
      if (fromDate && performedAtMs < fromDate.getTime()) {
        return false;
      }
      if (toDate && performedAtMs > toDate.getTime()) {
        return false;
      }

      if (paymentIdFilter) {
        return (
          this.normalizeString(data.paymentId) === this.normalizeString(paymentIdFilter)
        );
      }

      return true;
    });

    const total = filteredDocs.length;
    const startIndex = (page - 1) * limit;
    const paginated = filteredDocs.slice(startIndex, startIndex + limit);

    this.logger.log(
      `[reversal-history] clientId=${clientId} condominiumId=${condominiumId} total=${total} page=${page} limit=${limit}`,
    );

    return {
      ok: true,
      data: {
        items: paginated.map((doc) => {
          const data = doc.data() || {};
          const performedAt = data.performedAt as admin.firestore.Timestamp | undefined;
          return {
            id: doc.id,
            operationId: data.operationId || '',
            paymentId: data.paymentId || '',
            paymentFolio: data.paymentFolio || '',
            reason: data.reason || '',
            status: data.status || 'applied',
            performedByName: data.performedByName || '',
            performedBy: {
              uid: data.performedBy?.uid || '',
              email: data.performedBy?.email || '',
              role: data.performedBy?.role || '',
            },
            performedAt: performedAt
              ? performedAt.toDate().toISOString()
              : null,
            notes: data.notes || '',
          };
        }),
        total,
        page,
        limit,
      },
    };
  }

  private async resolvePaymentTarget(params: {
    clientId: string;
    condominiumId: string;
    paymentId: string;
  }): Promise<ResolvedPaymentTarget> {
    const identified = await this.tryResolveIdentifiedPayment(params);
    if (identified) {
      return identified;
    }

    const unidentified = await this.tryResolveUnidentifiedPayment(params);
    if (unidentified) {
      return unidentified;
    }

    this.throwApiError(
      HttpStatus.NOT_FOUND,
      'PAYMENT_NOT_FOUND',
      'No se encontró un pago activo con el paymentId enviado.',
    );
  }

  private async tryResolveUnidentifiedPayment(params: {
    clientId: string;
    condominiumId: string;
    paymentId: string;
  }): Promise<ResolvedPaymentTarget | null> {
    const docRef = this.getCondominiumRef(
      params.clientId,
      params.condominiumId,
    )
      .collection('unidentifiedPayments')
      .doc(params.paymentId);

    const doc = await docRef.get();
    if (!doc.exists) {
      return null;
    }

    const data = doc.data() || {};
    if (this.isAlreadyReversed(data)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_NOT_REVERSIBLE',
        'El pago no identificado ya fue revertido.',
      );
    }

    if (data.appliedToUser === true) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_NOT_REVERSIBLE',
        'El pago no identificado ya fue aplicado y no es reversible desde este flujo.',
      );
    }

    const amountPaid = this.roundAmount(this.toNumber(data.amountPaid));
    if (amountPaid <= 0) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_NOT_REVERSIBLE',
        'El pago no identificado no tiene monto activo para revertir.',
      );
    }

    return {
      type: 'unidentified',
      source: 'unidentified_by_id',
      paymentId: this.normalizeString(data.paymentId) || doc.id,
      folio: this.normalizeString(data.folio),
      paymentGroupId: this.normalizeString(data.paymentGroupId),
      numberCondominium: this.normalizeString(data.numberCondominium),
      towerSnapshot: this.normalizeString(data.towerSnapshot),
      amountPaid,
      userId: this.normalizeString(data.userId),
      financialAccountId: this.normalizeString(data.financialAccountId),
      creditUsed: 0,
      creditBalance: 0,
      receiptUrl: this.normalizeString(data.receiptUrl),
      unidentifiedDocPath: doc.ref.path,
      components: [],
    };
  }

  private async tryResolveIdentifiedPayment(params: {
    clientId: string;
    condominiumId: string;
    paymentId: string;
  }): Promise<ResolvedPaymentTarget | null> {
    const condominiumRef = this.getCondominiumRef(
      params.clientId,
      params.condominiumId,
    );
    const paymentsToSendRef = condominiumRef.collection('paymentsToSendEmail');

    const consolidatedCandidate = await this.findConsolidatedCandidate({
      paymentsToSendRef,
      paymentId: params.paymentId,
    });

    if (consolidatedCandidate) {
      const target = this.buildTargetFromConsolidated({
        candidateDoc: consolidatedCandidate.doc,
        source: consolidatedCandidate.source,
        clientId: params.clientId,
        condominiumId: params.condominiumId,
      });

      await this.validateIdentifiedTarget(target, params.clientId, params.condominiumId);
      return target;
    }

    const consolidatedByNestedPayment = await this.findConsolidatedByNestedPaymentId(
      {
        paymentsToSendRef,
        paymentId: params.paymentId,
      },
    );

    if (!consolidatedByNestedPayment) {
      return null;
    }

    const target = this.buildTargetFromConsolidated({
      candidateDoc: consolidatedByNestedPayment.doc,
      source: consolidatedByNestedPayment.source,
      clientId: params.clientId,
      condominiumId: params.condominiumId,
    });

    await this.validateIdentifiedTarget(
      target,
      params.clientId,
      params.condominiumId,
    );

    return target;
  }

  private async validateIdentifiedTarget(
    target: ResolvedPaymentTarget,
    clientId: string,
    condominiumId: string,
  ) {
    if (!target.components.length) {
      this.throwApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'PAYMENT_INVALID',
        'No se encontraron componentes de pago para revertir.',
      );
    }

    if (target.components.length > this.maxComponentsPerOperation) {
      this.throwApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'PAYMENT_TOO_LARGE',
        `La reversa excede el máximo permitido (${this.maxComponentsPerOperation} componentes).`,
      );
    }

    for (const component of target.components) {
      if (
        !component.paymentDocPath ||
        !component.userId ||
        !component.chargeId ||
        !component.paymentId
      ) {
        this.throwApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'PAYMENT_INVALID',
          'Un componente del pago no tiene referencias válidas para reversa.',
        );
      }

      const paymentRef = this.firestore.doc(component.paymentDocPath);
      const paymentSnap = await paymentRef.get();
      if (!paymentSnap.exists) {
        this.throwApiError(
          HttpStatus.NOT_FOUND,
          'PAYMENT_NOT_FOUND',
          `No se encontró el pago asociado (${component.paymentId}) para reversa.`,
        );
      }

      const paymentData = paymentSnap.data() || {};
      if (this.isAlreadyReversed(paymentData)) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'PAYMENT_NOT_REVERSIBLE',
          `El pago ${component.paymentId} ya fue revertido.`,
        );
      }

      if (
        this.normalizeString(paymentData.clientId) !== clientId ||
        this.normalizeString(paymentData.condominiumId) !== condominiumId
      ) {
        this.throwApiError(
          HttpStatus.FORBIDDEN,
          'FORBIDDEN_TENANT',
          'Se detectó un pago fuera del tenant solicitado.',
        );
      }

      const chargeRef = this.getCondominiumRef(clientId, condominiumId)
        .collection('users')
        .doc(component.userId)
        .collection('charges')
        .doc(component.chargeId);

      const chargeSnap = await chargeRef.get();
      if (!chargeSnap.exists) {
        this.throwApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'CHARGE_NOT_FOUND',
          `No se encontró el cargo ${component.chargeId} para el pago ${component.paymentId}.`,
        );
      }
    }

    if (target.userId) {
      const userDoc = await this.getCondominiumRef(clientId, condominiumId)
        .collection('users')
        .doc(target.userId)
        .get();
      if (!userDoc.exists) {
        this.throwApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'USER_NOT_FOUND',
          'El usuario asociado al pago no existe en el condominio.',
        );
      }
    }
  }

  private async applyIdentifiedReversal(params: {
    transaction: FirebaseFirestore.Transaction;
    condominiumRef: FirebaseFirestore.DocumentReference;
    operation: StoredReversalOperation;
    reversalId: string;
    reason: string;
    notes?: string;
    actorUid: string;
    nowTs: admin.firestore.Timestamp;
    effects: ReversalEffects;
  }): Promise<{ paymentFolio: string }> {
    const components = Array.isArray(params.operation.target?.components)
      ? params.operation.target.components
      : [];

    if (!components.length) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_INVALID',
        'El snapshot de reversa no contiene componentes para aplicar.',
      );
    }

    const componentStates: Array<{
      paymentRef: FirebaseFirestore.DocumentReference;
      paymentData: FirebaseFirestore.DocumentData;
      chargeRef: FirebaseFirestore.DocumentReference;
      chargeData: FirebaseFirestore.DocumentData;
      restoredAmount: number;
    }> = [];

    for (const component of components) {
      const paymentRef = this.firestore.doc(component.paymentDocPath);
      const paymentSnap = await params.transaction.get(paymentRef);
      if (!paymentSnap.exists) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'PAYMENT_CHANGED',
          `El pago ${component.paymentId} ya no existe o cambió desde el preview.`,
        );
      }

      const paymentData = paymentSnap.data() || {};
      if (this.isAlreadyReversed(paymentData)) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'PAYMENT_NOT_REVERSIBLE',
          `El pago ${component.paymentId} ya fue revertido.`,
        );
      }

      const chargeRef = params.condominiumRef
        .collection('users')
        .doc(component.userId)
        .collection('charges')
        .doc(component.chargeId);
      const chargeSnap = await params.transaction.get(chargeRef);
      if (!chargeSnap.exists) {
        this.throwApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'CHARGE_NOT_FOUND',
          `No se encontró el cargo ${component.chargeId} al confirmar la reversa.`,
        );
      }

      const chargeData = chargeSnap.data() || {};
      const restoredAmount = this.roundAmount(
        this.toNumber(chargeData.amount) + this.toNumber(component.amountPaid),
      );

      componentStates.push({
        paymentRef,
        paymentData,
        chargeRef,
        chargeData,
        restoredAmount,
      });
    }

    const creditDelta = this.roundAmount(
      this.toNumber(params.operation.target?.creditUsed) -
        this.toNumber(params.operation.target?.creditBalance),
    );
    const targetUserId = this.normalizeString(params.operation.target?.userId);
    let userBalanceUpdate:
      | {
          userRef: FirebaseFirestore.DocumentReference;
          newCredit: number;
        }
      | undefined;

    if (targetUserId && creditDelta !== 0) {
      const userRef = params.condominiumRef.collection('users').doc(targetUserId);
      const userSnap = await params.transaction.get(userRef);
      if (!userSnap.exists) {
        this.throwApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'USER_NOT_FOUND',
          'El usuario asociado al pago no existe al confirmar la reversa.',
        );
      }

      const currentCredit = this.toNumber(userSnap.data()?.totalCreditBalance);
      const newCredit = this.roundAmount(currentCredit + creditDelta);
      if (newCredit < -0.01) {
        this.throwApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'BUSINESS_VALIDATION',
          'La reversa dejaría saldo a favor inconsistente en el condómino.',
          { currentCredit, creditDelta, newCredit },
        );
      }

      userBalanceUpdate = { userRef, newCredit };
    }

    const totalPaidAmount = this.roundAmount(
      components.reduce(
        (sum, component) => sum + this.toNumber(component.amountPaid),
        0,
      ),
    );
    const financialAccountAdjustment = await this.prepareFinancialAccountAdjustment(
      {
        transaction: params.transaction,
        condominiumRef: params.condominiumRef,
        financialAccountId: this.normalizeString(
          params.operation.target?.financialAccountId ||
            params.operation.payment?.financialAccountId,
        ),
        amountDelta: this.roundAmount(-Math.abs(totalPaidAmount)),
        actorUid: params.actorUid,
        nowTs: params.nowTs,
      },
    );

    const consolidatedDocPath = this.normalizeString(
      params.operation.target?.consolidatedDocPath,
    );
    let consolidatedArchivePlan:
      | {
          consolidatedRef: FirebaseFirestore.DocumentReference;
          consolidatedData: FirebaseFirestore.DocumentData;
          archiveRef: FirebaseFirestore.DocumentReference;
        }
      | undefined;

    if (consolidatedDocPath) {
      const consolidatedRef = this.firestore.doc(consolidatedDocPath);
      const consolidatedSnap = await params.transaction.get(consolidatedRef);
      if (consolidatedSnap.exists) {
        const consolidatedData = consolidatedSnap.data() || {};
        if (!this.isAlreadyReversed(consolidatedData)) {
          consolidatedArchivePlan = {
            consolidatedRef,
            consolidatedData,
            archiveRef: params.condominiumRef
              .collection('reversedPaymentsToSendEmail')
              .doc(consolidatedRef.id),
          };
        }
      }
    }

    for (const state of componentStates) {
      params.transaction.update(state.chargeRef, {
        amount: state.restoredAmount,
        paid: state.restoredAmount > 0 ? false : !!state.chargeData.paid,
        updatedAt: params.nowTs,
        updatedBy: params.actorUid,
      });

      const reversedPaymentRef = params.condominiumRef
        .collection('reversedPayments')
        .doc(state.paymentRef.id);

      params.transaction.set(reversedPaymentRef, {
        ...state.paymentData,
        isReversed: true,
        reversalStatus: 'reversed',
        reversalId: params.reversalId,
        reversalReason: params.reason,
        reversalNotes: params.notes || '',
        reversedAt: params.nowTs,
        reversedBy: params.actorUid,
        reversalOperationId: params.operation.operationId,
        archivedFrom: state.paymentRef.path,
      });

      params.transaction.delete(state.paymentRef);
    }
    params.effects.chargeRestored = componentStates.length > 0;
    params.effects.receiptInvalidated = componentStates.length > 0;

    if (userBalanceUpdate) {
      params.transaction.update(userBalanceUpdate.userRef, {
        totalCreditBalance: userBalanceUpdate.newCredit,
        updatedAt: params.nowTs,
        updatedBy: params.actorUid,
      });
      params.effects.creditAdjusted = true;
    }

    if (financialAccountAdjustment) {
      params.transaction.update(
        financialAccountAdjustment.accountRef,
        financialAccountAdjustment.updatePayload,
      );
      params.effects.financialAccountAdjusted = true;
    }

    if (consolidatedArchivePlan) {
      params.transaction.set(consolidatedArchivePlan.archiveRef, {
        ...consolidatedArchivePlan.consolidatedData,
        reversalId: params.reversalId,
        reversalReason: params.reason,
        reversalNotes: params.notes || '',
        reversedAt: params.nowTs,
        reversedBy: params.actorUid,
        reversalOperationId: params.operation.operationId,
        archivedFrom: consolidatedArchivePlan.consolidatedRef.path,
      });
      params.transaction.delete(consolidatedArchivePlan.consolidatedRef);

      params.effects.receiptInvalidated =
        params.effects.receiptInvalidated ||
        !!this.normalizeString(consolidatedArchivePlan.consolidatedData.receiptUrl);
    }

    return {
      paymentFolio: this.normalizeString(
        params.operation.payment?.folio ||
          params.operation.target?.components?.[0]?.paymentId,
      ),
    };
  }

  private async applyUnidentifiedReversal(params: {
    transaction: FirebaseFirestore.Transaction;
    condominiumRef: FirebaseFirestore.DocumentReference;
    operation: StoredReversalOperation;
    reversalId: string;
    reason: string;
    notes?: string;
    actorUid: string;
    nowTs: admin.firestore.Timestamp;
    effects: ReversalEffects;
  }): Promise<{ paymentFolio: string }> {
    const unidentifiedDocPath = this.normalizeString(
      params.operation.target?.unidentifiedDocPath,
    );
    if (!unidentifiedDocPath) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_INVALID',
        'El snapshot no incluye referencia al pago no identificado.',
      );
    }

    const unidentifiedRef = this.firestore.doc(unidentifiedDocPath);
    const unidentifiedSnap = await params.transaction.get(unidentifiedRef);
    if (!unidentifiedSnap.exists) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_CHANGED',
        'El pago no identificado ya no existe o cambió desde el preview.',
      );
    }

    const unidentifiedData = unidentifiedSnap.data() || {};
    if (this.isAlreadyReversed(unidentifiedData)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_NOT_REVERSIBLE',
        'El pago no identificado ya fue revertido.',
      );
    }

    const amountPaid = this.roundAmount(this.toNumber(unidentifiedData.amountPaid));
    if (amountPaid <= 0) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_NOT_REVERSIBLE',
        'El pago no identificado no tiene monto activo para reversa.',
      );
    }

    const financialAccountAdjustment = await this.prepareFinancialAccountAdjustment(
      {
        transaction: params.transaction,
        condominiumRef: params.condominiumRef,
        financialAccountId: this.normalizeString(
          params.operation.target?.financialAccountId ||
            params.operation.payment?.financialAccountId ||
            unidentifiedData.financialAccountId,
        ),
        amountDelta: this.roundAmount(-Math.abs(amountPaid)),
        actorUid: params.actorUid,
        nowTs: params.nowTs,
      },
    );

    const archiveRef = params.condominiumRef
      .collection('unidentifiedPaymentsReversed')
      .doc(unidentifiedRef.id);

    params.transaction.set(archiveRef, {
      ...unidentifiedData,
      reversalId: params.reversalId,
      reversalReason: params.reason,
      reversalNotes: params.notes || '',
      reversedAt: params.nowTs,
      reversedBy: params.actorUid,
      reversalOperationId: params.operation.operationId,
      archivedFrom: unidentifiedRef.path,
    });
    params.transaction.delete(unidentifiedRef);

    if (financialAccountAdjustment) {
      params.transaction.update(
        financialAccountAdjustment.accountRef,
        financialAccountAdjustment.updatePayload,
      );
      params.effects.financialAccountAdjusted = true;
    }

    return {
      paymentFolio:
        this.normalizeString(unidentifiedData.folio) ||
        this.normalizeString(params.operation.payment?.folio),
    };
  }

  private async prepareFinancialAccountAdjustment(params: {
    transaction: FirebaseFirestore.Transaction;
    condominiumRef: FirebaseFirestore.DocumentReference;
    financialAccountId?: string;
    amountDelta: number;
    actorUid: string;
    nowTs: admin.firestore.Timestamp;
  }): Promise<
    | {
        accountRef: FirebaseFirestore.DocumentReference;
        updatePayload: Record<string, unknown>;
      }
    | undefined
  > {
    const financialAccountId = this.normalizeString(params.financialAccountId);
    if (!financialAccountId || params.amountDelta === 0) {
      return undefined;
    }

    const accountRef = params.condominiumRef
      .collection('financialAccounts')
      .doc(financialAccountId);
    const accountSnap = await params.transaction.get(accountRef);
    if (!accountSnap.exists) {
      return undefined;
    }

    const accountData = accountSnap.data() || {};
    const updatePayload: Record<string, unknown> = {
      updatedAt: params.nowTs,
      updatedBy: params.actorUid,
    };

    if (typeof accountData.currentBalance === 'number') {
      updatePayload.currentBalance = this.roundAmount(
        accountData.currentBalance + params.amountDelta,
      );
    } else if (typeof accountData.balance === 'number') {
      updatePayload.balance = this.roundAmount(
        accountData.balance + params.amountDelta,
      );
    } else if (typeof accountData.amount === 'number') {
      updatePayload.amount = this.roundAmount(
        accountData.amount + params.amountDelta,
      );
    } else {
      return undefined;
    }

    return {
      accountRef,
      updatePayload,
    };
  }

  private buildTargetFromConsolidated(params: {
    candidateDoc: FirebaseFirestore.DocumentSnapshot;
    source: string;
    clientId: string;
    condominiumId: string;
  }): ResolvedPaymentTarget {
    const data = params.candidateDoc.data() || {};

    if (this.isAlreadyReversed(data)) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_NOT_REVERSIBLE',
        'El pago consolidado ya fue revertido.',
      );
    }

    const rawComponents = Array.isArray(data.payments) && data.payments.length
      ? data.payments
      : [data];

    const components = rawComponents.map((row: any, index: number) => {
      const userId =
        this.normalizeString(row.userId) ||
        this.normalizeString(row.userUID) ||
        this.normalizeString(data.userId) ||
        this.normalizeString(data.userUID);
      const chargeId =
        this.normalizeString(row.chargeUID) ||
        this.normalizeString(data.chargeUID);
      const componentPaymentId =
        this.normalizeString(row.paymentId) ||
        (index === 0
          ? this.normalizeString(data.paymentId) || params.candidateDoc.id
          : '');

      const amountPaid = this.roundAmount(
        this.toNumber(row.amountPaid || row.paymentAmountReference),
      );

      const paymentDocPath =
        userId && chargeId && componentPaymentId
          ? this.getCondominiumRef(params.clientId, params.condominiumId)
              .collection('users')
              .doc(userId)
              .collection('charges')
              .doc(chargeId)
              .collection('payments')
              .doc(componentPaymentId).path
          : '';

      return {
        paymentId: componentPaymentId,
        userId,
        chargeId,
        paymentDocPath,
        amountPaid,
        concept:
          this.normalizeString(row.concept) || this.normalizeString(data.concept),
        numberCondominium:
          this.normalizeString(row.numberCondominium) ||
          this.normalizeString(data.numberCondominium),
        towerSnapshot:
          this.normalizeString(row.towerSnapshot) ||
          this.normalizeString(data.towerSnapshot),
      } as PaymentComponentSnapshot;
    });

    if (!components.length) {
      this.throwApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'PAYMENT_INVALID',
        'No hay componentes válidos en el pago consolidado.',
      );
    }

    const amountPaid = this.roundAmount(
      components.reduce((sum, component) => sum + this.toNumber(component.amountPaid), 0),
    );
    if (amountPaid <= 0) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PAYMENT_NOT_REVERSIBLE',
        'El pago consolidado no tiene monto activo para reversa.',
      );
    }

    const creditBalanceFromDoc = this.toNumber(data.creditBalance);
    const creditUsedFromDoc = this.toNumber(data.creditUsed);

    const targetUserId =
      this.normalizeString(data.userId) ||
      this.normalizeString(data.userUID) ||
      components[0].userId;

    return {
      type: 'identified',
      source: params.source,
      paymentId: this.normalizeString(data.paymentId) || params.candidateDoc.id,
      folio: this.normalizeString(data.folio),
      paymentGroupId:
        this.normalizeString(data.paymentGroupId) ||
        this.normalizeString(data.paymentId) ||
        params.candidateDoc.id,
      numberCondominium:
        this.normalizeString(data.numberCondominium) ||
        this.normalizeString(components[0].numberCondominium),
      towerSnapshot:
        this.normalizeString(data.towerSnapshot) ||
        this.normalizeString(components[0].towerSnapshot),
      amountPaid,
      userId: targetUserId,
      financialAccountId: this.normalizeString(data.financialAccountId),
      creditUsed: this.roundAmount(creditUsedFromDoc),
      creditBalance: this.roundAmount(creditBalanceFromDoc),
      receiptUrl: this.normalizeString(data.receiptUrl),
      consolidatedDocPath: params.candidateDoc.ref.path,
      components,
    };
  }

  private async findConsolidatedCandidate(params: {
    paymentsToSendRef: FirebaseFirestore.CollectionReference;
    paymentId: string;
  }): Promise<{ doc: FirebaseFirestore.DocumentSnapshot; source: string } | null> {
    const candidates = new Map<
      string,
      { doc: FirebaseFirestore.DocumentSnapshot; source: string }
    >();

    const byDocId = await params.paymentsToSendRef.doc(params.paymentId).get();
    if (byDocId.exists) {
      candidates.set(byDocId.ref.path, { doc: byDocId, source: 'consolidated_doc_id' });
    }

    const byPaymentId = await params.paymentsToSendRef
      .where('paymentId', '==', params.paymentId)
      .limit(5)
      .get();
    byPaymentId.docs.forEach((doc) => {
      candidates.set(doc.ref.path, { doc, source: 'consolidated_payment_id' });
    });

    const byPaymentGroup = await params.paymentsToSendRef
      .where('paymentGroupId', '==', params.paymentId)
      .limit(5)
      .get();
    byPaymentGroup.docs.forEach((doc) => {
      candidates.set(doc.ref.path, { doc, source: 'consolidated_payment_group_id' });
    });

    if (!candidates.size) {
      return null;
    }

    const list = Array.from(candidates.values());
    if (list.length === 1) {
      return list[0];
    }

    const strictMatches = list.filter(({ doc }) => {
      const data = doc.data() || {};
      return (
        doc.id === params.paymentId ||
        this.normalizeString(data.paymentId) === params.paymentId ||
        this.normalizeString(data.paymentGroupId) === params.paymentId
      );
    });

    if (strictMatches.length === 1) {
      return strictMatches[0];
    }

    const withChildren = list.filter(({ doc }) => {
      const data = doc.data() || {};
      return Array.isArray(data.payments) && data.payments.length > 0;
    });

    if (withChildren.length === 1) {
      return withChildren[0];
    }

    this.throwApiError(
      HttpStatus.CONFLICT,
      'AMBIGUOUS_PAYMENT',
      'Se encontraron múltiples pagos consolidados candidatos para el paymentId.',
    );
  }

  private async findConsolidatedByNestedPaymentId(params: {
    paymentsToSendRef: FirebaseFirestore.CollectionReference;
    paymentId: string;
  }): Promise<{ doc: FirebaseFirestore.DocumentSnapshot; source: string } | null> {
    const pageSize = 300;
    const maxDocsToScan = 3000;
    let scanned = 0;
    let query: FirebaseFirestore.Query = params.paymentsToSendRef.limit(pageSize);

    while (scanned < maxDocsToScan) {
      const pageSnapshot = await query.get();
      if (pageSnapshot.empty) {
        return null;
      }

      for (const doc of pageSnapshot.docs) {
        scanned += 1;
        const data = doc.data() || {};
        if (this.isAlreadyReversed(data)) {
          continue;
        }

        const nestedPayments = Array.isArray(data.payments) ? data.payments : [];
        const hasNestedPaymentId = nestedPayments.some(
          (row) => this.normalizeString(row?.paymentId) === params.paymentId,
        );

        if (hasNestedPaymentId) {
          return {
            doc,
            source: 'consolidated_nested_payment_id',
          };
        }

        if (scanned >= maxDocsToScan) {
          break;
        }
      }

      if (pageSnapshot.size < pageSize) {
        return null;
      }

      const lastDoc = pageSnapshot.docs[pageSnapshot.docs.length - 1];
      query = params.paymentsToSendRef.startAfter(lastDoc).limit(pageSize);
    }

    return null;
  }

  private resolveReason(
    requestedReason?: string,
    notes?: string,
    fallbackReason?: string,
  ): string {
    const resolved =
      this.normalizeOptionalString(requestedReason) ||
      this.normalizeOptionalString(fallbackReason) ||
      this.normalizeOptionalString(notes) ||
      'Reversa de pago solicitada por administración';

    return resolved.slice(0, 300);
  }

  private getAllowedPaymentIdsFromOperation(
    operation: StoredReversalOperation,
  ): Set<string> {
    const values = [
      this.normalizeString(operation.paymentId),
      this.normalizeString(operation.payment?.paymentId),
      this.normalizeString(operation.payment?.paymentGroupId),
      this.normalizeString(operation.target?.paymentGroupId),
      ...(Array.isArray(operation.target?.components)
        ? operation.target.components.map((component) =>
            this.normalizeString(component?.paymentId),
          )
        : []),
    ].filter(Boolean);

    return new Set(values);
  }

  private resolveCanonicalPaymentId(
    operation: StoredReversalOperation,
    fallbackPaymentId: string,
  ): string {
    return (
      this.normalizeString(operation.paymentId) ||
      this.normalizeString(operation.payment?.paymentId) ||
      this.normalizeString(operation.target?.paymentGroupId) ||
      fallbackPaymentId
    );
  }

  private resolveOperationId(operationId?: string): string {
    const incoming = this.normalizeOptionalString(operationId);
    const generated = `op_rev_${Date.now()}_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    const resolved = incoming || generated;

    if (!/^[A-Za-z0-9_-]{6,80}$/.test(resolved)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_OPERATION_ID',
        'operationId inválido. Use solo letras, números, guion o guion bajo (6-80).',
      );
    }

    return resolved;
  }

  private getCondominiumRef(clientId: string, condominiumId: string) {
    return this.firestore
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId);
  }

  private parseDateBoundary(
    input: string | undefined,
    endOfDay: boolean,
  ): Date | null {
    const value = this.normalizeOptionalString(input);
    if (!value) {
      return null;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_DATE',
        `Formato de fecha inválido (${value}). Use YYYY-MM-DD.`,
      );
    }

    const date = new Date(
      endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`,
    );
    if (Number.isNaN(date.getTime())) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_DATE',
        `Fecha inválida (${value}).`,
      );
    }
    return date;
  }

  private hashIdempotencyKey(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private normalizeString(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).trim();
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    const normalized = this.normalizeString(value);
    return normalized || undefined;
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const parsed = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return parsed;
  }

  private roundAmount(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private isAlreadyReversed(data: Record<string, unknown>): boolean {
    const status = this.normalizeString(data.reversalStatus);
    return (
      data.isReversed === true ||
      status === 'reversed' ||
      !!this.normalizeString(data.reversalId)
    );
  }

  private throwApiError(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ): never {
    throw new HttpException(
      {
        ok: false,
        message,
        code,
        details,
      },
      status,
    );
  }
}
