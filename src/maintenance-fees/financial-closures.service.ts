import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import axios from 'axios';
import { createHash, randomInt, timingSafeEqual } from 'crypto';

export type ClosureDirection = 'all' | 'income' | 'expense';
export type ClosureMovement = {
  id: string;
  type: 'income' | 'expense';
  date: string;
  amount: number;
  concept: string;
  condominiumUnit: string;
  reference: string;
  accountId: string;
  description: string;
};

@Injectable()
export class FinancialClosuresService {
  private readonly db = admin.firestore();

  private condo(clientId: string, condominiumId: string) {
    return this.db.collection('clients').doc(clientId).collection('condominiums').doc(condominiumId);
  }

  private validDate(value: string): string {
    const parsed = new Date(`${value}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new BadRequestException('La fecha debe tener formato YYYY-MM-DD y ser válida.');
    }
    return value;
  }

  private validMonth(value: string): string {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
      throw new BadRequestException('Mes inválido. Usa YYYY-MM.');
    }
    return value;
  }

  monthForDate(value: string | undefined): string {
    if (typeof value !== 'string' || value.length < 10) throw new BadRequestException('La fecha del movimiento es obligatoria.');
    return this.validDate(value.slice(0, 10)).slice(0, 7);
  }

  private dateOf(value: any): string {
    if (value?.toDate) return value.toDate().toISOString().slice(0, 10);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'string') return value.slice(0, 10);
    return '';
  }

  private cents(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  }

  async assertAdmin(token: string, clientId: string, condominiumId: string): Promise<{ uid: string; name: string }> {
    if (!clientId || !condominiumId || typeof clientId !== 'string' || typeof condominiumId !== 'string' ||
      clientId.includes('/') || condominiumId.includes('/')) {
      throw new BadRequestException('Selecciona un cliente y un condominio válidos.');
    }
    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await admin.auth().verifyIdToken(token, true); }
    catch { throw new UnauthorizedException('La sesión expiró o es inválida.'); }
    if (decoded.clientId !== clientId || decoded.role !== 'admin') {
      throw new ForbiddenException('Solo un administrador del cliente puede administrar cierres.');
    }
    const snap = await this.condo(clientId, condominiumId).collection('users').doc(decoded.uid).get();
    if (!snap.exists || snap.data()?.role !== 'admin' || snap.data()?.active === false) {
      throw new ForbiddenException('El administrador no pertenece al condominio seleccionado.');
    }
    return { uid: decoded.uid, name: [snap.data()?.name, snap.data()?.lastName].filter(Boolean).join(' ') };
  }

  async isClosed(clientId: string, condominiumId: string, date: string): Promise<boolean> {
    const month = this.monthForDate(date);
    const snap = await this.condo(clientId, condominiumId).collection('financialClosures').doc(month).get();
    return ['closed', 'closing'].includes(snap.data()?.status);
  }

  async assertOpen(clientId: string, condominiumId: string, date: string): Promise<void> {
    if (await this.isClosed(clientId, condominiumId, date)) {
      throw new ConflictException(`El mes ${date.slice(0, 7)} está cerrado. Solicita su reapertura para registrar o revertir movimientos.`);
    }
  }

  async withOpenMonth<T>(clientId: string, condominiumId: string, date: string | undefined, action: () => Promise<T>): Promise<T> {
    const month = this.monthForDate(date);
    const ref = this.condo(clientId, condominiumId).collection('financialClosures').doc(month);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (['closed', 'closing'].includes(snap.data()?.status)) throw new ConflictException(`El mes ${month} está cerrado.`);
      tx.set(ref, { status: 'open', month, activeMutations: (snap.data()?.activeMutations || 0) + 1 }, { merge: true });
    });
    try {
      return await action();
    } finally {
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        tx.set(ref, { activeMutations: Math.max(0, Number(snap.data()?.activeMutations || 0) - 1) }, { merge: true });
      });
    }
  }

  async readMovements(clientId: string, condominiumId: string, from: string, to: string): Promise<ClosureMovement[]> {
    this.validDate(from);
    this.validDate(to);
    if (from > to || (new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) > 366 * 86400000) {
      throw new BadRequestException('Selecciona un rango válido de hasta 12 meses.');
    }
    const condo = this.condo(clientId, condominiumId);
    const [users, expenses, unidentified] = await Promise.all([
      condo.collection('users').get(),
      condo.collection('expenses').get(),
      condo.collection('unidentifiedPayments').get(),
    ]);
    const rows: ClosureMovement[] = [];
    for (let offset = 0; offset < users.docs.length; offset += 20) {
      await Promise.all(users.docs.slice(offset, offset + 20).map(async (user) => {
        const charges = await user.ref.collection('charges').get();
        await Promise.all(charges.docs.map(async (charge) => {
          const payments = await charge.ref.collection('payments').get();
          for (const payment of payments.docs) {
            const data = payment.data();
            const date = this.dateOf(data.paymentDate || data.dateRegistered);
            if (date < from || date > to) continue;
            rows.push({
              id: `income:${payment.ref.path}`, type: 'income', date,
              amount: this.cents(data.amountPaid),
              concept: String(data.concept || charge.data().concept || 'Pago'),
              condominiumUnit: [
                [user.data().name, user.data().lastName].filter(Boolean).join(' '),
                String(data.numberCondominium || user.data().number || ''),
              ].filter(Boolean).join(' · '),
              reference: String(data.paymentReference || data.folio || ''),
              accountId: String(data.financialAccountId || ''),
              description: String(data.comments || ''),
            });
          }
        }));
      }));
    }
    for (const payment of unidentified.docs) {
      const data = payment.data();
      if (data.appliedToUser === true) continue;
      const date = this.dateOf(data.paymentDate || data.dateRegistered);
      if (date < from || date > to) continue;
      rows.push({
        id: `income:${payment.ref.path}`, type: 'income', date,
        amount: this.cents(data.amountPaid), concept: 'Pago no identificado',
        condominiumUnit: String(data.numberCondominium || ''),
        reference: String(data.paymentReference || data.folio || ''),
        accountId: String(data.financialAccountId || ''),
        description: String(data.comments || ''),
      });
    }
    for (const expense of expenses.docs) {
      const data = expense.data();
      const date = this.dateOf(data.expenseDate);
      if (date < from || date > to) continue;
      rows.push({
        id: `expense:${expense.ref.path}`, type: 'expense', date,
        amount: this.cents(data.amount), concept: String(data.concept || 'Egreso'),
        condominiumUnit: '', reference: String(data.folio || ''),
        accountId: String(data.financialAccountId || ''),
        description: String(data.description || ''),
      });
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }

  private summarize(rows: ClosureMovement[]) {
    const incomeCents = rows.filter((row) => row.type === 'income').reduce((sum, row) => sum + row.amount, 0);
    const expenseCents = rows.filter((row) => row.type === 'expense').reduce((sum, row) => sum + row.amount, 0);
    const digest = createHash('sha256').update(JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
    return { incomeCents, expenseCents, incomeCount: rows.filter((row) => row.type === 'income').length, expenseCount: rows.filter((row) => row.type === 'expense').length, digest };
  }

  async movements(params: { clientId: string; condominiumId: string; from: string; to: string; direction?: ClosureDirection; search?: string; page?: number; limit?: number }) {
    const rows = await this.readMovements(params.clientId, params.condominiumId, params.from, params.to);
    const summary = this.summarize(rows);
    const direction = params.direction || 'all';
    const search = String(params.search || '').trim().toLocaleLowerCase('es-MX');
    const filtered = rows.filter((row) => (direction === 'all' || row.type === direction)
      && (!search || [row.concept, row.condominiumUnit, row.reference, row.description, row.accountId].some((value) => value.toLocaleLowerCase('es-MX').includes(search))));
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(params.limit) || 25));
    return { items: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page, limit, summary };
  }

  async list(clientId: string, condominiumId: string, page = 1, limit = 10) {
    const snap = await this.condo(clientId, condominiumId).collection('financialClosures').orderBy('month', 'desc').get();
    const all = snap.docs.filter((doc) => doc.data().closedAt);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
    return { items: all.slice((safePage - 1) * safeLimit, safePage * safeLimit).map((doc) => ({ id: doc.id, ...doc.data() })), total: all.length, page: safePage, limit: safeLimit };
  }

  async get(clientId: string, condominiumId: string, month: string) {
    const snap = await this.condo(clientId, condominiumId).collection('financialClosures').doc(this.validMonth(month)).get();
    return snap.data()?.closedAt ? { id: snap.id, ...snap.data() } : null;
  }

  async close(params: { clientId: string; condominiumId: string; month: string; openingBalanceCents: number; expectedDigest: string; actorUid: string }) {
    const month = this.validMonth(params.month);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const openingBalanceCents = Number(params.openingBalanceCents);
    if (!Number.isSafeInteger(openingBalanceCents)) throw new BadRequestException('Saldo inicial inválido.');
    const condo = this.condo(params.clientId, params.condominiumId);
    const later = await condo.collection('financialClosures').orderBy('month', 'desc').get();
    if (later.docs.some((doc) => doc.id > month && ['closed', 'closing'].includes(doc.data().status))) {
      throw new ConflictException('Reabre primero los meses posteriores para mantener la continuidad de saldos.');
    }
    const ref = condo.collection('financialClosures').doc(month);
    const lease = createHash('sha256').update(`${Date.now()}-${randomInt(0, 1000000)}`).digest('hex');
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.status === 'closed') throw new ConflictException('Este mes ya está cerrado.');
      if (snap.data()?.status === 'closing' && Date.now() - Number(snap.data()?.closingAt?.toMillis?.() || 0) < 5 * 60000) {
        throw new ConflictException('El cierre de este mes ya está en proceso.');
      }
      if (Number(snap.data()?.activeMutations || 0) > 0) throw new ConflictException('Hay registros de pago en proceso; intenta de nuevo al terminar.');
      tx.set(ref, { month, status: 'closing', closingAt: admin.firestore.Timestamp.now(), closingLease: lease, activeMutations: 0 }, { merge: true });
    });
    try {
    const rows = await this.readMovements(params.clientId, params.condominiumId, from, to);
    const summary = this.summarize(rows);
    if (summary.digest !== params.expectedDigest) throw new ConflictException('Los movimientos cambiaron. Actualiza el listado antes de cerrar.');
    const previousMonth = new Date(`${from}T12:00:00Z`);
    previousMonth.setUTCDate(0);
    const previous = await condo.collection('financialClosures').doc(previousMonth.toISOString().slice(0, 7)).get();
    if (previous.data()?.status === 'closing') {
      throw new ConflictException('El mes anterior está en proceso de cierre. Intenta de nuevo al terminar.');
    }
    if (previous.data()?.closedAt && previous.data()?.status !== 'closed') {
      throw new ConflictException('Cierra nuevamente el mes anterior antes de cerrar este periodo.');
    }
    if (previous.data()?.status === 'closed' && Number(previous.data()?.closingBalanceCents) !== openingBalanceCents) {
      throw new ConflictException('El saldo inicial debe coincidir con el saldo final del mes anterior cerrado.');
    }
    const closingBalanceCents = openingBalanceCents + summary.incomeCents - summary.expenseCents;
    const auditRef = condo.collection('auditLogs').doc();
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.data()?.status !== 'closing' || snap.data()?.closingLease !== lease) throw new ConflictException('El cierre fue interrumpido; vuelve a cargar.');
      tx.set(ref, {
        month, from, to, status: 'closed', openingBalanceCents, closingBalanceCents,
        ...summary, closedAt: admin.firestore.Timestamp.now(), closedBy: params.actorUid,
        revision: Number(snap.data()?.revision || 0) + 1, activeMutations: 0,
        closingLease: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      tx.set(auditRef, { type: 'finance.month_closed', month, actorUid: params.actorUid, createdAt: admin.firestore.Timestamp.now(), summary });
    });
    return { month, from, to, openingBalanceCents, closingBalanceCents, ...summary, status: 'closed' };
    } catch (error) {
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.data()?.status === 'closing' && snap.data()?.closingLease === lease) {
          tx.update(ref, { status: 'open', closingLease: admin.firestore.FieldValue.delete() });
        }
      });
      throw error;
    }
  }

  async requestReopen(params: { clientId: string; condominiumId: string; month: string; actorUid: string }) {
    const month = this.validMonth(params.month);
    const condo = this.condo(params.clientId, params.condominiumId);
    const [closure, condominium] = await Promise.all([condo.collection('financialClosures').doc(month).get(), condo.get()]);
    if (closure.data()?.status !== 'closed') throw new ConflictException('Solo se puede reabrir un mes cerrado.');
    const later = await condo.collection('financialClosures').orderBy('month', 'desc').get();
    if (later.docs.some((doc) => doc.id > month && ['closed', 'closing'].includes(doc.data().status))) {
      throw new ConflictException('Reabre primero los meses posteriores para mantener la continuidad de saldos.');
    }
    const phone = String(condominium.data()?.reconciliationWhatsappPhone || '').replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(phone)) throw new BadRequestException('Configura el WhatsApp del administrador responsable en Configuración.');
    const apiVersion = process.env.WHATSAPP_API_VERSION;
    const phoneNumberId = process.env.PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!apiVersion || !phoneNumberId || !accessToken) {
      throw new ServiceUnavailableException('WhatsApp no está configurado en el servidor.');
    }
    const challengeRef = condo.collection('financialReopenChallenges').doc(month);
    const previous = await challengeRef.get();
    if (previous.exists && Date.now() - Number(previous.data()?.createdAt?.toMillis?.() || 0) < 60000) {
      throw new ConflictException('Espera un minuto antes de solicitar otro código.');
    }
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const salt = createHash('sha256').update(`${Date.now()}-${randomInt(0, 1000000)}`).digest('hex');
    await challengeRef.set({ hash: createHash('sha256').update(`${salt}:${code}`).digest('hex'), salt,
      createdAt: admin.firestore.Timestamp.now(), expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60000),
      attempts: 0, actorUid: params.actorUid, phoneLast4: phone.slice(-4) });
    try {
      const templateName = process.env.REOPEN_WHATSAPP_TEMPLATE_NAME;
      const payload = templateName ? {
        messaging_product: 'whatsapp', to: phone, type: 'template',
        template: { name: templateName, language: { code: process.env.REOPEN_WHATSAPP_TEMPLATE_LANGUAGE || 'es_MX' }, components: [{ type: 'body', parameters: [{ type: 'text', text: code }, { type: 'text', text: month }] }] },
      } : {
        messaging_product: 'whatsapp', to: phone, type: 'text',
        text: { body: `Código de autorización para reabrir la conciliación ${month}: ${code}. Vence en 10 minutos. No lo compartas.` },
      };
      await axios.post(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, payload, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000,
      });
    } catch {
      await challengeRef.delete().catch(() => undefined);
      throw new ServiceUnavailableException('WhatsApp no pudo entregar el código. Si no hay una plantilla aprobada, el administrador debe abrir una conversación reciente con el número del servicio.');
    }
    return { sent: true, phoneLast4: phone.slice(-4), expiresInSeconds: 600 };
  }

  async reopen(params: { clientId: string; condominiumId: string; month: string; code: string; actorUid: string }) {
    const month = this.validMonth(params.month);
    if (!/^\d{6}$/.test(params.code)) throw new BadRequestException('Ingresa el código de seis dígitos.');
    const condo = this.condo(params.clientId, params.condominiumId);
    const closureRef = condo.collection('financialClosures').doc(month);
    const challengeRef = condo.collection('financialReopenChallenges').doc(month);
    const auditRef = condo.collection('auditLogs').doc();
    const later = await condo.collection('financialClosures').orderBy('month', 'desc').get();
    if (later.docs.some((doc) => doc.id > month && ['closed', 'closing'].includes(doc.data().status))) {
      throw new ConflictException('Reabre primero los meses posteriores para mantener la continuidad de saldos.');
    }
    const authorized = await this.db.runTransaction(async (tx) => {
      const [closure, challenge] = await Promise.all([tx.get(closureRef), tx.get(challengeRef)]);
      if (closure.data()?.status !== 'closed') throw new ConflictException('El mes ya está abierto.');
      const data = challenge.data();
      if (!data || data.actorUid !== params.actorUid || Number(data.expiresAt?.toMillis?.() || 0) <= Date.now() || data.attempts >= 5) {
        throw new ForbiddenException('El código venció o agotó los intentos. Solicita otro.');
      }
      const expected = Buffer.from(data.hash, 'hex');
      const actual = createHash('sha256').update(`${data.salt}:${params.code}`).digest();
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        tx.update(challengeRef, { attempts: data.attempts + 1 });
        return false;
      }
      tx.update(closureRef, { status: 'open', reopenedAt: admin.firestore.Timestamp.now(), reopenedBy: params.actorUid });
      tx.delete(challengeRef);
      tx.set(auditRef, { type: 'finance.month_reopened', month, actorUid: params.actorUid, createdAt: admin.firestore.Timestamp.now() });
      return true;
    });
    if (!authorized) throw new ForbiddenException('Código incorrecto.');
    return { month, status: 'open' };
  }
}
