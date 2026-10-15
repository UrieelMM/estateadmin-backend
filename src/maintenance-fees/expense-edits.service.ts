import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { FinancialClosuresService } from './financial-closures.service';
import { FinancialAdminActor } from './financial-admin-auth';
import { ExpenseEditCommitDto, ExpenseEditTenantQueryDto } from 'src/dtos/expense-edits.dto';

type EditableExpenseSnapshot = {
  expenseId: string;
  folio: string;
  amountCents: number;
  concept: string;
  expenseDate: string;
  financialAccountId: string;
  providerId: string;
  description: string;
  invoiceUrl: string;
  editCount: number;
};

type EditableField = 'amount' | 'description' | 'invoiceUrl';

type FieldChange = { before: string | number; after: string | number };

type LinkedSource = 'pettyCash' | 'maintenanceCost' | null;

const STORAGE_HOST = 'firebasestorage.googleapis.com';

@Injectable()
export class ExpenseEditsService {
  constructor(private readonly closures: FinancialClosuresService) {}
  private readonly logger = new Logger(ExpenseEditsService.name);
  private readonly firestore = admin.firestore();
  private readonly historyHardLimit = 200;

  async getEligibility(query: ExpenseEditTenantQueryDto) {
    const condominiumRef = this.getCondominiumRef(query.clientId, query.condominiumId);
    const expenseSnap = await condominiumRef.collection('expenses').doc(query.expenseId).get();
    const expense = this.toEditableSnapshot(expenseSnap);
    const [periodClosed, linkedSource] = await Promise.all([
      this.closures.isClosed(query.clientId, query.condominiumId, expense.expenseDate, 'expense'),
      this.findLinkedSource(condominiumRef, query.expenseId),
    ]);
    const month = this.closures.monthForDate(expense.expenseDate);

    return {
      ok: true,
      data: {
        editable: !periodClosed,
        amountEditable: !periodClosed && !linkedSource,
        periodClosed,
        linkedSource,
        lockReason: periodClosed
          ? `Los egresos de ${month} están cerrados; solicita su reapertura para editar.`
          : linkedSource
            ? this.linkedSourceMessage(linkedSource)
            : null,
        expense: this.toPublicExpense(expense),
      },
    };
  }

  async commitEdit(params: {
    dto: ExpenseEditCommitDto;
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
    if (dto.amount === undefined && dto.description === undefined && dto.invoiceUrl === undefined) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'NO_CHANGES',
        'Indica al menos un campo a modificar (monto, descripción o comprobante).',
      );
    }
    if (dto.invoiceUrl !== undefined) {
      this.assertTenantInvoiceUrl(dto.invoiceUrl, dto.clientId, dto.condominiumId);
    }

    const expectedAmountCents = this.toCents(dto.expectedAmount);
    const requestedAmountCents = dto.amount === undefined ? undefined : this.toCents(dto.amount);
    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          expenseId: dto.expenseId,
          expectedAmountCents,
          amountCents: requestedAmountCents ?? null,
          description: dto.description ?? null,
          invoiceUrl: dto.invoiceUrl ?? null,
          reason: dto.reason,
          notes: dto.notes ?? null,
        }),
      )
      .digest('hex');

    const condominiumRef = this.getCondominiumRef(dto.clientId, dto.condominiumId);
    const idempotencyRef = condominiumRef.collection('expenseEditIdempotency').doc(keyHash);
    const expenseRef = condominiumRef.collection('expenses').doc(dto.expenseId);

    const precheck = this.toEditableSnapshot(await expenseRef.get());
    await this.closures.assertOpen(dto.clientId, dto.condominiumId, precheck.expenseDate, 'expense');

    const response = await this.firestore.runTransaction(async (transaction) => {
      const [idempotencySnap, expenseSnap] = await Promise.all([
        transaction.get(idempotencyRef),
        transaction.get(expenseRef),
      ]);

      if (idempotencySnap.exists) {
        const stored = idempotencySnap.data() || {};
        if (
          stored.status === 'applied' &&
          stored.response &&
          stored.expenseId === dto.expenseId &&
          stored.requestHash === requestHash
        ) {
          return stored.response;
        }
        this.throwApiError(
          HttpStatus.CONFLICT,
          'IDEMPOTENCY_CONFLICT',
          'La operación ya fue ejecutada o está en proceso para esta llave de idempotencia.',
        );
      }

      const current = this.toEditableSnapshot(expenseSnap);
      if (current.amountCents !== expectedAmountCents) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'EXPENSE_CHANGED',
          'El monto del egreso cambió mientras lo editabas; vuelve a abrirlo para ver el valor actual.',
        );
      }

      const changes: Partial<Record<EditableField, FieldChange>> = {};
      if (requestedAmountCents !== undefined && requestedAmountCents !== current.amountCents) {
        changes.amount = { before: current.amountCents, after: requestedAmountCents };
      }
      if (dto.description !== undefined && dto.description !== current.description) {
        changes.description = { before: current.description, after: dto.description };
      }
      if (dto.invoiceUrl !== undefined && dto.invoiceUrl !== current.invoiceUrl) {
        changes.invoiceUrl = { before: current.invoiceUrl, after: dto.invoiceUrl };
      }
      const changedFields = Object.keys(changes) as EditableField[];
      if (!changedFields.length) {
        this.throwApiError(
          HttpStatus.BAD_REQUEST,
          'NO_CHANGES',
          'No hay cambios respecto al egreso actual.',
        );
      }

      const month = this.closures.monthForDate(current.expenseDate);
      const closuresRef = condominiumRef.collection('financialClosures');
      const markRef = condominiumRef
        .collection('financialReconciliationMarks')
        .doc(`${month}_expense`)
        .collection('items')
        .doc(createHash('sha256').update(`expense:${expenseRef.path}`).digest('hex'));
      const [legacyClosure, expenseClosure, markSnap, pettyCashLink, maintenanceLink] =
        await Promise.all([
          transaction.get(closuresRef.doc(month)),
          transaction.get(closuresRef.doc(`${month}_expense`)),
          transaction.get(markRef),
          transaction.get(
            condominiumRef
              .collection('pettyCashTransactions')
              .where('expenseId', '==', dto.expenseId)
              .limit(1),
          ),
          transaction.get(
            condominiumRef
              .collection('maintenanceCosts')
              .where('expenseId', '==', dto.expenseId)
              .limit(1),
          ),
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

      const linkedSource: LinkedSource = !pettyCashLink.empty
        ? 'pettyCash'
        : !maintenanceLink.empty
          ? 'maintenanceCost'
          : null;
      if (changes.amount && linkedSource) {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'EXPENSE_AMOUNT_LINKED',
          this.linkedSourceMessage(linkedSource),
        );
      }

      const removeMark = Boolean(changes.amount) && markSnap.exists;
      const nowTs = admin.firestore.Timestamp.now();
      const editRef = condominiumRef.collection('expenseEdits').doc();
      const auditRef = condominiumRef.collection('auditLogs').doc();
      const performedByName = actor.name || actor.email;
      const after = {
        amountCents: (changes.amount?.after as number | undefined) ?? current.amountCents,
        description: (changes.description?.after as string | undefined) ?? current.description,
        invoiceUrl: (changes.invoiceUrl?.after as string | undefined) ?? current.invoiceUrl,
      };
      const commitSummary = {
        editId: editRef.id,
        status: 'applied',
        message: 'Egreso actualizado correctamente',
        expenseId: dto.expenseId,
        expenseFolio: current.folio,
        changedFields,
        expense: {
          amount: after.amountCents / 100,
          description: after.description,
          invoiceUrl: after.invoiceUrl,
          editCount: current.editCount + 1,
        },
        performedAt: nowTs.toDate().toISOString(),
        auditLogId: auditRef.id,
        reconciliationMarkRemoved: removeMark,
      };

      const expenseUpdate: Record<string, unknown> = {
        updatedAt: nowTs,
        lastEditedAt: nowTs,
        lastEditedBy: { uid: actor.uid, email: actor.email, name: performedByName },
        lastEditId: editRef.id,
        editCount: admin.firestore.FieldValue.increment(1),
      };
      if (changes.amount) expenseUpdate.amount = after.amountCents;
      if (changes.description) expenseUpdate.description = after.description;
      if (changes.invoiceUrl) expenseUpdate.invoiceUrl = after.invoiceUrl;
      transaction.update(expenseRef, expenseUpdate);
      if (removeMark) transaction.delete(markRef);

      transaction.set(editRef, {
        expenseId: dto.expenseId,
        expenseFolio: current.folio,
        expenseDate: current.expenseDate,
        concept: current.concept,
        financialAccountId: current.financialAccountId,
        changedFields,
        changes,
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
        reconciliationMarkRemoved: removeMark,
        createdAt: nowTs,
      });

      transaction.set(auditRef, {
        type: 'finance.expense_edited',
        module: 'Egresos',
        entityType: 'expense',
        entityId: dto.expenseId,
        action: 'update',
        summary: `Edición de egreso ${current.folio || dto.expenseId}`,
        editId: editRef.id,
        changedFields,
        reason: dto.reason,
        notes: dto.notes || null,
        actorUid: actor.uid,
        actorEmail: actor.email,
        actorRole: 'admin',
        actorName: performedByName,
        clientId: dto.clientId,
        condominiumId: dto.condominiumId,
        sourceIp: params.sourceIp || '',
        before: Object.fromEntries(changedFields.map((field) => [field, changes[field]?.before])),
        after: Object.fromEntries(changedFields.map((field) => [field, changes[field]?.after])),
        createdAt: nowTs,
      });

      transaction.set(idempotencyRef, {
        expenseId: dto.expenseId,
        status: 'applied',
        editId: editRef.id,
        requestHash,
        response: commitSummary,
        updatedAt: nowTs,
      });

      return commitSummary;
    });

    this.logger.log(
      `[expense-edit-commit] actor=${actor.uid} expenseId=${dto.expenseId} fields=${(response.changedFields || []).join(',')}`,
    );

    return { ok: true, data: response };
  }

  async getEditHistory(query: ExpenseEditTenantQueryDto) {
    const snapshot = await this.getCondominiumRef(query.clientId, query.condominiumId)
      .collection('expenseEdits')
      .where('expenseId', '==', query.expenseId)
      .limit(this.historyHardLimit)
      .get();

    const items = snapshot.docs
      .map((doc) => {
        const data = doc.data() || {};
        const changes = (data.changes || {}) as Partial<Record<EditableField, FieldChange>>;
        const amount = changes.amount
          ? {
              before: this.toNumber(changes.amount.before) / 100,
              after: this.toNumber(changes.amount.after) / 100,
            }
          : undefined;
        const performedAt = (data.performedAt as admin.firestore.Timestamp | undefined)?.toDate();
        return {
          id: doc.id,
          expenseId: data.expenseId || '',
          expenseFolio: data.expenseFolio || '',
          changedFields: Array.isArray(data.changedFields) ? data.changedFields : [],
          changes: {
            ...(amount ? { amount } : {}),
            ...(changes.description ? { description: changes.description } : {}),
            ...(changes.invoiceUrl ? { invoiceUrl: changes.invoiceUrl } : {}),
          },
          reason: data.reason || '',
          notes: data.notes || '',
          performedByName: data.performedByName || data.performedBy?.email || '',
          performedAt: performedAt ? performedAt.toISOString() : null,
        };
      })
      .sort((a, b) => String(b.performedAt || '').localeCompare(String(a.performedAt || '')));

    return { ok: true, data: { items, total: items.length } };
  }

  private async findLinkedSource(
    condominiumRef: FirebaseFirestore.DocumentReference,
    expenseId: string,
  ): Promise<LinkedSource> {
    const [pettyCash, maintenance] = await Promise.all([
      condominiumRef.collection('pettyCashTransactions').where('expenseId', '==', expenseId).limit(1).get(),
      condominiumRef.collection('maintenanceCosts').where('expenseId', '==', expenseId).limit(1).get(),
    ]);
    if (!pettyCash.empty) return 'pettyCash';
    if (!maintenance.empty) return 'maintenanceCost';
    return null;
  }

  private linkedSourceMessage(source: Exclude<LinkedSource, null>): string {
    return source === 'pettyCash'
      ? 'Este egreso proviene de caja chica; su monto no puede editarse aquí. Revierte el egreso y captúralo de nuevo.'
      : 'Este egreso proviene de un costo de mantenimiento; edita el monto desde el módulo de mantenimiento.';
  }

  private assertTenantInvoiceUrl(rawUrl: string, clientId: string, condominiumId: string) {
    const invalid = (): never =>
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_INVOICE_URL',
        'El comprobante debe subirse al almacenamiento de egresos del condominio.',
      );
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return invalid();
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== STORAGE_HOST) invalid();
    const match = /^\/v0\/b\/([^/]+)\/o\/([^/]+)$/.exec(parsed.pathname);
    if (!match) return invalid();
    const expectedBucket = String(process.env.FIREBASE_STORAGE_BUCKET || '')
      .trim()
      .replace(/^gs:\/\//, '');
    if (expectedBucket && decodeURIComponent(match[1]) !== expectedBucket) invalid();
    let objectPath: string;
    try {
      objectPath = decodeURIComponent(match[2]);
    } catch {
      return invalid();
    }
    const prefix = `clients/${clientId}/condominiums/${condominiumId}/expenses/`;
    if (
      !objectPath.startsWith(prefix) ||
      objectPath.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      invalid();
    }
  }

  private toEditableSnapshot(snap: FirebaseFirestore.DocumentSnapshot): EditableExpenseSnapshot {
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
        'EXPENSE_NOT_EDITABLE',
        'El egreso ya fue revertido.',
      );
    }
    const amountCents = Math.round(this.toNumber(data.amount));
    if (amountCents <= 0) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'EXPENSE_NOT_EDITABLE',
        'El egreso no tiene un monto válido para editar.',
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
      invoiceUrl: String(data.invoiceUrl || ''),
      editCount: Math.max(0, Math.trunc(this.toNumber(data.editCount))),
    };
  }

  private toPublicExpense(expense: EditableExpenseSnapshot) {
    return {
      expenseId: expense.expenseId,
      folio: expense.folio,
      amount: expense.amountCents / 100,
      concept: expense.concept,
      expenseDate: expense.expenseDate,
      financialAccountId: expense.financialAccountId,
      description: expense.description,
      invoiceUrl: expense.invoiceUrl,
      editCount: expense.editCount,
    };
  }

  private toCents(pesos: number): number {
    return Math.round(pesos * 100);
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
