import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { CalendarEventService } from './calendar-events.service';

/**
 * Función Cloud que se activa cuando se crea un nuevo evento de calendario
 * Envía notificaciones por email y WhatsApp al usuario si tiene habilitadas las preferencias
 */
export const onCalendarEventCreated = onDocumentCreated(
  'clients/{clientId}/condominiums/{condominiumId}/calendarEvents/{calendarEventId}',
  async (event: any) => {
    try {
      const snapshot = event.data;
      if (!snapshot) {
        console.log('No hay datos asociados al evento');
        return null;
      }

      const eventData = snapshot.data();
      const { clientId, condominiumId } = event.params;

      // Solo enviar notificaciones si el registro tiene el campo "email"
      if (!eventData.email) {
        console.log(
          "No se encontró el campo 'email' en el registro; no se enviarán notificaciones.",
        );
        return null;
      }

      // Instanciar el servicio
      const calendarEventService = new CalendarEventService();

      // Verificar las preferencias de notificación del usuario
      const { wantsEmailNotifications, wantsWhatsAppNotifications, userData } =
        await calendarEventService.checkUserNotificationPreference(
          clientId,
          condominiumId,
          null,
          eventData.email,
        );

      if (!userData) {
        console.error('No se encontraron datos del usuario');
        return null;
      }

      const notificationResults = [];

      // Enviar notificación por email si el usuario lo permite
      if (wantsEmailNotifications) {
        try {
          const emailResult = await calendarEventService.sendEmailNotification(
            eventData.email,
            userData,
            eventData,
          );
          notificationResults.push({ type: 'email', success: !!emailResult });
        } catch (emailError) {
          console.error('Error al enviar notificación por email:', emailError);
          notificationResults.push({
            type: 'email',
            success: false,
            error: emailError,
          });
        }
      } else {
        console.log(
          `El usuario ${userData.name} ha desactivado las notificaciones por email`,
        );
      }

      // Enviar notificación por WhatsApp si el usuario lo permite
      if (wantsWhatsAppNotifications) {
        try {
          const whatsappResult =
            await calendarEventService.sendWhatsAppNotification(
              userData,
              eventData,
            );
          notificationResults.push({
            type: 'whatsapp',
            success: !!whatsappResult,
          });
        } catch (whatsappError) {
          console.error(
            'Error al enviar notificación por WhatsApp:',
            whatsappError,
          );
          notificationResults.push({
            type: 'whatsapp',
            success: false,
            error: whatsappError,
          });
        }
      } else {
        console.log(
          `El usuario ${userData.name} ha desactivado las notificaciones por WhatsApp`,
        );
      }

      console.log('Resultados de notificaciones:', notificationResults);
      return notificationResults;
    } catch (error) {
      console.error('Error al procesar el evento de calendario:', error);
      return null;
    }
  },
);
