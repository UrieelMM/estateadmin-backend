import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { FinancialClosuresService } from './financial-closures.service';
import { FinancialAdminActor } from './financial-admin-auth';
import {
  ExpenseReversalCommitDto,
  ExpenseReversalHistoryQueryDto,
  ExpenseReversalPreviewDto,
} from 'src/dtos/expense-reversals.dto';

type ExpenseSnapshot = {
  expenseId: string;
  folio: string;
  amountCents: number;
  concept: string;
  expenseDate: string;
  financialAccountId: string;
  providerId: string;
  description: string;
};

type StoredExpenseReversalOperation = {
  operationId: string;
  status: 'previewed' | 'committed';
  clientId: string;
  condominiumId: string;
  expenseId: string;
  expense: ExpenseSnapshot;
  createdBy: { uid: string; email: string; name: string };
  createdAt: admin.firestore.Timestamp;
  expiresAt: admin.firestore.Timestamp;
  commitSummary?: Record<string, unknown>;
};

@Injectable()
export class ExpenseReversalsService {
  constructor(private readonly closures: FinancialClosuresService) {}
  private readonly logger = new Logger(ExpenseReversalsService.name);
  private readonly firestore = admin.firestore();
  private readonly previewTtlMs = 15 * 60 * 1000;
  private readonly historyHardLimit = 5000;

  async previewReversal(dto: ExpenseReversalPreviewDto, actor: FinancialAdminActor) {
    const condominiumRef = this.getCondominiumRef(dto.clientId, dto.condominiumId);
    const expenseSnap = await condominiumRef.collection('expenses').doc(dto.expenseId).get();
    const expense = this.toReversibleSnapshot(expenseSnap);
    await this.closures.assertOpen(dto.clientId, dto.condominiumId, expense.expenseDate, 'expense');

    const now = admin.firestore.Timestamp.now();
    const expiresAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + this.previewTtlMs);
    const operationId = `op_exp_rev_${Date.now()}_${uuidv4().replace(/-/g, '').slice(0, 8)}`;
    const operation: StoredExpenseReversalOperation = {
      operationId,
      status: 'previewed',
      clientId: dto.clientId,
      condominiumId: dto.condominiumId,
      expenseId: expense.expenseId,
      expense,
      createdBy: { uid: actor.uid, email: actor.email, name: actor.name },
      createdAt: now,
      expiresAt,
    };
    await condominiumRef.collection('expenseReversalOperations').doc(operationId).set(operation);

    this.logger.log(
      `[expense-reversal-preview] actor=${actor.uid} operationId=${operationId} expenseId=${expense.expenseId} amount=${expense.amountCents}`,
    );

    return {
      ok: true,
      data: {
        operationId,
        reversible: true,
        message: 'Egreso elegible para revertir',
        expiresAt: expiresAt.toDate().toISOString(),
        expense: this.toPublicExpense(expense),
      },
    };
  }

  async commitReversal(params: {
    dto: ExpenseReversalCommitDto;
    actor: FinancialAdminActor;
    idempotencyKey: string;
    sourceIp?: string;
  }) {
    const { dto, actor } = params;
    const idempotencyKey = String(params.idempotencyKey || '').trim();
    if (!idempotencyKey) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'IDEMPOTENCY_KEY_REQUIRED',
        'Header X-Idempotency-Key es obligatorio.',
      );
    }

    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    const condominiumRef = this.getCondominiumRef(dto.clientId, dto.condominiumId);
    const operationRef = condominiumRef.collection('expenseReversalOperations').doc(dto.operationId);
    const idempotencyRef = condominiumRef.collection('expenseReversalIdempotency').doc(keyHash);
    const expenseRef = condominiumRef.collection('expenses').doc(dto.expenseId);

    const response = await this.firestore.runTransaction(async (transaction) => {
      const [operationSnap, idempotencySnap, expenseSnap] = await Promise.all([
        transaction.get(operationRef),
        transaction.get(idempotencyRef),
        transaction.get(expenseRef),
      ]);

      if (idempotencySnap.exists) {
        const stored = idempotencySnap.data() || {};
        if (stored.status === 'applied' && stored.response) return stored.response;
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
          'No existe una validación vigente para esta reversa; vuelve a intentarlo.',
        );
      }
      const operation = operationSnap.data() as StoredExpenseReversalOperation;

      if (operation.clientId !== dto.clientId || operation.condominiumId !== dto.condominiumId) {
        this.throwApiError(
          HttpStatus.FORBIDDEN,
          'FORBIDDEN_TENANT',
          'La operación no pertenece al condominio solicitado.',
        );
      }
      if (operation.expenseId !== dto.expenseId) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'EXPENSE_MISMATCH',
          'El egreso no coincide con el validado previamente.',
        );
      }
      if (operation.createdBy?.uid !== actor.uid) {
        this.throwApiError(
          HttpStatus.FORBIDDEN,
          'FORBIDDEN_OPERATION_OWNER',
          'Solo el administrador que inició la reversa puede confirmarla.',
        );
      }
      if (operation.status === 'committed' && operation.commitSummary) {
        return operation.commitSummary;
      }
      if (operation.status !== 'previewed') {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'OPERATION_INVALID_STATE',
          'La operación no está pendiente de confirmación.',
        );
      }
      if (!operation.expiresAt || operation.expiresAt.toMillis() < Date.now()) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'OPERATION_EXPIRED',
          'La validación de la reversa expiró; vuelve a intentarlo.',
        );
      }

      const current = this.toReversibleSnapshot(expenseSnap);
      if (
        current.amountCents !== operation.expense.amountCents ||
        current.expenseDate !== operation.expense.expenseDate ||
        current.financialAccountId !== operation.expense.financialAccountId
      ) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'EXPENSE_CHANGED',
          'El egreso cambió desde la validación; vuelve a intentarlo.',
        );
      }

      const month = this.closures.monthForDate(current.expenseDate);
      const closuresRef = condominiumRef.collection('financialClosures');
      const markRef = condominiumRef
        .collection('financialReconciliationMarks')
        .doc(`${month}_expense`)
        .collection('items')
        .doc(createHash('sha256').update(`expense:${expenseRef.path}`).digest('hex'));
      const [legacyClosure, expenseClosure, markSnap] = await Promise.all([
        transaction.get(closuresRef.doc(month)),
        transaction.get(closuresRef.doc(`${month}_expense`)),
        transaction.get(markRef),
      ]);
      if (
        [legacyClosure, expenseClosure].some((snap) =>
          ['closed', 'closing'].includes(snap.data()?.status),
        )
      ) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'PERIOD_CLOSED',
          `Los egresos de ${month} están cerrados; solicita su reapertura.`,
        );
      }

      const nowTs = admin.firestore.Timestamp.now();
      const reversalRef = condominiumRef.collection('expenseReversals').doc();
      const auditRef = condominiumRef.collection('auditLogs').doc();
      const performedByName = actor.name || operation.createdBy?.name || actor.email;
      const commitSummary = {
        operationId: dto.operationId,
        reversalId: reversalRef.id,
        status: 'applied',
        message: 'Egreso revertido correctamente',
        expenseId: dto.expenseId,
        expenseFolio: current.folio,
        performedAt: nowTs.toDate().toISOString(),
        auditLogId: auditRef.id,
        reconciliationMarkRemoved: markSnap.exists,
      };

      transaction.set(condominiumRef.collection('reversedExpenses').doc(dto.expenseId), {
        ...(expenseSnap.data() || {}),
        isReversed: true,
        reversalStatus: 'reversed',
        reversalId: reversalRef.id,
        reversalReason: dto.reason,
        reversalNotes: dto.notes || '',
        reversedAt: nowTs,
        reversedBy: actor.uid,
        reversalOperationId: dto.operationId,
        archivedFrom: expenseRef.path,
      });
      transaction.delete(expenseRef);
      if (markSnap.exists) transaction.delete(markRef);

      transaction.set(reversalRef, {
        operationId: dto.operationId,
        expenseId: dto.expenseId,
        expenseFolio: current.folio,
        expense: current,
        reason: dto.reason,
        notes: dto.notes || null,
        status: 'applied',
        clientId: dto.clientId,
        condominiumId: dto.condominiumId,
        performedAt: nowTs,
        performedByName,
        performedBy: { uid: actor.uid, email: actor.email, role: 'admin' },
        sourceIp: params.sourceIp || '',
        idempotencyKeyHash: keyHash,
        createdAt: nowTs,
      });

      transaction.set(auditRef, {
        type: 'finance.expense_reversed',
        module: 'Egresos',
        entityType: 'expense_reversal',
        entityId: dto.expenseId,
        action: 'other',
        summary: `Reversa de egreso ${current.folio || dto.expenseId}`,
        operationId: dto.operationId,
        reversalId: reversalRef.id,
        reason: dto.reason,
        notes: dto.notes || null,
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: 'admin',
        actorName: performedByName,
        clientId: dto.clientId,
        condominiumId: dto.condominiumId,
        sourceIp: params.sourceIp || '',
        before: current,
        after: { status: 'reversed' },
        createdAt: nowTs,
      });

      transaction.update(operationRef, {
        status: 'committed',
        committedAt: nowTs,
        reason: dto.reason,
        notes: dto.notes || null,
        commitSummary,
        updatedAt: nowTs,
      });

      transaction.set(idempotencyRef, {
        operationId: dto.operationId,
        expenseId: dto.expenseId,
        status: 'applied',
        reversalId: reversalRef.id,
        response: commitSummary,
        updatedAt: nowTs,
      });

      return commitSummary;
    });

    this.logger.log(
      `[expense-reversal-commit] actor=${actor.uid} operationId=${dto.operationId} expenseId=${dto.expenseId}`,
    );

    return { ok: true, data: response };
  }

  async getReversalHistory(query: ExpenseReversalHistoryQueryDto) {
    const fromMs = this.parseDateBoundary(query.from, false);
    const toMs = this.parseDateBoundary(query.to, true);
    if (fromMs !== null && toMs !== null && fromMs > toMs) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_DATE_RANGE',
        'La fecha inicial no puede ser mayor que la final.',
      );
    }
    const folio = String(query.folio || '').toLowerCase();

    const snapshot = await this.getCondominiumRef(query.clientId, query.condominiumId)
      .collection('expenseReversals')
      .orderBy('performedAt', 'desc')
      .limit(this.historyHardLimit)
      .get();

    const filtered = snapshot.docs.filter((doc) => {
      const data = doc.data() || {};
      const performedAtMs = (data.performedAt as admin.firestore.Timestamp | undefined)?.toMillis();
      if (!performedAtMs) return false;
      if (fromMs !== null && performedAtMs < fromMs) return false;
      if (toMs !== null && performedAtMs > toMs) return false;
      return !folio || String(data.expenseFolio || '').toLowerCase().includes(folio);
    });

    const page = query.page || 1;
    const limit = query.limit || 10;
    const items = filtered.slice((page - 1) * limit, page * limit).map((doc) => {
      const data = doc.data() || {};
      const expense = (data.expense || {}) as Partial<ExpenseSnapshot>;
      return {
        id: doc.id,
        operationId: data.operationId || '',
        expenseId: data.expenseId || '',
        expenseFolio: data.expenseFolio || '',
        concept: expense.concept || '',
        amount: this.toNumber(expense.amountCents) / 100,
        expenseDate: expense.expenseDate || '',
        reason: data.reason || '',
        notes: data.notes || '',
        status: data.status || 'applied',
        performedByName: data.performedByName || data.performedBy?.email || '',
        performedAt: (data.performedAt as admin.firestore.Timestamp | undefined)
          ?.toDate()
          .toISOString() || null,
      };
    });

    return { ok: true, data: { items, total: filtered.length, page, limit } };
  }

  private toReversibleSnapshot(snap: FirebaseFirestore.DocumentSnapshot): ExpenseSnapshot {
    if (!snap.exists) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'EXPENSE_NOT_FOUND',
        'No se encontró el egreso o ya fue revertido.',
      );
    }
    const data = snap.data() || {};
    if (data.isReversed === true || data.reversalId) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'EXPENSE_NOT_REVERSIBLE',
        'El egreso ya fue revertido.',
      );
    }
    const amountCents = Math.round(this.toNumber(data.amount));
    if (amountCents <= 0) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'EXPENSE_NOT_REVERSIBLE',
        'El egreso no tiene un monto válido para revertir.',
      );
    }
    const expenseDate = String(data.expenseDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(expenseDate)) {
      this.throwApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'EXPENSE_INVALID',
        'El egreso no tiene una fecha válida.',
      );
    }
    return {
      expenseId: snap.id,
      folio: String(data.folio || ''),
      amountCents,
      concept: String(data.concept || ''),
      expenseDate,
      financialAccountId: String(data.financialAccountId || ''),
      providerId: String(data.providerId || ''),
      description: String(data.description || ''),
    };
  }

  private toPublicExpense(expense: ExpenseSnapshot) {
    return {
      expenseId: expense.expenseId,
      folio: expense.folio,
      amount: expense.amountCents / 100,
      concept: expense.concept,
      expenseDate: expense.expenseDate,
      financialAccountId: expense.financialAccountId,
    };
  }

  private parseDateBoundary(input: string | undefined, endOfDay: boolean): number | null {
    if (!input) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_DATE',
        `Formato de fecha inválido (${input}). Use YYYY-MM-DD.`,
      );
    }
    const ms = new Date(`${input}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).getTime();
    if (Number.isNaN(ms)) {
      this.throwApiError(HttpStatus.BAD_REQUEST, 'INVALID_DATE', `Fecha inválida (${input}).`);
    }
    return ms;
  }

  private getCondominiumRef(clientId: string, condominiumId: string) {
    return this.firestore
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId);
  }

  private toNumber(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private throwApiError(status: number, code: string, message: string): never {
    throw new HttpException({ ok: false, message, code, details: {} }, status);
  }
}
