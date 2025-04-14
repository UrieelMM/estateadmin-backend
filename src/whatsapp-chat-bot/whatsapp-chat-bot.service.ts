import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';
import { PaymentConfirmationDto } from 'src/dtos/whatsapp/payment-confirmation.dto';
import { WhatsappMessageDto } from 'src/dtos/whatsapp/whatsapp-message.dto';
import { normalizeMexNumber } from './formatNumber';

// Asegúrate de inicializar Firebase Admin en tu módulo principal (e.g., app.module.ts)
// import * as admin from 'firebase-admin';
// admin.initializeApp({ ... }); // Configuración de Firebase

/**
 * Estados del flujo conversacional.
 */
enum ConversationState {
  INITIAL = 'INITIAL',
  AWAITING_EMAIL = 'AWAITING_EMAIL',
  AWAITING_DEPARTMENT = 'AWAITING_DEPARTMENT',
  MULTIPLE_CONDOMINIUMS = 'MULTIPLE_CONDOMINIUMS',
  AWAITING_CONDOMINIUM_SELECTION = 'AWAITING_CONDOMINIUM_SELECTION',
  AWAITING_CHARGE_SELECTION = 'AWAITING_CHARGE_SELECTION',
  AWAITING_FILE = 'AWAITING_FILE',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR', // Nuevo estado para manejar errores inesperados
}

/**
 * Estructura para mantener el contexto de conversación de cada usuario (ahora en Firestore).
 */
interface ConversationContext {
  state: ConversationState;
  phoneNumber: string; // Ej. '5215531139560'
  email?: string;
  departmentNumber?: string;
  possibleCondominiums?: Array<{
    clientId: string;
    condominiumId: string;
    // Opcional: podríamos añadir el nombre del condominio si está disponible
    condominiumName?: string;
  }>;
  selectedCondominium?: {
    clientId: string;
    condominiumId: string;
    condominiumName?: string; // Guardar también el nombre si se obtiene
  };
  pendingCharges?: Array<{
    index: number;
    id: string;
    concept: string;
    amount: number; // En centavos
  }>;
  selectedChargeIds?: string[]; // IDs de los cargos seleccionados
  lastInteractionTimestamp?: admin.firestore.Timestamp; // Para seguimiento
  // Añadimos un campo para el userId una vez encontrado
  userId?: string;
}

// Colecciones de Firestore
const STATE_COLLECTION = 'whatsappConversationState';
const AUDIT_COLLECTION_BASE = 'clients'; // Base para la ruta de auditoría

@Injectable()
export class WhatsappChatBotService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappChatBotService.name);
  private firestore: admin.firestore.Firestore;

  onModuleInit() {
    // Asegura que tenemos la instancia de Firestore disponible
    this.firestore = admin.firestore();
    this.logger.log(
      'WhatsappChatBotService inicializado y Firestore conectado.',
    );
  }

  // --- Funciones de Persistencia y Auditoría ---

  /**
   * Obtiene el contexto de conversación desde Firestore.
   * Si no existe, crea uno inicial.
   */
  private async getConversationContext(
    phoneNumber: string,
  ): Promise<ConversationContext> {
    const docRef = this.firestore.collection(STATE_COLLECTION).doc(phoneNumber);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      this.logger.log(`Contexto encontrado para ${phoneNumber}`);
      // Asegurarse de que los Timestamps se manejen correctamente si es necesario
      return docSnap.data() as ConversationContext;
    } else {
      this.logger.log(`Creando contexto inicial para ${phoneNumber}`);
      const initialContext: ConversationContext = {
        state: ConversationState.INITIAL,
        phoneNumber: phoneNumber,
        lastInteractionTimestamp:
          admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp,
      };
      // No lo guardamos aquí todavía, se guardará después del primer manejo
      return initialContext;
    }
  }

  /**
   * Guarda el contexto de conversación actual en Firestore.
   */
  private async saveConversationContext(
    context: ConversationContext,
  ): Promise<void> {
    try {
      const docRef = this.firestore
        .collection(STATE_COLLECTION)
        .doc(context.phoneNumber);
      // Actualiza el timestamp de última interacción
      context.lastInteractionTimestamp =
        admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp;

      // Guardar en la colección original
      await docRef.set(context, { merge: true });
      this.logger.log(`Contexto guardado para ${context.phoneNumber}`);
    } catch (error) {
      this.logger.error(
        `Error al guardar contexto para ${context.phoneNumber}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Registra un evento de mensaje (entrante/saliente) en la colección de auditoría.
   */
  private async logToAudit(
    context: ConversationContext | null, // Puede ser nulo si el contexto aún no se ha establecido completamente
    direction: 'in' | 'out',
    messageContent: string | object, // Puede ser texto o un objeto (ej. webhook)
    details: Record<string, any> = {}, // Datos adicionales
  ): Promise<void> {
    const phoneNumber =
      context?.phoneNumber || details.phoneNumber || 'unknown'; // Intentar obtener el número
    const clientId = context?.selectedCondominium?.clientId || details.clientId;
    const condominiumId =
      context?.selectedCondominium?.condominiumId || details.condominiumId;

    // Solo audita en la ruta específica si tenemos clientId y condominiumId
    if (clientId && condominiumId) {
      const auditPath = `${AUDIT_COLLECTION_BASE}/${clientId}/condominiums/${condominiumId}/whatsAppBotAudit`;
      try {
        const auditLog = {
          phoneNumber: phoneNumber,
          direction: direction,
          message: messageContent,
          state: context?.state || 'UNKNOWN',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          userId: context?.userId, // Incluir userId si está disponible
          ...details, // Añadir cualquier detalle extra
        };
        await this.firestore.collection(auditPath).add(auditLog);
        this.logger.log(
          `Auditoría registrada en ${auditPath} para ${phoneNumber}`,
        );
      } catch (error) {
        this.logger.error(
          `Error al registrar auditoría en ${auditPath} para ${phoneNumber}: ${error.message}`,
          error.stack,
        );
      }
    } else {
      // Opcional: Podrías tener un log general si la ruta específica no es posible aún
      this.logger.warn(
        `No se pudo registrar auditoría detallada para ${phoneNumber} (faltan clientId/condominiumId). Dirección: ${direction}`,
      );
      // Aquí podrías loguear a una colección genérica si lo necesitas:
      // await this.firestore.collection('genericWhatsappAudit').add({ ... });
    }
  }

  // --- Funciones Principales del Chatbot ---

  /**
   * Envía un mensaje de texto a través de la API de WhatsApp y lo registra en auditoría.
   */
  async sendAndLogMessage(
    whatsappMessageDto: WhatsappMessageDto,
    context?: ConversationContext, // Pasar contexto para auditoría
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      this.logger.log(
        `Enviando mensaje a ${whatsappMessageDto.phoneNumber}: "${whatsappMessageDto.message}"`,
      );

      const apiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
      const recipientPhoneNumber = normalizeMexNumber(
        whatsappMessageDto.phoneNumber,
      ); // Normalizar número

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhoneNumber,
        type: 'text',
        text: { body: whatsappMessageDto.message },
      };

      const response = await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });

      // Registrar en auditoría DESPUÉS de enviar exitosamente
      await this.logToAudit(
        context || null, // Usar el contexto si está disponible
        'out',
        whatsappMessageDto.message,
        { phoneNumber: whatsappMessageDto.phoneNumber }, // Asegurar que el número esté en los detalles si no hay contexto
      );

      return {
        success: true,
        message: 'Mensaje enviado correctamente.',
        data: response.data,
      };
    } catch (error) {
      this.logger.error(
        `Error al enviar mensaje a ${whatsappMessageDto.phoneNumber}: ${error.message}`,
        error.stack,
      );
      if (error.response) {
        this.logger.error('WhatsApp API error data:', error.response.data);
      }
      // No registrar en auditoría si falló el envío
      // Considerar si se debe guardar el estado como ERROR aquí
      if (context) {
        context.state = ConversationState.ERROR;
        await this.saveConversationContext(context);
      }
      // No relanzar el error necesariamente, depende de tu manejo global de errores
      return {
        success: false,
        message: `Error al enviar mensaje: ${error.message}`,
      };
    }
  }

  /**
   * Procesa el webhook entrante de WhatsApp y dirige el flujo conversacional.
   */
  async processWebhook(webhookData: any) {
    try {
      this.logger.log('Procesando webhook de WhatsApp...'); // Evitar loguear todo el webhook si contiene datos sensibles

      const entry = webhookData.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messageObj = value?.messages?.[0];

      if (!messageObj) {
        // Podría ser un evento de status, etc. Ignorar si no es un mensaje.
        this.logger.log('Webhook recibido, pero no es un mensaje de usuario.');
        return {
          success: true,
          message: 'No es un mensaje de usuario procesable.',
        };
      }

      const from = messageObj.from; // Ej: '5215531139560'
      this.logger.log(`Mensaje recibido desde: ${from}`);

      // Obtener contexto desde Firestore
      let context = await this.getConversationContext(from);

      // --- Auditoría del Mensaje Entrante ---
      let incomingMessageContent: string | object =
        'Tipo de mensaje no textual';
      if (messageObj.type === 'text') {
        incomingMessageContent = messageObj.text?.body || '';
      } else if (messageObj.type === 'image') {
        incomingMessageContent = {
          type: 'image',
          id: messageObj.image?.id,
          mime_type: messageObj.image?.mime_type,
        };
      } else if (messageObj.type === 'document') {
        incomingMessageContent = {
          type: 'document',
          id: messageObj.document?.id,
          mime_type: messageObj.document?.mime_type,
        };
      }
      // Registrar auditoría del mensaje entrante (intentar usar el contexto actual si existe)
      await this.logToAudit(context, 'in', incomingMessageContent);
      // --- Fin Auditoría ---

      // Manejar tipos de mensaje
      if (messageObj.type === 'text') {
        const textBody = messageObj.text?.body || '';
        const normalizedText = this.cleanInput(textBody);
        await this.handleConversation(context, normalizedText);
      } else if (messageObj.type === 'image') {
        this.logger.log(`Recibimos un archivo tipo imagen 📷 de ${from}`);
        const mediaId = messageObj.image.id;
        const mimeType = messageObj.image.mime_type || 'image/jpeg'; // Default a jpeg si no viene

        if (
          context.state === ConversationState.AWAITING_FILE &&
          context.selectedCondominium
        ) {
          const { clientId, condominiumId } = context.selectedCondominium;
          try {
            const fileUrl = await this.downloadAndUploadMedia(
              mediaId,
              mimeType,
              clientId,
              condominiumId,
            );
            await this.registerPayment(context, fileUrl); // userId se añade dentro si es necesario
            context.state = ConversationState.COMPLETED;
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '✅ ¡Excelente! Hemos recibido tu imagen y registrado tu comprobante con éxito. ¡Muchas gracias! 🙌',
              },
              context,
            );
          } catch (uploadError) {
            this.logger.error(
              `Error al procesar imagen de ${from}: ${uploadError.message}`,
              uploadError.stack,
            );
            context.state = ConversationState.ERROR; // Marcar estado como error
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '😥 ¡Ups! Hubo un problema al procesar tu imagen. Por favor, intenta enviarla de nuevo en unos momentos. Si el problema persiste, contacta a soporte.',
              },
              context,
            );
          }
        } else {
          await this.sendAndLogMessage(
            {
              phoneNumber: from,
              message:
                '🤔 Gracias por la imagen, pero no la esperaba ahora. Si necesitas registrar un pago, por favor escribe "Hola" para iniciar el proceso.',
            },
            context,
          ); // Pasar contexto para auditoría
        }
      } else if (messageObj.type === 'document') {
        this.logger.log(`Recibimos un archivo tipo documento 📄 de ${from}`);
        const mediaId = messageObj.document.id;
        const mimeType = messageObj.document.mime_type || 'application/pdf'; // Default a pdf

        if (
          context.state === ConversationState.AWAITING_FILE &&
          context.selectedCondominium
        ) {
          const { clientId, condominiumId } = context.selectedCondominium;
          try {
            const fileUrl = await this.downloadAndUploadMedia(
              mediaId,
              mimeType,
              clientId,
              condominiumId,
            );
            await this.registerPayment(context, fileUrl);
            context.state = ConversationState.COMPLETED;
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '✅ ¡Perfecto! Recibimos tu documento y hemos registrado tu comprobante exitosamente. ¡Gracias! 🥳',
              },
              context,
            );
          } catch (uploadError) {
            this.logger.error(
              `Error al procesar documento de ${from}: ${uploadError.message}`,
              uploadError.stack,
            );
            context.state = ConversationState.ERROR;
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '😥 ¡Vaya! Algo salió mal al procesar tu documento. ¿Podrías intentar enviarlo de nuevo? Si el error continúa, por favor avísanos.',
              },
              context,
            );
          }
        } else {
          await this.sendAndLogMessage(
            {
              phoneNumber: from,
              message:
                '📄 Gracias por el documento, pero no estaba esperando uno en este momento. Si quieres registrar un pago, escribe "Hola" para empezar. 😊',
            },
            context,
          );
        }
      } else {
        // Otros tipos (audio, video, etc.) -> no soportado
        await this.sendAndLogMessage(
          {
            phoneNumber: from,
            message:
              '😬 Lo siento, por ahora solo puedo procesar mensajes de texto, imágenes (como fotos de comprobantes) y documentos PDF. Si deseas ayuda, escribe "Hola".',
          },
          context,
        );
      }

      // Guardar el estado final de la conversación después de procesar
      await this.saveConversationContext(context);

      return { success: true, message: 'Webhook procesado correctamente.' };
    } catch (error) {
      this.logger.error(
        `Error CRÍTICO al procesar webhook: ${error.message}`,
        error.stack,
      );
      // Considera notificar a un sistema de monitoreo aquí
      // Intentar enviar un mensaje de error genérico si es posible
      const from =
        error.context?.phoneNumber ||
        webhookData?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        try {
          await this.sendAndLogMessage({
            phoneNumber: from,
            message:
              "🚨 ¡Oh no! Encontramos un error inesperado procesando tu solicitud. Ya estamos investigando. Por favor, intenta de nuevo más tarde o escribe 'Hola' para reiniciar.",
          });
        } catch (sendError) {
          this.logger.error(`Fallo al enviar mensaje de error a ${from}`);
        }
      }
      // No relanzar el error para evitar que la cola de webhooks se bloquee (depende de tu infraestructura)
      return { success: false, message: `Error interno: ${error.message}` };
    }
  }

  /**
   * Lógica principal de la conversación basada en el estado actual (cuando se recibe texto).
   */
  private async handleConversation(context: ConversationContext, text: string) {
    const { phoneNumber } = context;

    // Reinicio global: si el usuario escribe "hola" o similar en cualquier estado (excepto inicial)
    if (this.isGreeting(text) && context.state !== ConversationState.INITIAL) {
      this.logger.log(
        `Usuario ${phoneNumber} solicitó reiniciar conversación.`,
      );
      // Reiniciar contexto
      context.state = ConversationState.INITIAL;
      context.email = undefined;
      context.departmentNumber = undefined;
      context.possibleCondominiums = undefined;
      context.selectedCondominium = undefined;
      context.pendingCharges = undefined;
      context.selectedChargeIds = undefined;
      context.userId = undefined; // Limpiar userId también
      // No es necesario llamar a saveConversationContext aquí, se llamará al final de processWebhook
    }

    switch (context.state) {
      case ConversationState.INITIAL:
        if (this.isGreeting(text)) {
          context.state = ConversationState.AWAITING_EMAIL;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '👋 ¡Hola! Qué gusto saludarte. Estoy aquí para ayudarte a registrar tu comprobante de pago. Para empezar, ¿podrías por favor indicarme tu correo electrónico registrado en la plataforma?',
            },
            context,
          );
        } else {
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '🤖 Mmm, no estoy seguro de cómo ayudarte con eso. Si quieres registrar un comprobante de pago, simplemente escribe "Hola" o "Iniciar". ¡Estoy listo para ayudarte! 😊',
            },
            context,
          );
        }
        break;

      case ConversationState.AWAITING_EMAIL:
        // Validación básica de email
        if (!this.isValidEmail(text)) {
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '📧 Parece que el correo electrónico no tiene un formato válido. ¿Podrías verificarlo e ingresarlo de nuevo, por favor? Asegúrate de que incluya un "@" y un dominio (ej. ".com").',
            },
            context,
          );
          // No cambiamos de estado, esperamos de nuevo el email
          return; // Salir del switch para esta iteración
        }
        context.email = this.cleanInputKeepArroba(text); // Guardar email limpio
        context.state = ConversationState.AWAITING_DEPARTMENT;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '👍 ¡Correo recibido! Ahora, por favor, indícame tu número de departamento o casa (tal como está registrado en la plataforma).',
          },
          context,
        );
        break;

      case ConversationState.AWAITING_DEPARTMENT:
        // Podríamos añadir validación si los números de depto tienen un formato específico
        context.departmentNumber = text; // Guardar número de depto (ya limpio por cleanInput)

        try {
          const possibleCondos = await this.findUserCondominiums(
            context.phoneNumber, // Usar el número original con prefijo
            context.email,
            context.departmentNumber,
          );

          if (!possibleCondos || possibleCondos.length === 0) {
            // IMPORTANTE: No reiniciar el estado aquí directamente. Permitir al usuario corregir.
            // context.state = ConversationState.INITIAL; // <- No hacer esto aquí
            await this.sendAndLogMessage(
              {
                phoneNumber,
                message:
                  '⚠️ No logré encontrar condominios asociados con la información que proporcionaste (correo y número de departamento/casa). Por favor, verifica que los datos sean correctos e inténtalo de nuevo. Si prefieres, escribe "Hola" para empezar desde cero.',
              },
              context,
            );
            // Mantener el estado AWAITING_DEPARTMENT para que pueda reintentar
            // O podríamos volver a AWAITING_EMAIL si queremos que corrija ambos. Decidimos mantener AWAITING_DEPARTMENT.
            context.state = ConversationState.AWAITING_EMAIL; // Volver a pedir email, quizás se equivocó ahí.
            await this.sendAndLogMessage(
              {
                phoneNumber,
                message:
                  'Vamos a intentarlo de nuevo. ¿Podrías darme tu correo electrónico registrado, por favor?',
              },
              context,
            );
            return; // Salir para esperar nueva entrada
          }

          // Guardar userId si lo encontramos (asumimos que es el mismo para todos los condominios si hay varios)
          context.userId = possibleCondos[0].userId; // Guardamos el userId encontrado

          if (possibleCondos.length === 1) {
            context.selectedCondominium = possibleCondos[0];
            context.state = ConversationState.AWAITING_CHARGE_SELECTION;
            await this.sendAndLogMessage(
              {
                phoneNumber,
                message: `✅ ¡Encontrado! Estás registrado en el condominio: ${possibleCondos[0].condominiumName || possibleCondos[0].condominiumId}. Ahora buscaré tus cargos pendientes...`,
              },
              context,
            );
            await this.showPendingCharges(context); // Muestra cargos
          } else {
            context.possibleCondominiums = possibleCondos;
            context.state = ConversationState.AWAITING_CONDOMINIUM_SELECTION;

            let msg =
              '🔎 ¡Perfecto! Veo que estás registrado en más de un condominio. Por favor, selecciona a cuál corresponde el pago que quieres registrar:\n\n';
            possibleCondos.forEach((condo, index) => {
              // Usar nombre si está disponible, si no, el ID
              const name = condo.condominiumName
                ? `"${condo.condominiumName}"`
                : `(ID: ${condo.condominiumId})`;
              msg += `${index + 1}. Condominio ${name}\n`;
            });
            msg +=
              '\nSimplemente escribe el número de la opción que deseas. 🙏';

            await this.sendAndLogMessage(
              { phoneNumber, message: msg },
              context,
            );
          }
        } catch (error) {
          this.logger.error(
            `Error buscando condominios para ${phoneNumber}: ${error.message}`,
            error.stack,
          );
          context.state = ConversationState.ERROR;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '😥 Hubo un problema buscando tu información en nuestros registros. Por favor, intenta de nuevo más tarde escribiendo "Hola".',
            },
            context,
          );
        }
        break;

      case ConversationState.AWAITING_CONDOMINIUM_SELECTION: {
        const index = parseInt(text, 10);
        if (
          isNaN(index) ||
          !context.possibleCondominiums ||
          index < 1 ||
          index > context.possibleCondominiums.length
        ) {
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '🚫 Opción inválida. Por favor, escribe solo el número correspondiente a uno de los condominios de la lista (por ejemplo: 1).',
            },
            context,
          );
          // Mantenemos el estado para que reintente
          return;
        }
        // Guardamos el condominio seleccionado (asegurándonos de que userId ya esté en el contexto)
        const selected = context.possibleCondominiums[index - 1];
        context.selectedCondominium = {
          clientId: selected.clientId,
          condominiumId: selected.condominiumId,
          condominiumName: selected.condominiumName, // Guardar nombre también
        };
        context.state = ConversationState.AWAITING_CHARGE_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✔️ Seleccionado: ${selected.condominiumName || selected.condominiumId}. Ahora, déjame buscar tus cargos pendientes en este condominio...`,
          },
          context,
        );
        await this.showPendingCharges(context);
        break;
      }

      case ConversationState.AWAITING_CHARGE_SELECTION: {
        if (!context.pendingCharges || context.pendingCharges.length === 0) {
          // Esto no debería pasar si showPendingCharges funcionó, pero es una salvaguarda
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                'Parece que no tenías cargos pendientes o ya los seleccionaste. Si quieres adjuntar tu comprobante, envíalo ahora. Si no, escribe "Hola" para empezar de nuevo.',
            },
            context,
          );
          // Podríamos ir a AWAITING_FILE si es el flujo esperado, o reiniciar.
          // Por seguridad, reiniciamos si llega aquí inesperadamente.
          context.state = ConversationState.INITIAL;
          return;
        }

        const selectedIndexes = text
          .split(',')
          .map((s) => parseInt(s.trim(), 10));
        const validIndexes = selectedIndexes.filter((idx) => !isNaN(idx));

        if (validIndexes.length === 0 || selectedIndexes.some(isNaN)) {
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '🤔 Formato incorrecto. Por favor, ingresa solo los números de los cargos que quieres pagar, separados por comas si son varios (ej: "1" o "1, 3"). Inténtalo de nuevo.',
            },
            context,
          );
          return; // Mantener estado y esperar de nuevo
        }

        const selectedIds: string[] = [];
        const invalidSelections: number[] = [];
        validIndexes.forEach((idxNum) => {
          const foundCharge = context.pendingCharges?.find(
            (c) => c.index === idxNum,
          );
          if (foundCharge) {
            selectedIds.push(foundCharge.id);
          } else {
            invalidSelections.push(idxNum);
          }
        });

        if (invalidSelections.length > 0) {
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: `⚠️ Los números ${invalidSelections.join(', ')} no corresponden a ningún cargo de la lista. Por favor, revisa los números e inténtalo de nuevo.`,
            },
            context,
          );
          return; // Mantener estado y esperar
        }

        if (selectedIds.length === 0) {
          // Esto podría pasar si solo ingresan números inválidos
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '❌ No seleccionaste ningún cargo válido de la lista. Por favor, elige al menos un número de la lista de cargos pendientes.',
            },
            context,
          );
          return; // Mantener estado y esperar
        }

        context.selectedChargeIds = selectedIds;
        context.state = ConversationState.AWAITING_FILE;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '📝 ¡Excelente! Ya seleccionaste los cargos. Ahora, por favor, adjunta tu comprobante de pago. Puede ser una imagen (foto o captura de pantalla en formato JPG/PNG) o un archivo PDF. ¡Solo tienes que enviarlo directamente aquí!',
          },
          context,
        );
        break;
      }

      case ConversationState.AWAITING_FILE:
        // Si el usuario envía texto en lugar de un archivo
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '⏳ Estoy esperando tu archivo (imagen JPG/PNG o PDF). Por favor, adjúntalo directamente en esta conversación para que pueda registrar tu pago. O si prefieres, escribe "Hola" para reiniciar.',
          },
          context,
        );
        // No cambiamos de estado, seguimos esperando el archivo
        break;

      case ConversationState.COMPLETED:
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🎉 ¡Ya completaste el registro de tu comprobante anteriormente! Si necesitas registrar otro pago o realizar una consulta diferente, simplemente escribe "Hola" para comenzar de nuevo. ¡Estoy para servirte!',
          },
          context,
        );
        break;

      case ConversationState.ERROR:
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '😥 Parece que hubo un error en nuestro sistema durante el proceso anterior. ¿Podrías por favor escribir "Hola" para intentarlo de nuevo? Disculpa las molestias.',
          },
          context,
        );
        // Forzar reinicio del estado para el siguiente intento
        context.state = ConversationState.INITIAL;
        context.email = undefined;
        context.departmentNumber = undefined;
        // ... limpiar otros campos ...
        context.userId = undefined;
        break;

      default:
        this.logger.warn(
          `Estado desconocido ${context.state} para ${phoneNumber}`,
        );
        context.state = ConversationState.INITIAL; // Reiniciar si el estado es inválido
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🤔 Algo inesperado ocurrió. Vamos a empezar de nuevo. Escribe "Hola" para iniciar.',
          },
          context,
        );
        break;
    }
    // El guardado final se hace en processWebhook después de llamar a handleConversation
  }

  // --- Funciones Auxiliares (Firestore, Media, Limpieza) ---

  /**
   * Descarga el archivo desde la API de WhatsApp y lo sube a Firebase Storage.
   */
  private async downloadAndUploadMedia(
    mediaId: string,
    mimeType: string,
    clientId: string,
    condominiumId: string,
  ): Promise<string> {
    this.logger.log(`Iniciando descarga/subida para mediaId: ${mediaId}`);
    try {
      // 1) Obtener la URL de descarga temporal de WhatsApp
      const mediaApiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${mediaId}`;
      const mediaResponse = await axios.get(mediaApiUrl, {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });
      const mediaUrl = mediaResponse.data.url;
      if (!mediaUrl) {
        throw new Error('WhatsApp no devolvió una URL de descarga.');
      }
      this.logger.log(
        `URL temporal de descarga obtenida: ${mediaUrl.substring(0, 50)}...`,
      );

      // 2) Descargar el binario del archivo
      const fileResponse = await axios.get(mediaUrl, {
        responseType: 'arraybuffer', // Importante para obtener el buffer
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });
      this.logger.log(
        `Archivo binario descargado, tamaño: ${fileResponse.data.length} bytes`,
      );

      // 3) Subir a Firebase Storage
      const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
      if (!bucketName) {
        this.logger.error(
          'FIREBASE_STORAGE_BUCKET no está definido en las variables de entorno.',
        );
        throw new Error('Configuración de almacenamiento incompleta.');
      }
      const bucket = admin.storage().bucket(bucketName); // admin.storage() también funciona si lo importas

      const fileExtension = this.getExtensionFromMime(mimeType);
      // Nombre de archivo más descriptivo y único
      const fileName = `voucher_${clientId}_${condominiumId}_${Date.now()}.${fileExtension}`;
      const filePath = `clients/${clientId}/condominiums/${condominiumId}/paymentsVouchers/${fileName}`;

      const file = bucket.file(filePath);

      // Subir el buffer a Storage
      await file.save(fileResponse.data, {
        metadata: { contentType: mimeType },
        // Podrías añadir metadata adicional aquí si es necesario
        // customMetadata: { uploadedBy: 'whatsapp-bot', mediaId: mediaId }
      });
      this.logger.log(`Archivo subido a Firebase Storage en: ${filePath}`);

      // (Opcional pero recomendado) Hacer el archivo público si necesitas acceso web directo
      // Si solo lo accederás vía SDKs de Firebase o con URLs firmadas, este paso no es estrictamente necesario
      // await file.makePublic();

      // Obtener la URL firmada (más segura que pública) o la URL pública
      // Usaremos la URL pública por simplicidad como en el código original
      await file.makePublic(); // Asegurarse de que sea público si se usa la URL de abajo
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;

      // Alternativa: URL Firmada (expira, más segura)
      /*
      const [signedUrl] = await file.getSignedUrl({
          action: 'read',
          expires: '03-09-2491' // Fecha de expiración muy lejana o una más corta
      });
      this.logger.log(`URL firmada generada: ${signedUrl.substring(0,50)}...`);
      return signedUrl;
      */

      this.logger.log(`Archivo subido y hecho público: ${publicUrl}`);
      return publicUrl;
    } catch (err) {
      this.logger.error(
        `Error en downloadAndUploadMedia para ${mediaId}: ${err.message}`,
        err.stack,
      );
      if (axios.isAxiosError(err) && err.response) {
        this.logger.error('Axios error details:', err.response.data);
      }
      // Relanzar el error para que sea manejado por la función que llamó
      throw new Error(`Fallo al procesar archivo de WhatsApp: ${err.message}`);
    }
  }

  /**
   * Retorna la extensión de archivo basada en el mimeType.
   */
  private getExtensionFromMime(mimeType: string): string {
    const type = mimeType.toLowerCase();
    if (type.includes('pdf')) return 'pdf';
    if (type.includes('png')) return 'png';
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    if (type.includes('gif')) return 'gif'; // Añadir otros si son comunes
    if (type.includes('webp')) return 'webp';
    // Fallback genérico si no se reconoce
    this.logger.warn(`MimeType no reconocido: ${mimeType}, usando 'bin'`);
    return 'bin';
  }

  /**
   * Encuentra condominios asociados al usuario en Firestore.
   * Busca en la colección 'users' dentro de cada condominio.
   * Devuelve clientId, condominiumId, userId y opcionalmente condominiumName.
   */
  private async findUserCondominiums(
    originalPhoneWithPrefix: string, // Ej: 52155...
    email?: string,
    departmentNumber?: string,
  ): Promise<Array<{
    clientId: string;
    condominiumId: string;
    userId: string;
    condominiumName?: string;
  }> | null> {
    if (!email || !departmentNumber) return null; // Necesitamos email y depto

    const phoneForDB = this.toTenDigits(originalPhoneWithPrefix); // Convertir a 10 dígitos para la búsqueda
    const cleanedEmail = this.cleanInputKeepArroba(email);
    const cleanedDept = this.cleanInput(departmentNumber); // Limpiar número de depto también

    this.logger.log('Buscando condominios para usuario con datos:', {
      phoneForDB,
      email: cleanedEmail,
      departmentNumber: cleanedDept,
    });

    try {
      const snapshot = await this.firestore
        .collectionGroup('users')
        .where('phone', '==', phoneForDB) // Usar el número de 10 dígitos
        .where('email', '==', cleanedEmail) // Usar el email limpio
        .where('number', '==', cleanedDept) // Usar el número de depto limpio
        .get();

      this.logger.log(
        `Usuarios encontrados con la triple condición: ${snapshot.size}`,
      );

      if (snapshot.empty) {
        return []; // Devolver array vacío si no se encuentra
      }

      const results: Array<{
        clientId: string;
        condominiumId: string;
        userId: string;
        condominiumName?: string;
      }> = [];
      // Usamos un Set para evitar duplicados si la estructura permite al mismo usuario en la misma ruta por error
      const uniquePaths = new Set<string>();

      for (const doc of snapshot.docs) {
        if (uniquePaths.has(doc.ref.path)) continue; // Saltar si ya procesamos esta ruta exacta
        uniquePaths.add(doc.ref.path);

        const pathSegments = doc.ref.path.split('/');
        // Validar estructura de ruta: clients/{clientId}/condominiums/{condominiumId}/users/{userId}
        if (
          pathSegments.length >= 6 &&
          pathSegments[0] === 'clients' &&
          pathSegments[2] === 'condominiums' &&
          pathSegments[4] === 'users'
        ) {
          const clientId = pathSegments[1];
          const condominiumId = pathSegments[3];
          const userId = doc.id; // El ID del documento del usuario

          // Intentar obtener el nombre del condominio (opcional)
          let condominiumName: string | undefined = undefined;
          try {
            const condoDocRef = this.firestore.doc(
              `clients/${clientId}/condominiums/${condominiumId}`,
            );
            const condoSnap = await condoDocRef.get();
            condominiumName = condoSnap.exists
              ? condoSnap.data()?.name
              : undefined;
            this.logger.log(
              `Nombre del condominio ${condominiumId}: ${condominiumName}`,
            );
          } catch (nameError) {
            this.logger.warn(
              `No se pudo obtener el nombre para el condominio ${condominiumId}`,
            );
          }

          results.push({ clientId, condominiumId, userId, condominiumName });
        } else {
          this.logger.warn(
            `Ruta de usuario encontrada no coincide con el patrón esperado: ${doc.ref.path}`,
          );
        }
      }

      this.logger.log(`Condominios válidos encontrados: ${results.length}`);
      return results;
    } catch (error) {
      this.logger.error(
        `Error en Firestore al buscar usuarios: ${error.message}`,
        error.stack,
      );
      // Podríamos relanzar el error o devolver null/vacío para indicar fallo
      throw error; // Relanzar para que sea capturado por el llamador (handleConversation)
    }
  }

  /**
   * Muestra los cargos pendientes del usuario en el condominio seleccionado.
   */
  private async showPendingCharges(
    context: ConversationContext,
  ): Promise<void> {
    const { phoneNumber, selectedCondominium, userId } = context; // Usar userId guardado

    if (!selectedCondominium || !userId) {
      this.logger.error(
        `Faltan datos (condominio o userId) para buscar cargos de ${phoneNumber}`,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 Ups, parece que falta información para buscar tus cargos. Escribe "Hola" para reiniciar, por favor.',
        },
        context,
      );
      context.state = ConversationState.ERROR; // Marcar como error
      return;
    }

    const { clientId, condominiumId } = selectedCondominium;
    const chargesPath = `clients/${clientId}/condominiums/${condominiumId}/users/${userId}/charges`;
    this.logger.log(`Consultando cargos pendientes en: ${chargesPath}`);

    try {
      const chargesRef = this.firestore.collection(chargesPath);
      // Buscar cargos donde 'paid' es false o no existe (por si acaso)
      // Nota: Firestore no soporta consulta OR directamente (paid == false OR paid != true).
      // La forma más común es consultar por 'paid == false'. Asegúrate de que los cargos pagados tengan 'paid: true'.
      const chargesSnap = await chargesRef.where('paid', '==', false).get();

      this.logger.log(
        `Consulta de cargos para ${userId} resultó en ${chargesSnap.size} documentos.`,
      );

      if (chargesSnap.empty) {
        context.pendingCharges = [];
        context.state = ConversationState.AWAITING_FILE; // Si no hay cargos, igual puede subir un comprobante (ej. pago anticipado?) - O REINICIAR? Preguntar lógica de negocio. Vamos a ir a AWAITING_FILE por ahora.
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '✅ ¡Buenas noticias! No encontré cargos pendientes registrados a tu nombre en este momento. Si deseas subir un comprobante para un pago diferente o anticipado, puedes adjuntarlo ahora (imagen o PDF).',
          },
          context,
        );
        return;
      }

      const charges: Array<{
        index: number;
        id: string;
        concept: string;
        amount: number;
      }> = [];
      let idx = 1;
      chargesSnap.forEach((doc) => {
        const data = doc.data();
        // Validar que el cargo tenga concepto y monto
        if (data.concept && typeof data.amount === 'number') {
          charges.push({
            index: idx,
            id: doc.id,
            concept: data.concept,
            amount: data.amount, // Asumimos que está en centavos
          });
          idx++;
        } else {
          this.logger.warn(
            `Cargo ${doc.id} en ${chargesPath} omitido por datos incompletos.`,
          );
        }
      });

      if (charges.length === 0) {
        // Si todos los documentos filtrados tenían datos incompletos
        context.pendingCharges = [];
        context.state = ConversationState.AWAITING_FILE;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '✅ No encontré cargos pendientes con detalles completos. Si necesitas subir un comprobante, puedes adjuntarlo ahora.',
          },
          context,
        );
        return;
      }

      context.pendingCharges = charges; // Guardar cargos en el contexto

      let replyText =
        'Aquí tienes los cargos pendientes que encontré asociados a tu cuenta 🧾:\n\n';
      charges.forEach((c) => {
        const pesos = (c.amount / 100).toLocaleString('es-MX', {
          style: 'currency',
          currency: 'MXN',
        }); // Formato de moneda
        replyText += `${c.index}. ${c.concept} - ${pesos}\n`;
      });
      replyText +=
        '\nPor favor, respóndeme con el número (o números separados por coma) del cargo(s) que corresponden a tu pago. Ejemplo: "1" o si son varios "1, 2".';

      // El estado ya es AWAITING_CHARGE_SELECTION, solo enviamos el mensaje
      await this.sendAndLogMessage(
        { phoneNumber, message: replyText },
        context,
      );
    } catch (error) {
      this.logger.error(
        `Error al buscar cargos en ${chargesPath}: ${error.message}`,
        error.stack,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Tuve problemas para consultar tus cargos pendientes. Por favor, intenta de nuevo más tarde escribiendo "Hola".',
        },
        context,
      );
    }
  }

  /**
   * Registra el comprobante de pago en Firestore bajo la colección paymentsVouchers del condominio.
   */
  private async registerPayment(
    context: ConversationContext,
    fileUrl: string,
  ): Promise<void> {
    const {
      phoneNumber,
      email,
      departmentNumber,
      selectedCondominium,
      selectedChargeIds,
      userId, // Usar userId del contexto
    } = context;

    if (
      !selectedCondominium ||
      !selectedChargeIds ||
      !userId ||
      !email ||
      !departmentNumber
    ) {
      this.logger.error(
        `Faltan datos en el contexto para registrar el pago de ${phoneNumber}`,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber: phoneNumber,
          message:
            '❗ Hubo un problema interno, parece que falta información para registrar tu pago. Por favor, inicia de nuevo con "Hola".',
        },
        context,
      );
      context.state = ConversationState.ERROR;
      return;
    }

    const { clientId, condominiumId } = selectedCondominium;
    const phoneForDB = this.toTenDigits(phoneNumber); // Guardar 10 dígitos por consistencia

    const voucherData = {
      phoneNumber: phoneForDB, // 10 dígitos
      originalPhoneNumber: phoneNumber, // Mantener el original con prefijo si es útil
      email: this.cleanInputKeepArroba(email),
      departmentNumber: this.cleanInput(departmentNumber),
      userId: userId, // ID del usuario encontrado
      paymentProofUrl: fileUrl,
      selectedChargeIds: selectedChargeIds,
      status: 'pending_review', // Estado inicial del comprobante
      uploadedBy: 'whatsapp-bot',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      // Podrías añadir el nombre del condominio si lo tienes en el contexto
      condominiumName: selectedCondominium.condominiumName || null,
    };

    this.logger.log('Registrando comprobante de pago con datos:', {
      clientId,
      condominiumId,
      userId,
      chargeIds: selectedChargeIds.join(', '),
    });

    try {
      const voucherRef = await this.firestore
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/paymentsVouchers`,
        )
        .add(voucherData);
      this.logger.log(
        `Comprobante registrado con ID: ${voucherRef.id} para usuario ${userId}`,
      );

      // IMPORTANTE: Aquí NO se marcan los cargos como pagados automáticamente.
      // Eso debería hacerse en un proceso de revisión/conciliación posterior.
    } catch (error) {
      this.logger.error(
        `Error al guardar comprobante en Firestore para ${userId}: ${error.message}`,
        error.stack,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber: phoneNumber,
          message:
            '❌ Ocurrió un error guardando tu comprobante en nuestra base de datos. Por favor, intenta adjuntar el archivo de nuevo. Si persiste, contacta a soporte.',
        },
        context,
      );
      context.state = ConversationState.ERROR; // Marcar error y esperar reintento o reinicio
    }
  }

  // --- Endpoint Opcional (Confirmación Externa) ---
  // Esta función parece ser un endpoint separado, lo mantenemos pero aseguramos consistencia

  /**
   * Confirma el pago (posiblemente llamado desde otro sistema/endpoint).
   * Usa la información proporcionada para encontrar al usuario y registrar el comprobante.
   */
  async confirmPayment(
    paymentDto: PaymentConfirmationDto,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    this.logger.log(
      `Iniciando confirmación de pago externa para ${paymentDto.phoneNumber}`,
    );
    try {
      const {
        email,
        departmentNumber,
        phoneNumber,
        paymentProofUrl,
        selectedChargeIds,
      } = paymentDto;

      if (
        !email ||
        !departmentNumber ||
        !phoneNumber ||
        !selectedChargeIds ||
        selectedChargeIds.length === 0
      ) {
        throw new Error(
          'Datos incompletos para confirmar el pago (email, depto, phone, chargeIds son requeridos).',
        );
      }

      // Encontrar al usuario usando la misma lógica que en el chat
      const userCondos = await this.findUserCondominiums(
        phoneNumber,
        email,
        departmentNumber,
      );

      if (!userCondos || userCondos.length === 0) {
        throw new Error(
          'Usuario no encontrado con la combinación phone/email/department proporcionada.',
        );
      }

      // Asumimos que la combinación es única o tomamos el primer resultado
      // En un caso real, se necesitaría lógica adicional si hay múltiples resultados
      const userMatch = userCondos[0];
      const { clientId, condominiumId, userId } = userMatch;

      this.logger.log('Usuario encontrado para confirmación externa:', {
        clientId,
        condominiumId,
        userId,
      });

      const phoneForDB = this.toTenDigits(phoneNumber);

      const voucherData: any = {
        phoneNumber: phoneForDB,
        originalPhoneNumber: phoneNumber,
        email: this.cleanInputKeepArroba(email),
        departmentNumber: this.cleanInput(departmentNumber),
        userId: userId,
        paymentProofUrl: paymentProofUrl || null, // URL puede ser opcional si la confirmación es manual
        selectedChargeIds: selectedChargeIds,
        status: 'confirmed_external', // Estado específico para este método
        uploadedBy: 'external_api', // Indicar origen
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        condominiumName: userMatch.condominiumName || null,
      };

      const paymentsVouchersRef = this.firestore.collection(
        `clients/${clientId}/condominiums/${condominiumId}/paymentsVouchers`,
      );
      const voucherDocRef = await paymentsVouchersRef.add(voucherData);
      this.logger.log(
        `Comprobante (externo) almacenado con ID: ${voucherDocRef.id}`,
      );

      // Aquí TAMPOCO se marcan los cargos como pagados automáticamente.

      // Opcional: Enviar un mensaje de WhatsApp al usuario notificando la confirmación
      // await this.sendAndLogMessage({
      //    phoneNumber: phoneNumber,
      //    message: `✅ Hemos confirmado manualmente el registro de tu pago para los cargos: ${selectedChargeIds.join(', ')}. ¡Gracias!`
      // });

      return {
        success: true,
        message:
          'Comprobante de pago confirmado y almacenado correctamente vía externa.',
        data: { voucherId: voucherDocRef.id }, // No devolver toda la data por seguridad
      };
    } catch (error) {
      this.logger.error(
        `Error en confirmPayment externo: ${error.message}`,
        error.stack,
      );
      // No lanzar error necesariamente, devolver una respuesta de fallo
      return {
        success: false,
        message: `Error al confirmar pago externo: ${error.message}`,
      };
    }
  }

  // --- Helpers de formato y validación ---

  /**
   * Convierte un número de teléfono mexicano (ej. '52155...' o '5255...') a 10 dígitos (ej. '55...').
   */
  private toTenDigits(num: string): string {
    let digits = num.replace(/\D/g, ''); // Quitar todo lo no numérico
    // Caso común México: Si empieza con 521 (móvil) y tiene 12 dígitos -> quitar el 1 después de 52
    if (digits.startsWith('521') && digits.length === 12) {
      digits = '52' + digits.substring(3);
    }
    // Si empieza con 52 y tiene 12 dígitos (a veces pasa con fijos?) -> quitar 52
    // O si tiene 10 dígitos (ya está bien)
    // O si tiene más de 10 (tomar últimos 10, asumiendo LADA + número)
    if (digits.startsWith('52') && digits.length === 12) {
      // Podría ser un número fijo con 52 + 10 dígitos, quitar 52
      return digits.substring(2);
    } else if (digits.length === 10) {
      return digits; // Ya tiene 10 dígitos
    } else if (digits.length > 10) {
      // Tomar los últimos 10 dígitos (heurística común)
      return digits.slice(-10);
    } else {
      // Si tiene menos de 10, devolver como está (puede ser un error)
      this.logger.warn(
        `Número ${num} resultó en ${digits}, que tiene menos de 10 dígitos.`,
      );
      return digits;
    }
  }

  /**
   * Limpia la entrada: minúsculas, sin tildes, sin espacios extra al inicio/fin.
   */
  private cleanInput(input: string): string {
    if (!input) return '';
    let text = input.toLowerCase();
    // NFD: Normalization Form Canonical Decomposition -> separa tildes
    // \u0300-\u036f: Rango Unicode para combinar marcas diacríticas (tildes, etc.)
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    text = text.trim();
    return text;
  }

  /**
   * Limpia la entrada pero conserva la arroba '@' y puntos '.' (para emails).
   */
  private cleanInputKeepArroba(input: string): string {
    if (!input) return '';
    let text = input.toLowerCase().trim();
    // Normalizar para quitar tildes, pero sin quitar '@' o '.'
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return text;
  }

  /**
   * Validación básica de formato de correo electrónico.
   */
  private isValidEmail(email: string): boolean {
    if (!email) return false;
    // Regex simple: algo@algo.algo (no perfecto, pero filtra errores comunes)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Verifica si el texto es un saludo o palabra clave para iniciar/reiniciar.
   */
  private isGreeting(text: string): boolean {
    // Usamos el texto ya limpiado (minúsculas, sin tildes)
    const greetings = [
      'hola',
      'ola',
      'alo',
      'iniciar',
      'inicio',
      'empezar',
      'comenzar',
      'buenos dias',
      'buen dia',
      'buenas tardes',
      'buena tarde',
      'buenas noches',
      'buena noche',
      'hey',
      'buenas',
      'k onda', // Ejemplo informal
      'ayuda',
      'soporte',
      'info', // Podrían indicar intención de iniciar
      'pago',
      'pagar',
      'comprobante',
      'recibo', // Relacionado al flujo
    ];
    // Devolver true si el texto *contiene* alguna de las palabras clave
    // O si es exactamente una de ellas (más estricto) - usaremos `includes` por flexibilidad
    return greetings.some((g) => text.includes(g));
  }
}
