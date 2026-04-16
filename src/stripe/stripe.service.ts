import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

type BillingFrequency = 'monthly' | 'quarterly' | 'biannual' | 'annual';
type InvoiceSource = 'auto_initial_registration' | 'auto_scheduler';
type AutomatedInvoiceType = 'subscription' | 'maintenance_app';

interface CondominiumBillingConfig {
  amount: number;
  currency: string;
  plan: string;
  billingFrequency: BillingFrequency;
  condominiumLimit: number | null;
  sourceData: Record<string, any>;
  condominiumData: Record<string, any>;
}

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);
  private readonly billingLockId = 'client-auto-billing-cron-lock';
  private readonly billingCronBatchSize = 100;
  private readonly billingDueDays = 30;
  private readonly suspensionLockId = 'client-billing-suspension-cron-lock';
  private readonly overdueSuspensionDays = 30;
  private readonly mxVatRatePercent = 16;
  private mxVatTaxRateIdCache: string | null = null;
  private readonly defaultBillingCurrency = 'MXN';
  private readonly billingIntervalOverrideDays: number | null;
  private readonly maintenanceAppDefaultCurrency = 'MXN';
  private readonly maintenanceAppMonthlyPriceTotalMxn: number;

  constructor() {
    // Inicializar Stripe con la clave secreta
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      apiVersion: '2025-03-31.basil',
    });
    this.billingIntervalOverrideDays = this.parseBillingIntervalOverrideDays(
      process.env.BILLING_TEST_INTERVAL_DAYS,
    );
    if (this.billingIntervalOverrideDays) {
      this.logger.warn(
        `BILLING_TEST_INTERVAL_DAYS activo: ${this.billingIntervalOverrideDays} día(s).`,
      );
    }
    this.maintenanceAppMonthlyPriceTotalMxn =
      this.resolveMaintenanceAppMonthlyPriceTotalMxn();
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
    const anchorDay = this.resolveAnchorDay(clientData, issueDate);
    const dueDays = this.resolveDueDays();
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

    const condominiumBillingConfig = await this.resolveCondominiumBillingConfig(
      {
        clientId,
        condominiumId: effectiveCondominiumId,
        clientData,
      },
    );
    const condominiumName = this.resolveCondominiumDisplayName(
      condominiumBillingConfig.condominiumData,
      effectiveCondominiumId,
    );
    const billingResults =
      await this.createAutomatedInvoicesForCondominiumPeriod({
        clientId,
        condominiumId: effectiveCondominiumId,
        condominiumName,
        condominiumBillingConfig,
        adminUid: adminUid || clientData.ownerAdminUid || null,
        adminEmail: clientData.ownerEmail || clientData.email || null,
        issueDate,
        periodDate: issueDate,
        source: 'auto_initial_registration',
        dueDays,
        clientData,
      });

    const schedulerBillingFrequency = this.resolveClientSchedulerBillingFrequency(
      [
        {
          condominiumBillingConfig,
        },
      ],
    );

    const nextBillingDate = this.addBillingInterval(
      issueDate,
      schedulerBillingFrequency,
      anchorDay,
    );
    await clientRef.set(
      {
        status: clientData.status || 'active',
        billingAnchorDay: anchorDay,
        nextBillingDate: admin.firestore.Timestamp.fromDate(nextBillingDate),
        defaultCondominiumId:
          clientData.defaultCondominiumId || effectiveCondominiumId,
        ownerAdminUid: adminUid || clientData.ownerAdminUid || null,
        ownerEmail: clientData.ownerEmail || clientData.email || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (billingResults.length === 0) {
      return {
        success: false,
        message:
          'Cliente registrado. La facturación inicial se omitió por pricing inválido o cero.',
        nextBillingDate: nextBillingDate.toISOString(),
      };
    }

    const primaryBillingResult = billingResults[0];
    return {
      success: true,
      message: 'Facturación inicial procesada',
      ...primaryBillingResult,
      generatedInvoices: billingResults,
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
          const clientStatus = String(
            clientData.status || 'active',
          ).toLowerCase();
          if (clientStatus === 'suspended' || clientStatus === 'inactive') {
            continue;
          }

          const anchorDay = this.resolveAnchorDay(clientData, now);
          const dueDays = this.resolveDueDays();
          const adminUid = clientData.ownerAdminUid || null;
          const adminEmail = clientData.ownerEmail || clientData.email || null;
          const condominiumsToBill =
            await this.resolveClientCondominiumsForBilling({
              clientId: clientDoc.id,
              clientData,
            });

          if (condominiumsToBill.length === 0) {
            this.logger.warn(
              `No se encontraron condominios para facturación recurrente de clientId=${clientDoc.id}`,
            );
            continue;
          }

          const condominiumBillingEntries = await Promise.all(
            condominiumsToBill.map(async (condominiumEntry) => {
              const condominiumBillingConfig =
                await this.resolveCondominiumBillingConfig({
                  clientId: clientDoc.id,
                  condominiumId: condominiumEntry.condominiumId,
                  clientData,
                  condominiumData: condominiumEntry.condominiumData,
                });

              return {
                condominiumId: condominiumEntry.condominiumId,
                condominiumName: this.resolveCondominiumDisplayName(
                  condominiumBillingConfig.condominiumData,
                  condominiumEntry.condominiumId,
                ),
                condominiumBillingConfig,
              };
            }),
          );

          const schedulerBillingFrequency =
            this.resolveClientSchedulerBillingFrequency(condominiumBillingEntries);

          const nextBillingDate = this.resolveNextBillingDate(clientData, now);
          let cursor = nextBillingDate;
          let iterations = 0;
          const maxIterations = this.resolveBillingIntervalOverrideDays()
            ? 365
            : 12;

          while (
            cursor.getTime() <= now.getTime() &&
            iterations < maxIterations
          ) {
            for (const condominiumEntry of condominiumBillingEntries) {
              await this.createAutomatedInvoicesForCondominiumPeriod({
                clientId: clientDoc.id,
                condominiumId: condominiumEntry.condominiumId,
                condominiumName: condominiumEntry.condominiumName,
                condominiumBillingConfig:
                  condominiumEntry.condominiumBillingConfig,
                adminUid,
                adminEmail,
                issueDate: cursor,
                periodDate: cursor,
                source: 'auto_scheduler',
                dueDays,
                clientData,
              });
            }

            cursor = this.addBillingInterval(
              cursor,
              schedulerBillingFrequency,
              anchorDay,
            );
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
          const cErr =
            clientError instanceof Error
              ? clientError
              : new Error(String(clientError));
          this.logger.error(
            `Error en facturación recurrente para clientId=${clientDoc.id}: ${cErr.message}`,
            cErr.stack,
          );
        }
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error en scheduler de facturación recurrente: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al ejecutar suspensión automática por mora: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al crear la sesión de pago: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al verificar el estado de la sesión: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al registrar evento en Firestore: ${err.message}`,
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
          const pErr =
            parseError instanceof Error
              ? parseError
              : new Error(String(parseError));
          throw new Error(`Error al parsear el payload: ${pErr.message}`);
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

      let eventDocRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData> | null =
        null;

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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar el webhook: ${err.message}`,
        err.stack,
      );
      throw new BadRequestException(
        `Error al procesar el webhook: ${err.message}`,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar el pago completado: ${err.message}`,
        err.stack,
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
        if (
          (error as any).code === 'not-found' ||
          (error as any).code === 'permission-denied'
        ) {
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al enviar correo de confirmación: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar sesión expirada: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar pago cancelado: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar pago en proceso: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar reembolso: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar actualización de reembolso: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar disputa creada: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar disputa cerrada: ${err.message}`,
        err.stack,
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

      const metadata = invoice.metadata || {};
      const storedPdf = await this.persistStripeInvoicePdfToStorage({
        clientId: String(metadata.clientId || ''),
        condominiumId: String(metadata.condominiumId || ''),
        invoiceId: String(metadata.invoiceId || ''),
        stripeInvoiceId: invoice.id,
        invoicePdfUrl: invoice.invoice_pdf || null,
      });

      await invoiceRef.set(
        {
          stripeInvoiceId: invoice.id,
          stripeInvoiceStatus: invoice.status || 'open',
          stripeHostedInvoiceUrl: invoice.hosted_invoice_url || null,
          stripeInvoicePdf: invoice.invoice_pdf || null,
          invoicePdfStoragePath: storedPdf?.storagePath || null,
          invoicePdfStorageUrl: storedPdf?.storageUrl || null,
          paymentStatus: 'pending',
          status: 'pending',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar invoice.finalized: ${err.message}`,
        err.stack,
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

      const metadata = invoice.metadata || {};
      const storedPdf = await this.persistStripeInvoicePdfToStorage({
        clientId: String(metadata.clientId || ''),
        condominiumId: String(metadata.condominiumId || ''),
        invoiceId: String(metadata.invoiceId || ''),
        stripeInvoiceId: invoice.id,
        invoicePdfUrl: invoice.invoice_pdf || null,
      });

      await invoiceRef.set(
        {
          stripeInvoiceId: invoice.id,
          stripeInvoiceStatus: invoice.status || 'paid',
          stripeHostedInvoiceUrl: invoice.hosted_invoice_url || null,
          stripeInvoicePdf: invoice.invoice_pdf || null,
          invoicePdfStoragePath: storedPdf?.storagePath || null,
          invoicePdfStorageUrl: storedPdf?.storageUrl || null,
          paymentStatus: 'paid',
          status: 'paid',
          paymentMethod: 'stripe_invoice',
          paymentDate: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (metadata.clientId) {
        await this.tryClearBillingSuspension(String(metadata.clientId));
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar invoice.payment_succeeded: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar invoice.payment_failed: ${err.message}`,
        err.stack,
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Error al procesar invoice.voided: ${err.message}`,
        err.stack,
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
    if (
      parts.length >= 6 &&
      parts[0] === 'clients' &&
      parts[2] === 'condominiums'
    ) {
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
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `No se pudo desactivar Auth para ownerAdminUid=${ownerUid} clientId=${clientId}: ${err.message}`,
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
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          `No se pudo reactivar Auth para ownerAdminUid=${ownerUid} clientId=${clientId}: ${err.message}`,
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
      String(
        process.env.INVOICE_EMIT_NOTIFICATION_EVENT || '',
      ).toLowerCase() === 'true';
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `No se pudo emitir notificationEvent de factura clientId=${clientId}: ${err.message}`,
      );
    }
  }

  private async persistStripeInvoicePdfToStorage(params: {
    clientId: string;
    condominiumId: string;
    invoiceId: string;
    stripeInvoiceId: string;
    invoicePdfUrl: string | null;
  }): Promise<{ storagePath: string; storageUrl: string } | null> {
    const {
      clientId,
      condominiumId,
      invoiceId,
      stripeInvoiceId,
      invoicePdfUrl,
    } = params;

    if (!invoicePdfUrl || !clientId || !condominiumId || !invoiceId) {
      return null;
    }

    try {
      const bucketName =
        process.env.FIREBASE_STORAGE_BUCKET ||
        process.env.STORAGE_BUCKET ||
        'administracioncondominio-93419.appspot.com';
      const bucket = admin.storage().bucket(bucketName);
      const safeInvoiceId = invoiceId.replace(/[^a-zA-Z0-9-_]/g, '');
      const storagePath = `clients/${clientId}/condominiums/${condominiumId}/invoices/${safeInvoiceId}.pdf`;
      const file = bucket.file(storagePath);

      const [alreadyExists] = await file.exists();
      if (!alreadyExists) {
        const response = await axios.get(invoicePdfUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
        });
        const pdfBuffer = Buffer.from(response.data);

        await file.save(pdfBuffer, {
          resumable: false,
          contentType: 'application/pdf',
          metadata: {
            cacheControl: 'private, max-age=3600',
            metadata: {
              stripeInvoiceId,
              source: 'stripe_invoice_pdf',
            },
          },
        });

        try {
          await file.makePublic();
        } catch (publicError) {
          this.logger.warn(
            `No se pudo hacer público el PDF de factura ${invoiceId}: ${publicError instanceof Error ? publicError.message : String(publicError)}`,
          );
        }
      }

      return {
        storagePath,
        storageUrl: `https://storage.googleapis.com/${bucket.name}/${storagePath}`,
      };
    } catch (error) {
      this.logger.error(
        `Error al persistir PDF de factura ${invoiceId} en Storage: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private normalizeBillingFrequency(
    value: any,
  ): BillingFrequency {
    const allowed = new Set(['monthly', 'quarterly', 'biannual', 'annual']);
    const normalized = String(value || 'monthly')
      .toLowerCase()
      .trim();
    return allowed.has(normalized)
      ? (normalized as BillingFrequency)
      : 'monthly';
  }

  private normalizeCurrency(value: any): string {
    const normalized = String(value || 'MXN')
      .trim()
      .toUpperCase();
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

  private roundAmount(value: number): number {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  private deriveBaseAmountFromTotalIncludingVat(totalAmount: number): number {
    const vatFactor = 1 + this.mxVatRatePercent / 100;
    return this.roundAmount(totalAmount / vatFactor);
  }

  private isNearlySameAmount(a: number, b: number): boolean {
    return Math.abs(a - b) <= 0.01;
  }

  private resolveBillableBaseAmount(clientData: Record<string, any>): number {
    const pricingWithoutTax = this.parsePricingAmount(
      clientData?.pricingWithoutTax,
    );
    const pricing = this.parsePricingAmount(clientData?.pricing);
    if (pricingWithoutTax > 0) {
      // Compatibilidad con datos previos donde pricingWithoutTax se guardó igual que pricing.
      if (pricing > 0 && this.isNearlySameAmount(pricingWithoutTax, pricing)) {
        return this.deriveBaseAmountFromTotalIncludingVat(pricing);
      }
      return pricingWithoutTax;
    }
    if (pricing > 0) {
      return this.deriveBaseAmountFromTotalIncludingVat(pricing);
    }
    return 0;
  }

  private resolveInvoiceTotals(params: {
    clientData: Record<string, any>;
    billableBaseAmount: number;
  }): {
    subtotalAmount: number;
    taxAmount: number;
    totalAmount: number;
    taxRatePercent: number;
    applyMexicanVat: boolean;
  } {
    const { clientData, billableBaseAmount } = params;
    const pricingWithoutTax = this.parsePricingAmount(
      clientData?.pricingWithoutTax,
    );
    const pricing = this.parsePricingAmount(clientData?.pricing);
    const shouldUseExplicitBase =
      pricingWithoutTax > 0 &&
      !(pricing > 0 && this.isNearlySameAmount(pricingWithoutTax, pricing));

    if (shouldUseExplicitBase) {
      const subtotalAmount = this.roundAmount(billableBaseAmount);
      const taxRatePercent = this.mxVatRatePercent;
      const taxAmount = this.roundAmount(
        subtotalAmount * (taxRatePercent / 100),
      );
      const totalAmount = this.roundAmount(subtotalAmount + taxAmount);
      return {
        subtotalAmount,
        taxAmount,
        totalAmount,
        taxRatePercent,
        applyMexicanVat: true,
      };
    }

    if (pricing > 0) {
      const subtotalAmount = this.roundAmount(billableBaseAmount);
      const totalAmount = this.roundAmount(pricing);
      const taxRatePercent = this.mxVatRatePercent;
      const taxAmount = this.roundAmount(
        Math.max(totalAmount - subtotalAmount, 0),
      );
      return {
        subtotalAmount,
        taxAmount,
        totalAmount,
        taxRatePercent,
        applyMexicanVat: true,
      };
    }

    const subtotalAmount = this.roundAmount(billableBaseAmount);
    return {
      subtotalAmount,
      taxAmount: 0,
      totalAmount: subtotalAmount,
      taxRatePercent: 0,
      applyMexicanVat: false,
    };
  }

  private normalizeRfc(value: any): string {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  private normalizePostalCode(value: any): string {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  private buildFiscalAddressLine1(clientData: Record<string, any>): string {
    const baseAddress = String(
      clientData.fullFiscalAddress || clientData.address || '',
    ).trim();
    const postalCode = this.normalizePostalCode(clientData?.CP);

    if (!postalCode) {
      return baseAddress;
    }

    if (!baseAddress) {
      return `CP ${postalCode}`;
    }

    const escapedPostalCode = postalCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alreadyContainsPostalCode =
      new RegExp(`\\b${escapedPostalCode}\\b`, 'i').test(baseAddress) ||
      /C\.?\s*P\.?\s*[:\-]?\s*[A-Z0-9-]+/i.test(baseAddress);

    if (alreadyContainsPostalCode) {
      return baseAddress;
    }

    return `${baseAddress}, CP ${postalCode}`;
  }

  private async ensureStripeCustomerTaxId(
    customerId: string,
    clientData: Record<string, any>,
  ): Promise<void> {
    const rfc = this.normalizeRfc(clientData?.RFC);
    if (!rfc) {
      return;
    }

    try {
      const taxIds = await this.stripe.customers.listTaxIds(customerId, {
        limit: 100,
      });
      const sameRfcExists = taxIds.data.some(
        (taxId) =>
          taxId.type === 'mx_rfc' &&
          this.normalizeRfc((taxId as any).value || '') === rfc,
      );
      if (sameRfcExists) {
        return;
      }

      const previousMxRfc = taxIds.data.find(
        (taxId) => taxId.type === 'mx_rfc',
      );
      if (previousMxRfc) {
        await this.stripe.customers.deleteTaxId(customerId, previousMxRfc.id);
      }

      await this.stripe.customers.createTaxId(customerId, {
        type: 'mx_rfc',
        value: rfc,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo sincronizar RFC en Stripe para customerId=${customerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveMexicanVatTaxRateId(): Promise<string | null> {
    if (this.mxVatTaxRateIdCache) {
      return this.mxVatTaxRateIdCache;
    }

    const envTaxRateId = String(
      process.env.STRIPE_MX_VAT_TAX_RATE_ID || '',
    ).trim();
    if (envTaxRateId) {
      this.mxVatTaxRateIdCache = envTaxRateId;
      return envTaxRateId;
    }

    try {
      const taxRates = await this.stripe.taxRates.list({
        active: true,
        limit: 100,
      });
      const existing = taxRates.data.find(
        (taxRate) =>
          !taxRate.inclusive &&
          Number(taxRate.percentage) === this.mxVatRatePercent &&
          (String(taxRate.country || '').toUpperCase() === 'MX' ||
            String(taxRate.jurisdiction || '')
              .toUpperCase()
              .includes('MEX')),
      );
      if (existing) {
        this.mxVatTaxRateIdCache = existing.id;
        return existing.id;
      }

      const created = await this.stripe.taxRates.create(
        {
          display_name: 'IVA',
          description: 'IVA 16% México',
          jurisdiction: 'Mexico',
          country: 'MX',
          percentage: this.mxVatRatePercent,
          inclusive: false,
        },
        {
          idempotencyKey: `mx-vat-${this.mxVatRatePercent}-exclusive`,
        },
      );
      this.mxVatTaxRateIdCache = created.id;
      return created.id;
    } catch (error) {
      this.logger.error(
        `No se pudo resolver/crear taxRate IVA ${this.mxVatRatePercent}%: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private resolveDueDays(): number {
    const envValue = Number(process.env.BILLING_INVOICE_DUE_DAYS || '');
    if (Number.isFinite(envValue) && envValue > 0) {
      return Math.floor(envValue);
    }
    return this.billingDueDays;
  }

  private parseBillingIntervalOverrideDays(rawValue: any): number | null {
    const raw = String(rawValue || '').trim();
    if (!raw) {
      return null;
    }

    const direct = Number(raw);
    if (Number.isFinite(direct) && direct >= 1) {
      return Math.floor(direct);
    }

    const numericFragment = raw.match(/\d+/)?.[0];
    if (numericFragment) {
      const parsed = Number(numericFragment);
      if (Number.isFinite(parsed) && parsed >= 1) {
        return Math.floor(parsed);
      }
    }

    return null;
  }

  private resolveBillingIntervalOverrideDays(): number | null {
    return this.billingIntervalOverrideDays;
  }

  private resolveAnchorDay(
    clientData: Record<string, any>,
    fallback: Date,
  ): number {
    const fromClient = Number(clientData?.billingAnchorDay);
    if (Number.isFinite(fromClient) && fromClient >= 1 && fromClient <= 31) {
      return Math.floor(fromClient);
    }
    return fallback.getDate();
  }

  private resolveDefaultCondominiumId(
    clientData: Record<string, any>,
  ): string | null {
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

  private resolveNextBillingDate(
    clientData: Record<string, any>,
    fallback: Date,
  ): Date {
    const nextBillingDate = clientData?.nextBillingDate;
    if (
      nextBillingDate?.toDate &&
      typeof nextBillingDate.toDate === 'function'
    ) {
      return nextBillingDate.toDate();
    }
    return fallback;
  }

  private async resolveClientCondominiumsForBilling(params: {
    clientId: string;
    clientData: Record<string, any>;
  }): Promise<Array<{ condominiumId: string; condominiumData: Record<string, any> }>> {
    const { clientId, clientData } = params;

    try {
      const condominiumsSnapshot = await admin
        .firestore()
        .collection(`clients/${clientId}/condominiums`)
        .get();

      if (!condominiumsSnapshot.empty) {
        return condominiumsSnapshot.docs.map((doc) => ({
          condominiumId: doc.id,
          condominiumData: doc.data() || {},
        }));
      }
    } catch (error) {
      this.logger.warn(
        `No se pudo listar condominios para facturación clientId=${clientId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const fallbackCondominiumId = this.resolveDefaultCondominiumId(clientData);
    if (!fallbackCondominiumId) {
      return [];
    }

    return [
      {
        condominiumId: fallbackCondominiumId,
        condominiumData: {},
      },
    ];
  }

  private resolveCondominiumDisplayName(
    condominiumData: Record<string, any>,
    fallbackCondominiumId: string,
  ): string {
    return (
      String(
        condominiumData?.name ||
          condominiumData?.condominiumName ||
          fallbackCondominiumId ||
          '',
      ).trim() || fallbackCondominiumId
    );
  }

  private parseDateFromUnknown(value: any): Date | null {
    if (!value) return null;

    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value?.toDate === 'function') {
      const parsed = value.toDate();
      return parsed instanceof Date && !Number.isNaN(parsed.getTime())
        ? parsed
        : null;
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      Number.isFinite((value as any)._seconds)
    ) {
      const fromSeconds = new Date(Number((value as any)._seconds) * 1000);
      return Number.isNaN(fromSeconds.getTime()) ? null : fromSeconds;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private isMaintenanceAppEnabled(condominiumData: Record<string, any>): boolean {
    return condominiumData?.hasMaintenanceApp === true;
  }

  private shouldBillMaintenanceAppForPeriod(
    condominiumData: Record<string, any>,
    periodDate: Date,
  ): boolean {
    if (!this.isMaintenanceAppEnabled(condominiumData)) {
      return false;
    }

    const contractedAt = this.parseDateFromUnknown(
      condominiumData?.maintenanceAppContractedAt,
    );
    if (!contractedAt) {
      return true;
    }

    return contractedAt.getTime() <= periodDate.getTime();
  }

  private resolveClientSchedulerBillingFrequency(
    condominiums: Array<{
      condominiumBillingConfig: CondominiumBillingConfig;
    }>,
  ): BillingFrequency {
    if (condominiums.length === 0) {
      return 'monthly';
    }

    const hasMaintenanceApp = condominiums.some((condominium) =>
      this.isMaintenanceAppEnabled(
        condominium.condominiumBillingConfig.condominiumData,
      ),
    );
    if (hasMaintenanceApp) {
      return 'monthly';
    }

    const intervalMonths = condominiums.map((condominium) =>
      this.getBillingIntervalMonths(
        condominium.condominiumBillingConfig.billingFrequency,
      ),
    );
    const minInterval = Math.min(...intervalMonths);

    if (minInterval <= 1) return 'monthly';
    if (minInterval <= 3) return 'quarterly';
    if (minInterval <= 6) return 'biannual';
    return 'annual';
  }

  private buildBillingDedupeKey(params: {
    clientId: string;
    condominiumId: string;
    invoiceType: AutomatedInvoiceType;
    periodKey: string;
  }): string {
    const { clientId, condominiumId, invoiceType, periodKey } = params;
    return `client:${clientId}:condominium:${condominiumId}:type:${invoiceType}:period:${periodKey}`;
  }

  private async resolveCondominiumBillingConfig(params: {
    clientId: string;
    condominiumId: string;
    clientData: Record<string, any>;
    condominiumData?: Record<string, any>;
  }): Promise<CondominiumBillingConfig> {
    const { clientId, condominiumId, clientData } = params;
    let condominiumData: Record<string, any> = params.condominiumData || {};

    if (Object.keys(condominiumData).length === 0) {
      try {
        const condominiumDoc = await admin
          .firestore()
          .collection(`clients/${clientId}/condominiums`)
          .doc(condominiumId)
          .get();
        if (condominiumDoc.exists) {
          condominiumData = condominiumDoc.data() || {};
        } else {
          this.logger.warn(
            `No se encontró condominio para configuración de billing clientId=${clientId} condominiumId=${condominiumId}. Se usa fallback a client.`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `No se pudo leer configuración de billing del condominio clientId=${clientId} condominiumId=${condominiumId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const sourceData =
      Object.keys(condominiumData).length > 0 ? condominiumData : clientData;
    const amount = this.resolveBillableBaseAmount(sourceData);
    const currency = this.normalizeCurrency(
      sourceData?.currency ||
        clientData?.currency ||
        this.defaultBillingCurrency,
    );
    const plan = String(sourceData?.plan || clientData?.plan || '').trim();
    const billingFrequency = this.normalizeBillingFrequency(
      sourceData?.billingFrequency || clientData?.billingFrequency,
    );
    const condominiumLimitRaw = Number(
      sourceData?.condominiumLimit ?? clientData?.condominiumLimit,
    );
    const condominiumLimit = Number.isFinite(condominiumLimitRaw)
      ? condominiumLimitRaw
      : null;

    return {
      amount,
      currency,
      plan,
      billingFrequency,
      condominiumLimit,
      sourceData,
      condominiumData,
    };
  }

  private getBillingIntervalMonths(
    billingFrequency: BillingFrequency,
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
    billingFrequency: BillingFrequency,
    anchorDay: number,
  ): Date {
    const intervalDaysOverride = this.resolveBillingIntervalOverrideDays();
    if (intervalDaysOverride) {
      const result = new Date(baseDate);
      result.setUTCDate(result.getUTCDate() + intervalDaysOverride);
      return result;
    }

    const monthsToAdd = this.getBillingIntervalMonths(billingFrequency);
    const year = baseDate.getUTCFullYear();
    const month = baseDate.getUTCMonth() + monthsToAdd;
    const result = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const maxDay = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(anchorDay, maxDay));
    return result;
  }

  private buildPeriodKey(
    date: Date,
    billingFrequency: BillingFrequency,
  ): string {
    const intervalDaysOverride = this.resolveBillingIntervalOverrideDays();
    if (intervalDaysOverride) {
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

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

  private formatInvoiceNumber(
    date: Date,
    clientId: string,
    condominiumId: string,
    invoiceType: AutomatedInvoiceType,
  ): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const clientSuffix = clientId
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-4)
      .toUpperCase();
    const condominiumSuffix = condominiumId
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-4)
      .toUpperCase();
    const sequence = String(date.getUTCDate()).padStart(2, '0');
    const typeCode = invoiceType === 'maintenance_app' ? 'MA' : 'SU';
    return `EA-${year}${month}-${clientSuffix}${condominiumSuffix}${sequence}${typeCode}`;
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
      const existingCustomerId = String(clientData.stripeCustomerId);
      await this.syncStripeCustomerBillingProfile(
        existingCustomerId,
        clientData,
      );
      await this.ensureStripeCustomerTaxId(existingCustomerId, clientData);
      return existingCustomerId;
    }

    try {
      const customer = await this.stripe.customers.create(
        this.buildStripeCustomerPayload(clientData, clientId),
      );

      await this.ensureStripeCustomerTaxId(customer.id, clientData);

      await clientRef.set(
        {
          stripeCustomerId: customer.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return customer.id;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `No se pudo crear customer en Stripe para clientId=${clientId}: ${err.message}`,
      );
      return null;
    }
  }

  private buildStripeCustomerPayload(
    clientData: Record<string, any>,
    clientId?: string,
  ): Stripe.CustomerCreateParams {
    const customerName =
      String(clientData.companyName || '').trim() ||
      [
        String(clientData.responsiblePersonName || '').trim(),
        String(clientData.responsiblePersonPosition || '').trim(),
      ]
        .filter(Boolean)
        .join(' ') ||
      String(clientData.email || '').trim();

    const customerRfc = this.normalizeRfc(clientData?.RFC);
    const customerPostalCode = this.normalizePostalCode(clientData?.CP);
    const addressLine1 = this.buildFiscalAddressLine1(clientData);
    const addressLine2 = customerRfc ? `RFC: ${customerRfc}` : undefined;

    return {
      name: customerName || undefined,
      email: String(clientData.email || '').trim() || undefined,
      phone: String(clientData.phoneNumber || '').trim() || undefined,
      address: {
        line1: addressLine1 || undefined,
        line2: addressLine2,
        postal_code: customerPostalCode || undefined,
        country:
          String(clientData.country || '')
            .trim()
            .toUpperCase() || undefined,
      },
      metadata: {
        clientId: String(clientId || '').trim(),
        RFC: String(clientData.RFC || ''),
        CP: String(clientData.CP || ''),
        country: String(clientData.country || ''),
      },
    };
  }

  private async syncStripeCustomerBillingProfile(
    customerId: string,
    clientData: Record<string, any>,
  ): Promise<void> {
    try {
      const payload = this.buildStripeCustomerPayload(clientData);
      await this.stripe.customers.update(customerId, {
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
        address: payload.address,
        metadata: payload.metadata,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo sincronizar perfil fiscal del customer Stripe ${customerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolveMaintenanceAppMonthlyPriceTotalMxn(): number {
    const envRaw = String(
      process.env.MAINTENANCE_APP_MONTHLY_PRICE_MXN || '',
    ).trim();
    const envPrice = Number(envRaw.replace(',', '.'));
    if (Number.isFinite(envPrice) && envPrice > 0) {
      return this.roundAmount(envPrice);
    }
    return 119;
  }

  private async createAutomatedInvoicesForCondominiumPeriod(params: {
    clientId: string;
    condominiumId: string;
    condominiumName: string;
    condominiumBillingConfig: CondominiumBillingConfig;
    adminUid: string | null;
    adminEmail: string | null;
    issueDate: Date;
    periodDate: Date;
    source: InvoiceSource;
    dueDays: number;
    clientData: Record<string, any>;
  }) {
    const {
      clientId,
      condominiumId,
      condominiumName,
      condominiumBillingConfig,
      adminUid,
      adminEmail,
      issueDate,
      periodDate,
      source,
      dueDays,
      clientData,
    } = params;
    const generatedInvoices: Array<Record<string, any>> = [];

    if (condominiumBillingConfig.amount > 0) {
      const subscriptionResult = await this.createAutomatedInvoiceForPeriod({
        clientId,
        condominiumId,
        adminUid,
        adminEmail,
        issueDate,
        periodDate,
        billingFrequency: condominiumBillingConfig.billingFrequency,
        amount: condominiumBillingConfig.amount,
        currency: condominiumBillingConfig.currency,
        plan: condominiumBillingConfig.plan,
        source,
        dueDays,
        clientData,
        billingSourceData: condominiumBillingConfig.sourceData,
        invoiceType: 'subscription',
        concept: `Suscripción mensual a EstateAdmin - ${condominiumName}`,
      });
      generatedInvoices.push(subscriptionResult);
    } else {
      this.logger.warn(
        `Se omite facturación de suscripción por pricing inválido para clientId=${clientId} condominiumId=${condominiumId}`,
      );
    }

    if (
      this.shouldBillMaintenanceAppForPeriod(
        condominiumBillingConfig.condominiumData,
        periodDate,
      )
    ) {
      const maintenanceBillingSourceData: Record<string, any> = {
        ...condominiumBillingConfig.sourceData,
        pricing: this.maintenanceAppMonthlyPriceTotalMxn,
        pricingWithoutTax: null,
        pricingWithoutIVA: null,
        pricingWithoutIva: null,
        currency: this.maintenanceAppDefaultCurrency,
      };

      const maintenanceAmount = this.resolveBillableBaseAmount(
        maintenanceBillingSourceData,
      );
      if (maintenanceAmount > 0) {
        const maintenanceResult = await this.createAutomatedInvoiceForPeriod({
          clientId,
          condominiumId,
          adminUid,
          adminEmail,
          issueDate,
          periodDate,
          billingFrequency: 'monthly',
          amount: maintenanceAmount,
          currency: this.maintenanceAppDefaultCurrency,
          plan: condominiumBillingConfig.plan || 'maintenance_app',
          source,
          dueDays,
          clientData,
          billingSourceData: maintenanceBillingSourceData,
          invoiceType: 'maintenance_app',
          concept: `App de Mantenimiento EstateFix - ${condominiumName}`,
        });
        generatedInvoices.push(maintenanceResult);
      }
    }

    return generatedInvoices;
  }

  private async createAutomatedInvoiceForPeriod(params: {
    clientId: string;
    condominiumId: string;
    adminUid: string | null;
    adminEmail: string | null;
    issueDate: Date;
    periodDate: Date;
    billingFrequency: BillingFrequency;
    amount: number;
    currency: string;
    plan: string;
    source: InvoiceSource;
    dueDays: number;
    clientData: Record<string, any>;
    billingSourceData: Record<string, any>;
    invoiceType: AutomatedInvoiceType;
    concept: string;
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
      billingSourceData,
      invoiceType,
      concept,
    } = params;

    const periodKey = this.buildPeriodKey(periodDate, billingFrequency);
    const billingDedupeKey = this.buildBillingDedupeKey({
      clientId,
      condominiumId,
      invoiceType,
      periodKey,
    });
    const legacyBillingDedupeKey =
      invoiceType === 'subscription'
        ? `client:${clientId}:period:${periodKey}`
        : null;
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
    if (legacyBillingDedupeKey) {
      const legacyInvoiceSnap = await invoiceCollectionRef
        .where('billingDedupeKey', '==', legacyBillingDedupeKey)
        .limit(1)
        .get();
      if (!legacyInvoiceSnap.empty) {
        return {
          deduped: true,
          invoiceId: legacyInvoiceSnap.docs[0].id,
          periodKey,
        };
      }
    }

    const dueDate = new Date(issueDate);
    dueDate.setUTCDate(dueDate.getUTCDate() + Math.max(1, dueDays));
    const anchorDay = this.resolveAnchorDay(clientData, issueDate);
    const nextChargeDate = this.addBillingInterval(
      issueDate,
      billingFrequency,
      anchorDay,
    );
    const invoiceNumber = this.formatInvoiceNumber(
      issueDate,
      clientId,
      condominiumId,
      invoiceType,
    );
    const invoiceRef = invoiceCollectionRef.doc();
    const invoiceAmounts = this.resolveInvoiceTotals({
      clientData: billingSourceData,
      billableBaseAmount: amount,
    });
    const stripeLineItemDescription = `${concept} (${periodKey}) - ${invoiceNumber}`.slice(
      0,
      500,
    );
    const condominiumName = this.resolveCondominiumDisplayName(
      billingSourceData,
      condominiumId,
    );

    const invoicePayload: Record<string, any> = {
      invoiceNumber,
      concept,
      invoiceType,
      amount: invoiceAmounts.totalAmount,
      subtotalAmount: invoiceAmounts.subtotalAmount,
      taxAmount: invoiceAmounts.taxAmount,
      taxRatePercent: invoiceAmounts.taxRatePercent,
      taxMode: invoiceAmounts.applyMexicanVat ? 'mx_iva_16_exclusive' : 'none',
      currency,
      periodKey,
      billingFrequency,
      billingDedupeKey,
      source,
      plan: plan || '',
      condominiumLimitSnapshot: Number.isFinite(
        Number(billingSourceData?.condominiumLimit),
      )
        ? Number(billingSourceData?.condominiumLimit)
        : null,
      pricingSnapshot: invoiceAmounts.totalAmount,
      pricingBaseSnapshot: invoiceAmounts.subtotalAmount,
      paymentStatus: 'pending',
      status: 'pending',
      issueDate: admin.firestore.Timestamp.fromDate(issueDate),
      dueDate: admin.firestore.Timestamp.fromDate(dueDate),
      nextBillingDate: admin.firestore.Timestamp.fromDate(nextChargeDate),
      nextChargeDate: admin.firestore.Timestamp.fromDate(nextChargeDate),
      clientId,
      condominiumId,
      condominiumName,
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
        let unitAmount = Math.round(invoiceAmounts.subtotalAmount * 100);
        let mxVatTaxRateId: string | null = null;
        if (invoiceAmounts.applyMexicanVat) {
          mxVatTaxRateId = await this.resolveMexicanVatTaxRateId();
          if (!mxVatTaxRateId) {
            unitAmount = Math.round(invoiceAmounts.totalAmount * 100);
            this.logger.warn(
              `No se pudo resolver taxRate IVA 16% para clientId=${clientId}. Se emite factura sin desglose de impuesto.`,
            );
          }
        }

        const metadata = {
          invoiceId: invoiceRef.id,
          clientId,
          condominiumId,
          invoiceNumber,
          periodKey,
          invoiceType,
        };
        const invoiceItemPayload: Stripe.InvoiceItemCreateParams = {
          customer: stripeCustomerId,
          currency: currency.toLowerCase(),
          amount: unitAmount,
          description: stripeLineItemDescription,
          metadata,
        };
        if (mxVatTaxRateId) {
          invoiceItemPayload.tax_rates = [mxVatTaxRateId];
        }

        await this.stripe.invoiceItems.create(invoiceItemPayload, {
          idempotencyKey: `${billingDedupeKey}:invoice-item`,
        });

        const issuerRfc = this.normalizeRfc(
          process.env.STRIPE_ISSUER_RFC ||
            process.env.COMPANY_RFC ||
            'MOMH941214N28',
        );
        const customFields: Stripe.InvoiceCreateParams.CustomField[] = [];
        if (issuerRfc) {
          customFields.push({
            name: 'RFC Emisor',
            value: issuerRfc,
          });
        }

        const stripeInvoicePayload: Stripe.InvoiceCreateParams = {
          customer: stripeCustomerId,
          collection_method: 'send_invoice',
          days_until_due: Math.max(1, dueDays),
          auto_advance: true,
          pending_invoice_items_behavior: 'include',
          metadata,
        };
        if (customFields.length > 0) {
          stripeInvoicePayload.custom_fields = customFields.slice(0, 4);
        }

        const stripeInvoice = await this.stripe.invoices.create(
          stripeInvoicePayload,
          {
            idempotencyKey: `${billingDedupeKey}:invoice`,
          },
        );

        const finalizedInvoice = await this.stripe.invoices.finalizeInvoice(
          stripeInvoice.id,
        );

        const storedPdf = await this.persistStripeInvoicePdfToStorage({
          clientId,
          condominiumId,
          invoiceId: invoiceRef.id,
          stripeInvoiceId: finalizedInvoice.id,
          invoicePdfUrl: finalizedInvoice.invoice_pdf || null,
        });

        await invoiceRef.set(
          {
            stripeCustomerId,
            stripeInvoiceId: finalizedInvoice.id,
            stripeInvoiceStatus: finalizedInvoice.status || null,
            stripeHostedInvoiceUrl: finalizedInvoice.hosted_invoice_url || null,
            stripeInvoicePdf: finalizedInvoice.invoice_pdf || null,
            stripeTaxRateId: mxVatTaxRateId,
            taxBreakdownApplied: Boolean(
              invoiceAmounts.applyMexicanVat && mxVatTaxRateId,
            ),
            invoicePdfStoragePath: storedPdf?.storagePath || null,
            invoicePdfStorageUrl: storedPdf?.storageUrl || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } catch (stripeError) {
        const sErr =
          stripeError instanceof Error
            ? stripeError
            : new Error(String(stripeError));
        this.logger.error(
          `Error al crear factura Stripe clientId=${clientId} invoiceId=${invoiceRef.id}: ${sErr.message}`,
          sErr.stack,
        );

        await invoiceRef.set(
          {
            stripeSyncError: sErr.message,
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
      amount: invoiceAmounts.totalAmount,
      dueDate,
      userUID: adminUid,
      periodKey,
    });

    return {
      deduped: false,
      invoiceId: invoiceRef.id,
      invoiceType,
      concept,
      periodKey,
      invoiceNumber,
      amount: invoiceAmounts.totalAmount,
      subtotalAmount: invoiceAmounts.subtotalAmount,
      taxAmount: invoiceAmounts.taxAmount,
      taxRatePercent: invoiceAmounts.taxRatePercent,
      nextBillingDate: nextChargeDate.toISOString(),
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
      const lockAcquired = await admin
        .firestore()
        .runTransaction(async (tx) => {
          const lockDoc = await tx.get(lockRef);
          const currentLockUntil = lockDoc.data()?.lockUntil;
          const currentLockMs =
            currentLockUntil?.toMillis &&
            typeof currentLockUntil.toMillis === 'function'
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`No se pudo adquirir lock "${lockId}": ${err.message}`);
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`No se pudo liberar lock "${lockId}": ${err.message}`);
    }
  }
}
