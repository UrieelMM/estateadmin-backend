import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);
  private readonly billingLockId = 'client-auto-billing-cron-lock';
  private readonly billingCronBatchSize = 100;
  private readonly billingDueDays = 30;
  private readonly suspensionLockId = 'client-billing-suspension-cron-lock';
  private readonly overdueSuspensionDays = 30;

  constructor() {
    // Inicializar Stripe con la clave secreta
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      apiVersion: '2025-03-31.basil',
    });
  }

  async bootstrapClientBilling(params: {
    clientId: string;
    condominiumId: string;
    adminUid: string;
  }) {
    const { clientId, condominiumId, adminUid } = params;
    const clientRef = admin.firestore().collection('clients').doc(clientId);
    const clientDoc = await clientRef.get();

    if (!clientDoc.exists) {
      throw new BadRequestException(`No se encontró el cliente ${clientId}`);
    }

    const clientData = clientDoc.data() || {};
    const issueDate = new Date();
    const billingFrequency = this.normalizeBillingFrequency(
      clientData.billingFrequency,
    );
    const anchorDay = this.resolveAnchorDay(clientData, issueDate);
    const dueDays = this.resolveDueDays();
    const amount = this.parsePricingAmount(clientData.pricing);
    const currency = this.normalizeCurrency(clientData.currency);
    const effectiveCondominiumId =
      condominiumId ||
      clientData.defaultCondominiumId ||
      this.resolveDefaultCondominiumId(clientData);

    if (!effectiveCondominiumId) {
      this.logger.warn(
        `No se pudo determinar condominiumId para facturación inicial del cliente ${clientId}`,
      );
      return {
        success: false,
        message: 'No se encontró condominio objetivo para facturación inicial',
      };
    }

    if (amount <= 0) {
      const nextBillingDate = this.addBillingInterval(
        issueDate,
        billingFrequency,
        anchorDay,
      );
      await clientRef.set(
        {
          status: clientData.status || 'active',
          billingAnchorDay: anchorDay,
          nextBillingDate: admin.firestore.Timestamp.fromDate(nextBillingDate),
          defaultCondominiumId: effectiveCondominiumId,
          ownerAdminUid: adminUid || clientData.ownerAdminUid || null,
          ownerEmail: clientData.ownerEmail || clientData.email || null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        success: false,
        message:
          'Cliente registrado. La facturación inicial se omitió por pricing inválido o cero.',
      };
    }

    const billingResult = await this.createAutomatedInvoiceForPeriod({
      clientId,
      condominiumId: effectiveCondominiumId,
      adminUid: adminUid || clientData.ownerAdminUid || null,
      adminEmail: clientData.ownerEmail || clientData.email || null,
      issueDate,
      billingFrequency,
      amount,
      currency,
      plan: clientData.plan,
      source: 'auto_initial_registration',
      dueDays,
      clientData,
      periodDate: issueDate,
    });

    const nextBillingDate = this.addBillingInterval(
      issueDate,
      billingFrequency,
      anchorDay,
    );
    await clientRef.set(
      {
        status: clientData.status || 'active',
        billingAnchorDay: anchorDay,
        nextBillingDate: admin.firestore.Timestamp.fromDate(nextBillingDate),
        defaultCondominiumId: effectiveCondominiumId,
        ownerAdminUid: adminUid || clientData.ownerAdminUid || null,
        ownerEmail: clientData.ownerEmail || clientData.email || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      success: true,
      message: 'Facturación inicial procesada',
      ...billingResult,
      nextBillingDate: nextBillingDate.toISOString(),
    };
  }

  @Cron('10 * * * *')
  async processRecurringClientInvoices() {
    const lockTtlMs = 10 * 60 * 1000;
    const lockAcquired = await this.acquireBillingLock(lockTtlMs);
    if (!lockAcquired) {
      return;
    }

    try {
      const now = new Date();
      const nowTs = admin.firestore.Timestamp.fromDate(now);
      const clientsSnapshot = await admin
        .firestore()
        .collection('clients')
        .where('nextBillingDate', '<=', nowTs)
        .orderBy('nextBillingDate', 'asc')
        .limit(this.billingCronBatchSize)
        .get();

      if (clientsSnapshot.empty) {
        return;
      }

      for (const clientDoc of clientsSnapshot.docs) {
        try {
          const clientData = clientDoc.data() || {};
          const clientStatus = String(clientData.status || 'active').toLowerCase();
          if (clientStatus === 'suspended' || clientStatus === 'inactive') {
            continue;
          }

          const amount = this.parsePricingAmount(clientData.pricing);
          if (amount <= 0) {
            this.logger.warn(
              `Se omite facturación recurrente para clientId=${clientDoc.id} por pricing inválido`,
            );
            continue;
          }

          const billingFrequency = this.normalizeBillingFrequency(
            clientData.billingFrequency,
          );
          const anchorDay = this.resolveAnchorDay(clientData, now);
          const currency = this.normalizeCurrency(clientData.currency);
          const dueDays = this.resolveDueDays();
          const condominiumId =
            clientData.defaultCondominiumId ||
            this.resolveDefaultCondominiumId(clientData);
          const adminUid = clientData.ownerAdminUid || null;
          const adminEmail = clientData.ownerEmail || clientData.email || null;

          if (!condominiumId) {
            this.logger.warn(
              `No se encontró condominio para facturación recurrente de clientId=${clientDoc.id}`,
            );
            continue;
          }

          const nextBillingDate = this.resolveNextBillingDate(clientData, now);
          let cursor = nextBillingDate;
          let iterations = 0;

          while (cursor.getTime() <= now.getTime() && iterations < 12) {
            await this.createAutomatedInvoiceForPeriod({
              clientId: clientDoc.id,
              condominiumId,
              adminUid,
              adminEmail,
              issueDate: cursor,
              periodDate: cursor,
              billingFrequency,
              amount,
              currency,
              plan: clientData.plan,
              source: 'auto_scheduler',
              dueDays,
              clientData,
            });

            cursor = this.addBillingInterval(cursor, billingFrequency, anchorDay);
            iterations++;
          }

          if (cursor.getTime() !== nextBillingDate.getTime()) {
            await clientDoc.ref.set(
              {
                billingAnchorDay: anchorDay,
                nextBillingDate: admin.firestore.Timestamp.fromDate(cursor),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true },
            );
          }
        } catch (clientError) {
          this.logger.error(
            `Error en facturación recurrente para clientId=${clientDoc.id}: ${clientError?.message || clientError}`,
            clientError?.stack,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Error en scheduler de facturación recurrente: ${error.message}`,
        error.stack,
      );
    } finally {
      await this.releaseBillingLock();
    }
  }

  @Cron('20 3 * * *')
  async enforceClientSuspensionsByOverdueInvoices() {
    const lockTtlMs = 15 * 60 * 1000;
    const lockAcquired = await this.acquireNamedLock(
      this.suspensionLockId,
      lockTtlMs,
    );
    if (!lockAcquired) {
      return;
    }

    try {
      const thresholdDate = new Date();
      thresholdDate.setUTCDate(
        thresholdDate.getUTCDate() - this.overdueSuspensionDays,
      );
      const thresholdTs = admin.firestore.Timestamp.fromDate(thresholdDate);

      const delinquentStatuses = this.getDelinquentInvoiceStatuses();
      const overdueInvoices = await admin
        .firestore()
        .collectionGroup('invoicesGenerated')
        .where('paymentStatus', 'in', delinquentStatuses)
        .where('dueDate', '<=', thresholdTs)
        .limit(500)
        .get();

      const affectedClients = new Map<
        string,
        {
          condominiumId: string;
          invoiceId: string;
          dueDate?: any;
          paymentStatus?: string;
          periodKey?: string;
        }
      >();

      overdueInvoices.docs.forEach((doc) => {
        const data = doc.data() || {};
        const fromPath = this.extractTenantFromInvoicePath(doc.ref.path);
        const clientId = data.clientId || fromPath.clientId;
        const condominiumId = data.condominiumId || fromPath.condominiumId;

        if (!clientId || !condominiumId) {
          return;
        }

        if (!affectedClients.has(clientId)) {
          affectedClients.set(clientId, {
            condominiumId,
            invoiceId: doc.id,
            dueDate: data.dueDate,
            paymentStatus: data.paymentStatus,
            periodKey: data.periodKey,
          });
        }
      });

      for (const [clientId, overdueInfo] of affectedClients.entries()) {
        await this.applyBillingSuspension(clientId, overdueInfo);
      }

      const currentlyDelinquentClients = await admin
        .firestore()
        .collection('clients')
        .where('billingDelinquent', '==', true)
        .limit(500)
        .get();

      for (const clientDoc of currentlyDelinquentClients.docs) {
        await this.tryClearBillingSuspension(clientDoc.id, thresholdTs);
      }
    } catch (error) {
      this.logger.error(
        `Error al ejecutar suspensión automática por mora: ${error.message}`,
        error.stack,
      );
    } finally {
      await this.releaseNamedLock(this.suspensionLockId);
    }
  }

  /**
   * Crear una sesión de checkout para pagar una factura
   */
  async createCheckoutSession(params: {
    invoiceId: string;
    clientId: string;
    condominiumId: string;
    amount: number;
    invoiceNumber: string;
    userEmail: string;
    description?: string;
    successUrl: string;
    cancelUrl: string;
  }) {
    try {
      const {
        invoiceId,
        clientId,
        condominiumId,
        amount,
        invoiceNumber,
        userEmail,
        description = 'Pago de factura',
        successUrl,
        cancelUrl,
      } = params;

      // Se asegura que las URLs no tengan espacios en blanco
      const trimmedSuccessUrl = successUrl.trim();
      const trimmedCancelUrl = cancelUrl.trim();

      // Verifica si la URL de éxito ya tiene parámetros
      // Si ya tiene ?, añade el session_id con &, de lo contrario usa ?
      const sessionIdParam = trimmedSuccessUrl.includes('?') ? '&' : '?';
      const formattedSuccessUrl = `${trimmedSuccessUrl}${sessionIdParam}session_id={CHECKOUT_SESSION_ID}`;

      // Crear una sesión de checkout
      const session = await this.stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'mxn',
              product_data: {
                name: `Factura #${invoiceNumber}`,
                description: description,
              },
              unit_amount: Math.round(amount * 100), // Convertir a centavos
            },
            quantity: 1,
          },
        ],
        metadata: {
          invoiceId,
          clientId,
          condominiumId,
          invoiceNumber,
        },
        customer_email: userEmail,
        success_url: formattedSuccessUrl,
        cancel_url: trimmedCancelUrl,
      });

      return { id: session.id, url: session.url };
    } catch (error) {
      this.logger.error(
        `Error al crear la sesión de pago: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Error al procesar la solicitud de pago',
      );
    }
  }
  /**
   * Verificar el estado de un pago mediante el ID de la sesión
   */
  async checkSessionStatus(sessionId: string) {
    try {
      const session = await this.stripe.checkout.sessions.retrieve(sessionId);
      return {
        status: session.payment_status,
        paymentIntent: session.payment_intent,
        metadata: session.metadata,
      };
    } catch (error) {
      this.logger.error(
        `Error al verificar el estado de la sesión: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Error al verificar el estado del pago',
      );
    }
  }

  /**
   * Guardar registro del evento de webhook para auditoría
   */
  private async logWebhookEvent(
    event: any,
    clientId: string,
    condominiumId: string,
  ) {
    try {
      // Crear un registro en Firestore con la nueva estructura
      await admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/stripeWebhookEventsClients`,
        )
        .doc(event.id)
        .set(
          {
            eventId: event.id,
            eventType: event.type,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            processed: true,
            payload: JSON.stringify(event), // Solo guardar campos relevantes en prod
          },
          { merge: true },
        );

      this.logger.log(
        `Evento ${event.id} registrado en Firestore para auditoría`,
      );
    } catch (error) {
      this.logger.error(
        `Error al registrar evento en Firestore: ${error.message}`,
      );
      // No lanzamos error para no interrumpir el flujo principal
    }
  }

  /**
   * Procesar evento de webhook de Stripe
   */
  async processWebhookEvent(
    signature: string,
    payload: Buffer | string,
    clientId?: string,
    condominiumId?: string,
  ) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const maxWebhookAgeSeconds = 300; // 5 minutos de tolerancia

    this.logger.log(
      `Webhook secret configurado: ${webhookSecret ? 'Sí' : 'No'}`,
    );

    try {
      if (!webhookSecret) {
        // En producción, esto debería ser un error
        // Pero en desarrollo, podemos permitir que continúe para propósitos de prueba
        this.logger.warn(
          'WARNING: No se ha configurado STRIPE_WEBHOOK_SECRET. La validación de webhooks está deshabilitada.',
        );

        // Intentamos parsear el payload si es un Buffer o string
        const payloadStr = Buffer.isBuffer(payload)
          ? payload.toString('utf8')
          : typeof payload === 'string'
            ? payload
            : JSON.stringify(payload);

        try {
          // Intentar parsear como JSON
          const event = JSON.parse(payloadStr);
          this.logger.log(
            `Evento sin verificar: ${event.type || 'desconocido'}`,
          );

          // Manejar el evento sin verificación de firma (SOLO EN DESARROLLO)
          if (
            event.type === 'checkout.session.completed' &&
            event.data &&
            event.data.object
          ) {
            await this.handleCheckoutSessionCompleted(event.data.object);
          } else if (
            event.type === 'invoice.payment_succeeded' &&
            event.data &&
            event.data.object
          ) {
            await this.handleInvoicePaymentSucceeded(event.data.object);
          } else if (
            event.type === 'invoice.payment_failed' &&
            event.data &&
            event.data.object
          ) {
            await this.handleInvoicePaymentFailed(event.data.object);
          }

          return { received: true, verified: false };
        } catch (parseError) {
          throw new Error(`Error al parsear el payload: ${parseError.message}`);
        }
      }

      this.logger.log(`Verificando firma del webhook...`);

      // Asegurarnos de que payload sea Buffer o string
      let rawPayload = payload;
      if (!Buffer.isBuffer(payload) && typeof payload !== 'string') {
        this.logger.log(
          `Payload no es Buffer ni string, intentando convertir a string...`,
        );
        rawPayload = JSON.stringify(payload);
      }

      const event = this.stripe.webhooks.constructEvent(
        rawPayload,
        signature,
        webhookSecret,
      );

      // Verificar si el evento es demasiado antiguo
      const eventCreatedTime = event.created;
      const currentTime = Math.floor(Date.now() / 1000);
      if (currentTime - eventCreatedTime > maxWebhookAgeSeconds) {
        this.logger.warn(
          `Evento ${event.id} rechazado por antigüedad: ${currentTime - eventCreatedTime} segundos`,
        );
        return { received: true, rejected: true, reason: 'expired' };
      }

      this.logger.log(
        `Evento de Stripe verificado: ${event.type}, id: ${event.id}`,
      );

      const tenantContext = this.resolveStripeEventTenantContext(
        event,
        clientId,
        condominiumId,
      );

      let eventDocRef:
        | FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
        | null = null;

      if (tenantContext.clientId && tenantContext.condominiumId) {
        // Registrar el evento antes de procesarlo
        await this.logWebhookEvent(
          event,
          tenantContext.clientId,
          tenantContext.condominiumId,
        );

        eventDocRef = admin
          .firestore()
          .collection(
            `clients/${tenantContext.clientId}/condominiums/${tenantContext.condominiumId}/stripeWebhookEventsClients`,
          )
          .doc(event.id);

        // Verificar si ya procesamos este evento (idempotencia a nivel de evento)
        const eventDoc = await eventDocRef.get();
        if (eventDoc.exists && eventDoc.data()?.completed) {
          this.logger.log(`Evento ${event.id} ya fue procesado previamente`);
          return { received: true, alreadyProcessed: true };
        }
      } else {
        this.logger.warn(
          `Evento ${event.id} sin contexto de tenant explícito. Se procesa sin registro idempotente por tenant.`,
        );
      }

      // Manejar los diferentes tipos de eventos
      switch (event.type) {
        case 'checkout.session.completed':
          await this.handleCheckoutSessionCompleted(event.data.object);
          break;
        case 'checkout.session.expired':
          await this.handleCheckoutSessionExpired(event.data.object);
          break;
        case 'payment_intent.succeeded':
          await this.handlePaymentIntentSucceeded(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this.handlePaymentIntentFailed(event.data.object);
          break;
        case 'payment_intent.canceled':
          await this.handlePaymentIntentCanceled(event.data.object);
          break;
        case 'payment_intent.processing':
          await this.handlePaymentIntentProcessing(event.data.object);
          break;
        case 'charge.refunded':
          await this.handleChargeRefunded(event.data.object);
          break;
        case 'charge.refund.updated':
          await this.handleChargeRefundUpdated(event.data.object);
          break;
        case 'charge.dispute.created':
          await this.handleChargeDisputeCreated(event.data.object);
          break;
        case 'charge.dispute.closed':
          await this.handleChargeDisputeClosed(event.data.object);
          break;
        case 'invoice.finalized':
          await this.handleInvoiceFinalized(event.data.object);
          break;
        case 'invoice.payment_succeeded':
          await this.handleInvoicePaymentSucceeded(event.data.object);
          break;
        case 'invoice.payment_failed':
          await this.handleInvoicePaymentFailed(event.data.object);
          break;
        case 'invoice.voided':
          await this.handleInvoiceVoided(event.data.object);
          break;
        default:
          this.logger.log(`Evento no manejado: ${event.type}`);
      }

      if (eventDocRef) {
        await eventDocRef.set(
          {
            completed: true,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            processed: true,
          },
          { merge: true },
        );
      }

      return { received: true };
    } catch (error) {
      this.logger.error(
        `Error al procesar el webhook: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Error al procesar el webhook: ${error.message}`,
      );
    }
  }

  /**
   * Manejar el evento de sesión de checkout completada
   */
  private async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
  ) {
    try {
      this.logger.log(`Procesando sesión completada: ${session.id}`);
      const { invoiceId, clientId, condominiumId } = session.metadata || {};
      this.logger.log(
        `Metadatos: invoiceId=${invoiceId}, clientId=${clientId}, condominiumId=${condominiumId}`,
      );

      if (!invoiceId || !clientId || !condominiumId) {
        this.logger.error('Metadatos faltantes en la sesión de checkout');
        return;
      }

      // Obtener la factura en Firestore
      this.logger.log(`Buscando factura en Firestore: ${invoiceId}`);
      const invoiceRef = admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/invoicesGenerated`,
        )
        .doc(invoiceId);

      // Realizar la operación dentro de una transacción para garantizar atomicidad
      await admin.firestore().runTransaction(async (transaction) => {
        const invoiceDoc = await transaction.get(invoiceRef);

        if (!invoiceDoc.exists) {
          throw new Error(`No se encontró la factura con ID: ${invoiceId}`);
        }

        const invoiceData = invoiceDoc.data();

        // Verificar si la factura ya fue procesada (control de idempotencia)
        if (
          invoiceData.paymentStatus === 'paid' &&
          invoiceData.paymentSessionId === session.id
        ) {
          this.logger.log(
            `Esta sesión de pago ya fue procesada anteriormente: ${session.id}`,
          );
          return;
        }

        this.logger.log(`Factura encontrada, actualizando estado...`);

        // Actualizar dentro de la transacción
        transaction.update(invoiceRef, {
          paymentStatus: 'paid',
          status: 'paid', // Actualizar también el campo status para mantener coherencia
          paymentDate: admin.firestore.FieldValue.serverTimestamp(),
          paymentMethod: 'stripe',
          paymentSessionId: session.id,
          paymentIntentId: session.payment_intent,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        this.logger.log(
          `Estado de factura actualizado en transacción para: ${session.id}`,
        );
      });

      // Una vez completada la transacción, obtener datos actualizados
      const updatedInvoiceDoc = await invoiceRef.get();
      const invoiceData = updatedInvoiceDoc.data();

      // Verificar que el monto pagado coincide con el monto de la factura (tolerancia del 1%)
      const sessionAmount = session.amount_total / 100; // Stripe almacena en centavos
      const invoiceAmount = invoiceData.amount;
      const tolerance = invoiceAmount * 0.01; // 1% de tolerancia

      if (Math.abs(sessionAmount - invoiceAmount) > tolerance) {
        this.logger.warn(
          `Discrepancia de monto detectada: Factura=${invoiceAmount}, Pago=${sessionAmount}`,
        );

        // Registrar la discrepancia pero continuar el proceso
        await invoiceRef.update({
          amountDiscrepancy: true,
          expectedAmount: invoiceAmount,
          paidAmount: sessionAmount,
        });
      }

      // Obtener datos para enviar correo
      const userUID = invoiceData.userUID;

      if (!userUID) {
        this.logger.error('No se encontró el UID del usuario en la factura');
        return;
      }

      // Obtener datos del usuario
      const userDoc = await admin
        .firestore()
        .collection(`clients/${clientId}/condominiums/${condominiumId}/users`)
        .doc(userUID)
        .get();

      if (!userDoc.exists) {
        this.logger.error(`No se encontró el usuario con UID: ${userUID}`);
        return;
      }

      // Lógica para enviar correo solo una vez
      if (invoiceData.emailSent) {
        this.logger.log(
          `Ya se envió un correo para la sesión ${session.id}, omitiendo envío.`,
        );
        return;
      }

      const userData = userDoc.data();
      const userEmail = invoiceData.userEmail || userData.email;

      if (!userEmail) {
        this.logger.error('No se encontró email para enviar la confirmación');
        return;
      }

      // Enviar correo de confirmación
      await this.sendPaymentConfirmationEmailWithRetry({
        email: userEmail,
        name: userData.name,
        invoiceNumber: invoiceData.invoiceNumber,
        amount: invoiceData.amount,
        paymentDate: new Date(),
      });

      // Marcar en Firestore que el correo ya fue enviado
      await invoiceRef.update({
        emailSent: true,
        emailSentDate: admin.firestore.FieldValue.serverTimestamp(),
      });

      this.logger.log(
        `Correo de confirmación enviado y marcado como enviado en Firestore.`,
      );

      await this.tryClearBillingSuspension(clientId);
    } catch (error) {
      this.logger.error(
        `Error al procesar el pago completado: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de pago exitoso
   */
  private async handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent,
  ) {
    this.logger.log(`PaymentIntent exitoso: ${paymentIntent.id}`);
    // Podrías implementar lógica adicional aquí si es necesario
  }

  /**
   * Manejar el evento de pago fallido
   */
  private async handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
    this.logger.error(`PaymentIntent fallido: ${paymentIntent.id}`);
    // Podrías implementar lógica para notificar al usuario del fallo
  }

  /**
   * Sistema de reintentos con backoff exponencial
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    initialDelay: number = 300,
  ): Promise<T> {
    let retries = 0;
    let lastError: any;

    while (retries <= maxRetries) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Errores que no deberían reintentarse
        if (error.code === 'not-found' || error.code === 'permission-denied') {
          throw error;
        }

        retries++;

        if (retries > maxRetries) {
          this.logger.error(`Máximo de reintentos (${maxRetries}) alcanzado.`);
          throw lastError;
        }

        // Calcular delay con backoff exponencial y jitter (aleatorización)
        const delay =
          initialDelay * Math.pow(2, retries - 1) * (0.5 + Math.random());
        this.logger.log(
          `Reintentando operación en ${Math.round(delay)}ms (intento ${retries}/${maxRetries})...`,
        );

        // Esperar antes del siguiente reintento
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Nunca deberíamos llegar aquí, pero TypeScript necesita un valor de retorno
    throw lastError;
  }

  /**
   * Enviar correo de confirmación con reintentos
   */
  private async sendPaymentConfirmationEmailWithRetry(params: {
    email: string;
    name: string;
    invoiceNumber: string;
    amount: number;
    paymentDate: Date;
  }): Promise<void> {
    return this.withRetry(
      () => this.sendPaymentConfirmationEmail(params),
      3, // Máximo 3 reintentos
      500, // Delay inicial de 500ms
    );
  }

  /**
   * Enviar correo de confirmación de pago
   */
  private async sendPaymentConfirmationEmail(params: {
    email: string;
    name: string;
    invoiceNumber: string;
    amount: number;
    paymentDate: Date;
  }) {
    try {
      const { email, name, invoiceNumber, amount, paymentDate } = params;
      const {
        MailerSend,
        EmailParams,
        Sender,
        Recipient,
      } = require('mailersend');

      const mailerSend = new MailerSend({
        apiKey:
          process.env.MAILERSEND_API_KEY ||
          'mlsn.3611aa51c08f244faf71131ceb627e193d3f57183323b0cb39538532bd6abfa7',
      });

      // Formatear el monto a pesos
      const formattedAmount = new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: 'MXN',
        minimumFractionDigits: 2,
      }).format(amount);

      // Formatear la fecha
      const formattedDate = paymentDate.toLocaleDateString('es-MX', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });

      const emailHtml = `
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              body { font-family: 'Open Sans', sans-serif; margin:0; padding:0; background-color: #f6f6f6; }
              .container { width: 90%; max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 10px; padding: 20px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
              .header { background-color: #6366F1; padding: 20px; border-radius: 10px 10px 0 0; text-align: center; }
              .header img { width: 100px; height: auto; }
              .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
              .content { padding: 20px; }
              .details-table { width: 100%; border-collapse: collapse; }
              .details-table th, .details-table td { padding:8px; border-bottom: 1px solid #ddd; text-align: left; }
              .details-table th { background-color: #6366F1; color: #ffffff; text-align: left; }
              .details-table tr:nth-child(odd) { background-color: #f9f9f9; }
              .success-icon { text-align: center; font-size: 64px; color: #10B981; margin: 20px 0; }
              .footer { text-align: center; font-size: 14px; color: #666666; margin-top: 20px; }
              @media (max-width: 600px) {
                .header h1 { font-size: 20px; }
                .details-table th, .details-table td { font-size: 12px; padding: 5px; }
                .container { padding: 10px; }
              }
            </style>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,600;0,700;0,800&display=swap" rel="stylesheet">
          </head>
          <body>
            <div class="container">
              <div class="header">
                <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
                <h1>Pago Confirmado</h1>
              </div>
              <div class="content" style="padding:20px; background-color: #f6f6f6; margin-top:20px; border-radius: 10px;">
                <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${name || 'Residente'}</h2>
                <p style="color:#1a1a1a; font-size:16px;">Hemos recibido tu pago correctamente.</p>
                
                <div class="success-icon">✓</div>
                
                <table class="details-table">
                  <tr>
                    <th>Detalle</th>
                    <th>Información</th>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Folio de la factura</td>
                    <td>${invoiceNumber}</td>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Monto pagado</td>
                    <td>${formattedAmount}</td>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Fecha de pago</td>
                    <td>${formattedDate}</td>
                  </tr>
                  <tr>
                    <td style="font-weight:bold;">Método de pago</td>
                    <td>Tarjeta (Stripe)</td>
                  </tr>
                </table>
                
                <table style="width:100%;">
                  <tr>
                    <td>
                      <p style="font-size:12px;color:#ffffff;margin-top:20px; font-weight:bold; background-color: #6366F1;border-radius:10px;padding:20px;text-align:center">
                        ¡Gracias por tu pago!
                      </p>
                    </td>
                  </tr>
                </table>
              </div>
              <div class="footer">
                <div class="footer" style="background-color:#f6f6f6;border-radius:10px 10px 0 0;padding:10px;text-align:center; color:#1a1a1a">
                  <p>Modernidad y Eficacia en la Administración</p>
                  <p>Síguenos en nuestras redes sociales: 
                    <a href="URL_FACEBOOK" style="color:#6366F1; text-decoration:none;">Facebook</a> | 
                    <a href="URL_TWITTER" style="color:#6366F1; text-decoration:none;">Twitter</a> | 
                    <a href="URL_INSTAGRAM" style="color:#6366F1; text-decoration:none;">Instagram</a>
                  </p>
                  <p>Omnipixel</p>
                </div>
              </div>
            </div>
          </body>
        </html>
      `;

      const emailParams = new EmailParams()
        .setFrom(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setTo([new Recipient(email, name || 'Residente')])
        .setReplyTo(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setSubject(`Pago Confirmado - Factura #${invoiceNumber}`)
        .setHtml(emailHtml);

      await mailerSend.email.send(emailParams);
      this.logger.log(`Correo de confirmación enviado a ${email}`);
    } catch (error) {
      this.logger.error(
        `Error al enviar correo de confirmación: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de sesión de checkout expirada
   */
  private async handleCheckoutSessionExpired(session: Stripe.Checkout.Session) {
    try {
      this.logger.log(`Sesión expirada: ${session.id}`);
      const { invoiceId, clientId, condominiumId } = session.metadata || {};

      if (!invoiceId || !clientId || !condominiumId) {
        this.logger.error('Metadatos faltantes en la sesión expirada');
        return;
      }

      // Actualizar estado de la factura
      const invoiceRef = admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/invoicesGenerated`,
        )
        .doc(invoiceId);

      await invoiceRef.update({
        paymentStatus: 'expired',
        status: 'expired',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      this.logger.error(
        `Error al procesar sesión expirada: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de pago cancelado
   */
  private async handlePaymentIntentCanceled(
    paymentIntent: Stripe.PaymentIntent,
  ) {
    try {
      this.logger.log(`PaymentIntent cancelado: ${paymentIntent.id}`);
      // Aquí puedes implementar lógica adicional si es necesario
    } catch (error) {
      this.logger.error(
        `Error al procesar pago cancelado: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de pago en proceso
   */
  private async handlePaymentIntentProcessing(
    paymentIntent: Stripe.PaymentIntent,
  ) {
    try {
      this.logger.log(`PaymentIntent en proceso: ${paymentIntent.id}`);
      // Aquí puedes implementar lógica adicional si es necesario
    } catch (error) {
      this.logger.error(
        `Error al procesar pago en proceso: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de reembolso
   */
  private async handleChargeRefunded(charge: Stripe.Charge) {
    try {
      this.logger.log(`Cargo reembolsado: ${charge.id}`);
      const { invoiceId, clientId, condominiumId } = charge.metadata || {};

      if (!invoiceId || !clientId || !condominiumId) {
        this.logger.error('Metadatos faltantes en el cargo reembolsado');
        return;
      }

      // Actualizar estado de la factura
      const invoiceRef = admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/invoicesGenerated`,
        )
        .doc(invoiceId);

      await invoiceRef.update({
        paymentStatus: 'refunded',
        status: 'refunded',
        refundDate: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      this.logger.error(
        `Error al procesar reembolso: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de actualización de reembolso
   */
  private async handleChargeRefundUpdated(refund: Stripe.Refund) {
    try {
      this.logger.log(`Reembolso actualizado: ${refund.id}`);
      // Aquí puedes implementar lógica adicional si es necesario
    } catch (error) {
      this.logger.error(
        `Error al procesar actualización de reembolso: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de disputa creada
   */
  private async handleChargeDisputeCreated(dispute: Stripe.Dispute) {
    try {
      this.logger.log(`Disputa creada: ${dispute.id}`);
      const { invoiceId, clientId, condominiumId } = dispute.metadata || {};

      if (!invoiceId || !clientId || !condominiumId) {
        this.logger.error('Metadatos faltantes en la disputa');
        return;
      }

      // Actualizar estado de la factura
      const invoiceRef = admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/invoicesGenerated`,
        )
        .doc(invoiceId);

      await invoiceRef.update({
        paymentStatus: 'disputed',
        status: 'disputed',
        disputeCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      this.logger.error(
        `Error al procesar disputa creada: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Manejar el evento de disputa cerrada
   */
  private async handleChargeDisputeClosed(dispute: Stripe.Dispute) {
    try {
      this.logger.log(`Disputa cerrada: ${dispute.id}`);
      const { invoiceId, clientId, condominiumId } = dispute.metadata || {};

      if (!invoiceId || !clientId || !condominiumId) {
        this.logger.error('Metadatos faltantes en la disputa cerrada');
        return;
      }

      // Actualizar estado de la factura
      const invoiceRef = admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/invoicesGenerated`,
        )
        .doc(invoiceId);

      const updateData: any = {
        disputeClosedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Actualizar estado según el resultado de la disputa
      if (dispute.status === 'won') {
        updateData.paymentStatus = 'paid';
        updateData.status = 'paid';
      } else if (dispute.status === 'lost') {
        updateData.paymentStatus = 'refunded';
        updateData.status = 'refunded';
      }

      await invoiceRef.update(updateData);
    } catch (error) {
      this.logger.error(
        `Error al procesar disputa cerrada: ${error.message}`,
        error.stack,
      );
    }
  }

  private resolveInvoiceRefFromStripeInvoice(invoice: Stripe.Invoice) {
    const metadata = invoice.metadata || {};
    const invoiceId = metadata.invoiceId;
    const clientId = metadata.clientId;
    const condominiumId = metadata.condominiumId;

    if (!invoiceId || !clientId || !condominiumId) {
      return null;
    }

    return admin
      .firestore()
      .collection(
        `clients/${clientId}/condominiums/${condominiumId}/invoicesGenerated`,
      )
      .doc(invoiceId);
  }

  private async handleInvoiceFinalized(invoice: Stripe.Invoice) {
    try {
      const invoiceRef = this.resolveInvoiceRefFromStripeInvoice(invoice);
      if (!invoiceRef) {
        this.logger.warn(
          `No se pudo resolver factura Firestore para invoice.finalized id=${invoice.id}`,
        );
        return;
      }

      await invoiceRef.set(
        {
          stripeInvoiceId: invoice.id,
          stripeInvoiceStatus: invoice.status || 'open',
          stripeHostedInvoiceUrl: invoice.hosted_invoice_url || null,
          stripeInvoicePdf: invoice.invoice_pdf || null,
          paymentStatus: 'pending',
          status: 'pending',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error) {
      this.logger.error(
        `Error al procesar invoice.finalized: ${error.message}`,
        error.stack,
      );
    }
  }

  private async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
    try {
      const invoiceRef = this.resolveInvoiceRefFromStripeInvoice(invoice);
      if (!invoiceRef) {
        this.logger.warn(
          `No se pudo resolver factura Firestore para invoice.payment_succeeded id=${invoice.id}`,
        );
        return;
      }

      await invoiceRef.set(
        {
          stripeInvoiceId: invoice.id,
          stripeInvoiceStatus: invoice.status || 'paid',
          stripeHostedInvoiceUrl: invoice.hosted_invoice_url || null,
          stripeInvoicePdf: invoice.invoice_pdf || null,
          paymentStatus: 'paid',
          status: 'paid',
          paymentMethod: 'stripe_invoice',
          paymentDate: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      const metadata = invoice.metadata || {};
      if (metadata.clientId) {
        await this.tryClearBillingSuspension(String(metadata.clientId));
      }
    } catch (error) {
      this.logger.error(
        `Error al procesar invoice.payment_succeeded: ${error.message}`,
        error.stack,
      );
    }
  }

  private async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
    try {
      const invoiceRef = this.resolveInvoiceRefFromStripeInvoice(invoice);
      if (!invoiceRef) {
        this.logger.warn(
          `No se pudo resolver factura Firestore para invoice.payment_failed id=${invoice.id}`,
        );
        return;
      }

      await invoiceRef.set(
        {
          stripeInvoiceId: invoice.id,
          stripeInvoiceStatus: invoice.status || 'open',
          stripeHostedInvoiceUrl: invoice.hosted_invoice_url || null,
          stripeInvoicePdf: invoice.invoice_pdf || null,
          paymentStatus: 'failed',
          status: 'past_due',
          lastStripeError: 'invoice.payment_failed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error) {
      this.logger.error(
        `Error al procesar invoice.payment_failed: ${error.message}`,
        error.stack,
      );
    }
  }

  private async handleInvoiceVoided(invoice: Stripe.Invoice) {
    try {
      const invoiceRef = this.resolveInvoiceRefFromStripeInvoice(invoice);
      if (!invoiceRef) {
        this.logger.warn(
          `No se pudo resolver factura Firestore para invoice.voided id=${invoice.id}`,
        );
        return;
      }

      await invoiceRef.set(
        {
          stripeInvoiceId: invoice.id,
          stripeInvoiceStatus: invoice.status || 'void',
          paymentStatus: 'voided',
          status: 'voided',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      const metadata = invoice.metadata || {};
      if (metadata.clientId) {
        await this.tryClearBillingSuspension(String(metadata.clientId));
      }
    } catch (error) {
      this.logger.error(
        `Error al procesar invoice.voided: ${error.message}`,
        error.stack,
      );
    }
  }

  private resolveStripeEventTenantContext(
    event: Stripe.Event,
    fallbackClientId?: string,
    fallbackCondominiumId?: string,
  ): { clientId: string | null; condominiumId: string | null } {
    const metadata = (event?.data?.object as any)?.metadata || {};
    const clientId =
      this.safeString(metadata.clientId) || this.safeString(fallbackClientId);
    const condominiumId =
      this.safeString(metadata.condominiumId) ||
      this.safeString(fallbackCondominiumId);

    return {
      clientId: clientId || null,
      condominiumId: condominiumId || null,
    };
  }

  private safeString(value: any): string {
    if (value === undefined || value === null) {
      return '';
    }
    return String(value).trim();
  }

  private getDelinquentInvoiceStatuses(): string[] {
    return ['pending', 'failed', 'expired', 'past_due'];
  }

  private extractTenantFromInvoicePath(path: string): {
    clientId: string | null;
    condominiumId: string | null;
  } {
    const parts = path.split('/');
    if (parts.length >= 6 && parts[0] === 'clients' && parts[2] === 'condominiums') {
      return {
        clientId: parts[1] || null,
        condominiumId: parts[3] || null,
      };
    }

    return {
      clientId: null,
      condominiumId: null,
    };
  }

  private async applyBillingSuspension(
    clientId: string,
    overdueInfo: {
      condominiumId: string;
      invoiceId: string;
      dueDate?: any;
      paymentStatus?: string;
      periodKey?: string;
    },
  ): Promise<void> {
    const clientRef = admin.firestore().collection('clients').doc(clientId);
    const clientDoc = await clientRef.get();
    if (!clientDoc.exists) {
      return;
    }

    const clientData = clientDoc.data() || {};
    const currentStatus = String(clientData.status || 'active').toLowerCase();
    const updateData: Record<string, any> = {
      billingDelinquent: true,
      billingSuspensionReason: 'invoice_overdue_30_days',
      billingDelinquentSince:
        clientData.billingDelinquentSince ||
        admin.firestore.FieldValue.serverTimestamp(),
      lastOverdueInvoice: {
        invoiceId: overdueInfo.invoiceId,
        condominiumId: overdueInfo.condominiumId,
        periodKey: overdueInfo.periodKey || null,
        paymentStatus: overdueInfo.paymentStatus || null,
        dueDate: overdueInfo.dueDate || null,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (currentStatus !== 'blocked' && currentStatus !== 'suspended') {
      updateData.status = 'suspended';
      updateData.suspendedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    const ownerUid = this.safeString(clientData.ownerAdminUid);
    if (ownerUid) {
      try {
        const ownerUser = await admin.auth().getUser(ownerUid);
        if (!ownerUser.disabled) {
          await admin.auth().updateUser(ownerUid, { disabled: true });
        }

        await admin.auth().setCustomUserClaims(ownerUid, {
          ...(ownerUser.customClaims || {}),
          accountSuspended: true,
          accountSuspensionReason: 'invoice_overdue_30_days',
        });

        updateData.authDisabledByBilling = true;
        updateData.authDisabledByBillingAt =
          admin.firestore.FieldValue.serverTimestamp();
      } catch (error) {
        this.logger.error(
          `No se pudo desactivar Auth para ownerAdminUid=${ownerUid} clientId=${clientId}: ${error.message}`,
        );
      }
    }

    await clientRef.set(updateData, { merge: true });
  }

  private async tryClearBillingSuspension(
    clientId: string,
    thresholdTs?: FirebaseFirestore.Timestamp,
  ): Promise<void> {
    const clientRef = admin.firestore().collection('clients').doc(clientId);
    const clientDoc = await clientRef.get();
    if (!clientDoc.exists) {
      return;
    }

    const clientData = clientDoc.data() || {};
    if (!clientData.billingDelinquent) {
      return;
    }

    const effectiveThreshold =
      thresholdTs ||
      admin.firestore.Timestamp.fromDate(
        new Date(Date.now() - this.overdueSuspensionDays * 24 * 60 * 60 * 1000),
      );

    const stillOverdue = await admin
      .firestore()
      .collectionGroup('invoicesGenerated')
      .where('clientId', '==', clientId)
      .where('paymentStatus', 'in', this.getDelinquentInvoiceStatuses())
      .where('dueDate', '<=', effectiveThreshold)
      .limit(1)
      .get();

    if (!stillOverdue.empty) {
      return;
    }

    const updateData: Record<string, any> = {
      billingDelinquent: false,
      billingSuspensionReason: admin.firestore.FieldValue.delete(),
      billingDelinquentSince: admin.firestore.FieldValue.delete(),
      lastOverdueInvoice: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const isBillingSuspension =
      String(clientData.billingSuspensionReason || '').toLowerCase() ===
      'invoice_overdue_30_days';
    const currentStatus = String(clientData.status || '').toLowerCase();
    if (isBillingSuspension && currentStatus === 'suspended') {
      updateData.status = 'active';
      updateData.suspendedAt = admin.firestore.FieldValue.delete();
      updateData.reactivatedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    const ownerUid = this.safeString(clientData.ownerAdminUid);
    const authDisabledByBilling = clientData.authDisabledByBilling === true;
    if (ownerUid && authDisabledByBilling) {
      try {
        const ownerUser = await admin.auth().getUser(ownerUid);
        if (ownerUser.disabled) {
          await admin.auth().updateUser(ownerUid, { disabled: false });
        }

        await admin.auth().setCustomUserClaims(ownerUid, {
          ...(ownerUser.customClaims || {}),
          accountSuspended: false,
          accountSuspensionReason: null,
        });

        updateData.authDisabledByBilling = false;
        updateData.authDisabledByBillingAt =
          admin.firestore.FieldValue.delete();
      } catch (error) {
        this.logger.error(
          `No se pudo reactivar Auth para ownerAdminUid=${ownerUid} clientId=${clientId}: ${error.message}`,
        );
      }
    }

    await clientRef.set(updateData, { merge: true });
  }

  private async emitInvoicePendingNotificationEvent(params: {
    clientId: string;
    condominiumId: string;
    invoiceId: string;
    invoiceNumber: string;
    amount: number;
    dueDate: Date;
    userUID: string | null;
    periodKey: string;
  }): Promise<void> {
    const emitEvent =
      String(process.env.INVOICE_EMIT_NOTIFICATION_EVENT || '').toLowerCase() ===
      'true';
    if (!emitEvent) {
      return;
    }

    const {
      clientId,
      condominiumId,
      invoiceId,
      invoiceNumber,
      amount,
      dueDate,
      userUID,
      periodKey,
    } = params;

    try {
      const dueDateIso = dueDate.toISOString();
      const title = `Factura pendiente #${invoiceNumber}`;
      const body = `Se generó una factura por ${amount.toFixed(2)} MXN con vencimiento ${dueDateIso.slice(0, 10)}.`;

      await admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/notificationEvents`,
        )
        .add({
          eventType: 'finance.invoice_pending_payment',
          module: 'finance',
          priority: 'critical',
          title,
          body,
          dedupeKey: `finance:invoice:${invoiceId}:pending`,
          channels: ['in_app'],
          audience:
            userUID && String(userUID).trim()
              ? { scope: 'specific_users', userIds: [String(userUID)] }
              : { scope: 'admins_and_assistants', userIds: [] },
          entityId: invoiceId,
          entityType: 'invoice_generated',
          metadata: {
            invoiceId,
            invoiceNumber,
            amount,
            dueDate: dueDateIso,
            periodKey,
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: userUID || 'system',
          createdByName: 'Billing Scheduler',
          status: 'pending_dispatch',
          clientId,
          condominiumId,
        });
    } catch (error) {
      this.logger.error(
        `No se pudo emitir notificationEvent de factura clientId=${clientId}: ${error.message}`,
      );
    }
  }

  private normalizeBillingFrequency(value: any):
    | 'monthly'
    | 'quarterly'
    | 'biannual'
    | 'annual' {
    const allowed = new Set(['monthly', 'quarterly', 'biannual', 'annual']);
    const normalized = String(value || 'monthly').toLowerCase().trim();
    return allowed.has(normalized)
      ? (normalized as 'monthly' | 'quarterly' | 'biannual' | 'annual')
      : 'monthly';
  }

  private normalizeCurrency(value: any): string {
    const normalized = String(value || 'MXN').trim().toUpperCase();
    return normalized || 'MXN';
  }

  private parsePricingAmount(value: any): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 0 ? Number(value) : 0;
    }

    if (typeof value === 'string') {
      const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return 0;
  }

  private resolveDueDays(): number {
    const envValue = Number(process.env.BILLING_INVOICE_DUE_DAYS || '');
    if (Number.isFinite(envValue) && envValue > 0) {
      return Math.floor(envValue);
    }
    return this.billingDueDays;
  }

  private resolveAnchorDay(clientData: Record<string, any>, fallback: Date): number {
    const fromClient = Number(clientData?.billingAnchorDay);
    if (Number.isFinite(fromClient) && fromClient >= 1 && fromClient <= 31) {
      return Math.floor(fromClient);
    }
    return fallback.getDate();
  }

  private resolveDefaultCondominiumId(clientData: Record<string, any>): string | null {
    if (
      clientData?.defaultCondominiumId &&
      String(clientData.defaultCondominiumId).trim()
    ) {
      return String(clientData.defaultCondominiumId).trim();
    }

    if (
      Array.isArray(clientData?.condominiumsUids) &&
      clientData.condominiumsUids.length > 0
    ) {
      return String(clientData.condominiumsUids[0] || '').trim() || null;
    }

    return null;
  }

  private resolveNextBillingDate(clientData: Record<string, any>, fallback: Date): Date {
    const nextBillingDate = clientData?.nextBillingDate;
    if (nextBillingDate?.toDate && typeof nextBillingDate.toDate === 'function') {
      return nextBillingDate.toDate();
    }
    return fallback;
  }

  private getBillingIntervalMonths(
    billingFrequency: 'monthly' | 'quarterly' | 'biannual' | 'annual',
  ): number {
    switch (billingFrequency) {
      case 'quarterly':
        return 3;
      case 'biannual':
        return 6;
      case 'annual':
        return 12;
      default:
        return 1;
    }
  }

  private addBillingInterval(
    baseDate: Date,
    billingFrequency: 'monthly' | 'quarterly' | 'biannual' | 'annual',
    anchorDay: number,
  ): Date {
    const monthsToAdd = this.getBillingIntervalMonths(billingFrequency);
    const year = baseDate.getUTCFullYear();
    const month = baseDate.getUTCMonth() + monthsToAdd;
    const result = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const maxDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
    result.setUTCDate(Math.min(anchorDay, maxDay));
    return result;
  }

  private buildPeriodKey(
    date: Date,
    billingFrequency: 'monthly' | 'quarterly' | 'biannual' | 'annual',
  ): string {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;

    if (billingFrequency === 'annual') {
      return `${year}`;
    }

    if (billingFrequency === 'biannual') {
      return `${year}-H${month <= 6 ? '1' : '2'}`;
    }

    if (billingFrequency === 'quarterly') {
      return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
    }

    return `${year}-${String(month).padStart(2, '0')}`;
  }

  private formatInvoiceNumber(date: Date, clientId: string): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const suffix = clientId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
    const sequence = String(date.getUTCDate()).padStart(2, '0');
    return `EA-${year}${month}-${suffix}${sequence}`;
  }

  private async ensureStripeCustomer(params: {
    clientRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
    clientId: string;
    clientData: Record<string, any>;
  }): Promise<string | null> {
    const { clientRef, clientId, clientData } = params;
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      return null;
    }

    if (clientData?.stripeCustomerId) {
      return String(clientData.stripeCustomerId);
    }

    try {
      const customerName =
        String(clientData.companyName || '').trim() ||
        [
          String(clientData.responsiblePersonName || '').trim(),
          String(clientData.responsiblePersonPosition || '').trim(),
        ]
          .filter(Boolean)
          .join(' ') ||
        String(clientData.email || '').trim();

      const customer = await this.stripe.customers.create({
        name: customerName || undefined,
        email: clientData.email || undefined,
        phone: clientData.phoneNumber || undefined,
        metadata: {
          clientId,
          RFC: String(clientData.RFC || ''),
          country: String(clientData.country || ''),
        },
      });

      await clientRef.set(
        {
          stripeCustomerId: customer.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return customer.id;
    } catch (error) {
      this.logger.error(
        `No se pudo crear customer en Stripe para clientId=${clientId}: ${error.message}`,
      );
      return null;
    }
  }

  private async createAutomatedInvoiceForPeriod(params: {
    clientId: string;
    condominiumId: string;
    adminUid: string | null;
    adminEmail: string | null;
    issueDate: Date;
    periodDate: Date;
    billingFrequency: 'monthly' | 'quarterly' | 'biannual' | 'annual';
    amount: number;
    currency: string;
    plan: string;
    source: 'auto_initial_registration' | 'auto_scheduler';
    dueDays: number;
    clientData: Record<string, any>;
  }) {
    const {
      clientId,
      condominiumId,
      adminUid,
      adminEmail,
      issueDate,
      periodDate,
      billingFrequency,
      amount,
      currency,
      plan,
      source,
      dueDays,
      clientData,
    } = params;

    const periodKey = this.buildPeriodKey(periodDate, billingFrequency);
    const billingDedupeKey = `client:${clientId}:period:${periodKey}`;
    const invoiceCollectionRef = admin
      .firestore()
      .collection(
        `clients/${clientId}/condominiums/${condominiumId}/invoicesGenerated`,
      );

    const existingInvoiceSnap = await invoiceCollectionRef
      .where('billingDedupeKey', '==', billingDedupeKey)
      .limit(1)
      .get();

    if (!existingInvoiceSnap.empty) {
      return {
        deduped: true,
        invoiceId: existingInvoiceSnap.docs[0].id,
        periodKey,
      };
    }

    const dueDate = new Date(issueDate);
    dueDate.setUTCDate(dueDate.getUTCDate() + Math.max(1, dueDays));
    const invoiceNumber = this.formatInvoiceNumber(issueDate, clientId);
    const invoiceRef = invoiceCollectionRef.doc();

    const invoicePayload: Record<string, any> = {
      invoiceNumber,
      concept: 'Servicio mensual de administración',
      amount,
      currency,
      periodKey,
      billingFrequency,
      billingDedupeKey,
      source,
      plan: plan || '',
      pricingSnapshot: amount,
      paymentStatus: 'pending',
      status: 'pending',
      issueDate: admin.firestore.Timestamp.fromDate(issueDate),
      dueDate: admin.firestore.Timestamp.fromDate(dueDate),
      clientId,
      condominiumId,
      userUID: adminUid || null,
      userEmail: adminEmail || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await invoiceRef.set(invoicePayload, { merge: true });

    const clientRef = admin.firestore().collection('clients').doc(clientId);
    const stripeCustomerId = await this.ensureStripeCustomer({
      clientRef,
      clientId,
      clientData,
    });

    if (stripeCustomerId) {
      try {
        const unitAmount = Math.round(amount * 100);
        const metadata = {
          invoiceId: invoiceRef.id,
          clientId,
          condominiumId,
          invoiceNumber,
          periodKey,
        };

        await this.stripe.invoiceItems.create(
          {
            customer: stripeCustomerId,
            currency: currency.toLowerCase(),
            amount: unitAmount,
            description: `Factura ${periodKey} - ${invoiceNumber}`,
            metadata,
          },
          {
            idempotencyKey: `${billingDedupeKey}:invoice-item`,
          },
        );

        const stripeInvoice = await this.stripe.invoices.create(
          {
            customer: stripeCustomerId,
            collection_method: 'send_invoice',
            days_until_due: Math.max(1, dueDays),
            auto_advance: true,
            metadata,
          },
          {
            idempotencyKey: `${billingDedupeKey}:invoice`,
          },
        );

        const finalizedInvoice = await this.stripe.invoices.finalizeInvoice(
          stripeInvoice.id,
        );

        await invoiceRef.set(
          {
            stripeCustomerId,
            stripeInvoiceId: finalizedInvoice.id,
            stripeInvoiceStatus: finalizedInvoice.status || null,
            stripeHostedInvoiceUrl: finalizedInvoice.hosted_invoice_url || null,
            stripeInvoicePdf: finalizedInvoice.invoice_pdf || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } catch (stripeError) {
        this.logger.error(
          `Error al crear factura Stripe clientId=${clientId} invoiceId=${invoiceRef.id}: ${stripeError?.message || stripeError}`,
          stripeError?.stack,
        );

        await invoiceRef.set(
          {
            stripeSyncError: stripeError?.message || String(stripeError),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    }

    await this.emitInvoicePendingNotificationEvent({
      clientId,
      condominiumId,
      invoiceId: invoiceRef.id,
      invoiceNumber,
      amount,
      dueDate,
      userUID: adminUid,
      periodKey,
    });

    return {
      deduped: false,
      invoiceId: invoiceRef.id,
      periodKey,
      invoiceNumber,
    };
  }

  private async acquireBillingLock(ttlMs: number): Promise<boolean> {
    return this.acquireNamedLock(this.billingLockId, ttlMs);
  }

  private async releaseBillingLock(): Promise<void> {
    await this.releaseNamedLock(this.billingLockId);
  }

  private async acquireNamedLock(
    lockId: string,
    ttlMs: number,
  ): Promise<boolean> {
    const lockRef = admin.firestore().collection('jobLocks').doc(lockId);
    const nowMs = Date.now();
    const lockUntilMs = nowMs + ttlMs;

    try {
      const lockAcquired = await admin.firestore().runTransaction(async (tx) => {
        const lockDoc = await tx.get(lockRef);
        const currentLockUntil = lockDoc.data()?.lockUntil;
        const currentLockMs =
          currentLockUntil?.toMillis && typeof currentLockUntil.toMillis === 'function'
            ? currentLockUntil.toMillis()
            : 0;

        if (currentLockMs > nowMs) {
          return false;
        }

        tx.set(
          lockRef,
          {
            lockUntil: admin.firestore.Timestamp.fromMillis(lockUntilMs),
            worker: process.env.HOSTNAME || 'stripe-billing-cron',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return true;
      });

      return lockAcquired;
    } catch (error) {
      this.logger.error(
        `No se pudo adquirir lock "${lockId}": ${error.message}`,
      );
      return false;
    }
  }

  private async releaseNamedLock(lockId: string): Promise<void> {
    try {
      await admin
        .firestore()
        .collection('jobLocks')
        .doc(lockId)
        .set(
          {
            lockUntil: admin.firestore.Timestamp.fromMillis(Date.now()),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch (error) {
      this.logger.error(`No se pudo liberar lock "${lockId}": ${error.message}`);
    }
  }
}
