import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);

  constructor() {
    // Inicializar Stripe con la clave secreta
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      apiVersion: '2025-03-31.basil',
    });
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
    clientId: string,
    condominiumId: string,
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

      // Registrar el evento antes de procesarlo
      await this.logWebhookEvent(event, clientId, condominiumId);

      // Verificar si ya procesamos este evento (idempotencia a nivel de evento)
      const eventDoc = await admin
        .firestore()
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/stripeWebhookEventsClients`,
        )
        .doc(event.id)
        .get();

      if (eventDoc.exists && eventDoc.data().completed) {
        this.logger.log(`Evento ${event.id} ya fue procesado previamente`);
        return { received: true, alreadyProcessed: true };
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
        default:
          this.logger.log(`Evento no manejado: ${event.type}`);
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
}
