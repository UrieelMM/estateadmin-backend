import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { ParcelReceptionService } from './parcel-receptions.service';

/**
 * Función Cloud que se activa cuando se crea un nuevo registro de recepción de paquetes
 * Envía notificaciones por email al usuario si tiene habilitadas las preferencias
 */
export const onParcelReceptionCreated = onDocumentCreated(
  'clients/{clientId}/condominiums/{condominiumId}/parcelReceptions/{parcelReceptionId}',
  async (event: any) => {
    try {
      const snapshot = event.data;
      if (!snapshot) {
        console.log('No hay datos asociados al evento');
        return null;
      }

      const parcelData = snapshot.data();
      const { clientId, condominiumId } = event.params;

      console.log('Datos del paquete:', parcelData);

      // Instanciar el servicio
      const parcelReceptionService = new ParcelReceptionService();

      // Verificar las preferencias de notificación del usuario
      const { wantsEmailNotifications, userData } =
        await parcelReceptionService.checkUserNotificationPreference(
          clientId,
          condominiumId,
          parcelData.email,
        );

      if (!userData) {
        console.error('No se encontraron datos del usuario');
        return null;
      }

      const notificationResults = [];

      // Enviar notificación por email si el usuario lo permite
      if (wantsEmailNotifications) {
        try {
          const emailResult =
            await parcelReceptionService.sendEmailNotification(
              parcelData.email,
              userData,
              parcelData,
            );
          notificationResults.push({ type: 'email', success: !!emailResult });
          console.log(`Correo enviado exitosamente a ${parcelData.email}`);
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

      console.log('Resultados de notificaciones:', notificationResults);
      return notificationResults;
    } catch (error) {
      console.error('Error al procesar la recepción de paquetes:', error);
      return null;
    }
  },
);
